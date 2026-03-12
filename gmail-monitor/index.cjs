#!/usr/bin/env node
/**
 * Gmail Notification Router for Agent Presence
 * 
 * Polls Gmail for notification emails from X and LinkedIn,
 * classifies them by action type, and triggers appropriate handlers.
 * 
 * Usage:
 *   node index.js              # Run once (for cron)
 *   node index.js --auth       # Run OAuth flow only
 *   node index.js --watch      # Continuous polling mode
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getAuthClient } = require('./auth.cjs');
const { classify, SENDERS } = require('./classifier.cjs');

const STATE_PATH = path.join(__dirname, 'state.json');

// All known notification senders
const NOTIFICATION_SENDERS = [...SENDERS.x, ...SENDERS.linkedin];

/**
 * Load last processed state.
 */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastHistoryId: null, processedIds: [] };
  }
}

/**
 * Save state to disk.
 */
function saveState(state) {
  // Keep only last 500 processed IDs to prevent unbounded growth
  if (state.processedIds.length > 500) {
    state.processedIds = state.processedIds.slice(-500);
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Get email headers from a message.
 */
function getHeaders(message) {
  const headers = {};
  const payload = message.payload || {};
  for (const header of (payload.headers || [])) {
    headers[header.name.toLowerCase()] = header.value;
  }
  return headers;
}

/**
 * Extract plain text body from a message.
 */
function getBody(message) {
  const payload = message.payload || {};
  
  // Simple message
  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  
  // Multipart message — find text/plain
  const parts = payload.parts || [];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf8');
    }
    // Nested multipart
    if (part.parts) {
      for (const subpart of part.parts) {
        if (subpart.mimeType === 'text/plain' && subpart.body && subpart.body.data) {
          return Buffer.from(subpart.body.data, 'base64url').toString('utf8');
        }
      }
    }
  }
  
  return '';
}

/**
 * Fetch new notification emails since last check.
 */
async function fetchNewNotifications(gmail, state) {
  // Build query: from any known notification sender, newer than last check
  const senderQuery = NOTIFICATION_SENDERS.map(s => `from:${s}`).join(' OR ');
  const query = `(${senderQuery}) is:unread`;

  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20,
    });

    const messages = res.data.messages || [];
    const newMessages = [];

    for (const msg of messages) {
      // Skip already processed
      if (state.processedIds.includes(msg.id)) continue;

      // Fetch full message
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = getHeaders(full.data);
      const body = getBody(full.data);

      newMessages.push({
        id: msg.id,
        from: headers.from || '',
        subject: headers.subject || '',
        date: headers.date || '',
        snippet: full.data.snippet || '',
        body: body,
      });

      // Mark as processed
      state.processedIds.push(msg.id);
    }

    return newMessages;
  } catch (err) {
    console.error('Error fetching messages:', err.message);
    return [];
  }
}

/**
 * Handle a classified notification.
 */
function handleNotification(classified, email) {
  const { platform, action, data } = classified;
  const timestamp = new Date().toISOString();

  console.log(`\n📬 [${timestamp}] ${platform.toUpperCase()} — ${action.toUpperCase()}`);
  console.log(`   From: ${email.from}`);
  console.log(`   Subject: ${email.subject}`);
  
  if (data.who) console.log(`   Who: ${data.who}`);
  if (data.snippet) console.log(`   Preview: ${data.snippet.substring(0, 100)}`);

  // Output as structured JSON for the OpenClaw agent to consume
  const notification = {
    timestamp,
    platform,
    action,
    emailId: email.id,
    from: email.from,
    subject: email.subject,
    ...data,
  };

  // Write to notifications queue file
  const queuePath = path.join(__dirname, 'notifications-queue.jsonl');
  fs.appendFileSync(queuePath, JSON.stringify(notification) + '\n');

  return notification;
}

/**
 * Main: poll once and process.
 */
async function main() {
  const args = process.argv.slice(2);

  // Auth-only mode
  if (args.includes('--auth')) {
    console.log('Running OAuth authentication flow...');
    await getAuthClient();
    console.log('✅ Authentication complete!');
    return;
  }

  const auth = await getAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // Test connection
  const profile = await gmail.users.getProfile({ userId: 'me' });
  console.log(`📧 Connected to Gmail: ${profile.data.emailAddress}`);

  const state = loadState();
  const newEmails = await fetchNewNotifications(gmail, state);

  if (newEmails.length === 0) {
    console.log('No new notifications.');
    saveState(state);
    return;
  }

  console.log(`Found ${newEmails.length} new notification(s):`);

  const results = [];
  for (const email of newEmails) {
    const classified = classify(email);
    
    // Skip ignored/unknown
    if (classified.action === 'ignore') {
      console.log(`   ⏭️  Skipped: ${email.subject} (${classified.data.reason})`);
      continue;
    }

    const notification = handleNotification(classified, email);
    results.push(notification);
  }

  saveState(state);

  // Summary
  console.log(`\n✅ Processed ${results.length} notification(s)`);
  
  // Output summary as JSON for cron consumer
  if (results.length > 0) {
    console.log('\n--- NOTIFICATIONS_JSON ---');
    console.log(JSON.stringify(results, null, 2));
    console.log('--- END_NOTIFICATIONS_JSON ---');
  }

  // Watch mode: keep polling
  if (args.includes('--watch')) {
    const intervalMs = parseInt(args[args.indexOf('--interval') + 1]) || 120000; // default 2 min
    console.log(`\n👀 Watch mode: polling every ${intervalMs / 1000}s`);
    setInterval(async () => {
      const state = loadState();
      const newEmails = await fetchNewNotifications(gmail, state);
      for (const email of newEmails) {
        const classified = classify(email);
        if (classified.action !== 'ignore') {
          handleNotification(classified, email);
        }
      }
      saveState(state);
    }, intervalMs);
  }
}

main().catch(console.error);
