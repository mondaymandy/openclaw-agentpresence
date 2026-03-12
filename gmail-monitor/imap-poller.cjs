#!/usr/bin/env node
/**
 * Gmail IMAP Notification Poller
 * 
 * Connects to Gmail via IMAP, fetches new notification emails,
 * classifies them, and writes to the notification queue.
 * 
 * Requires either:
 * - App Password (Gmail > Security > App Passwords) — recommended
 * - Regular password with "Less secure apps" enabled
 * 
 * Usage:
 *   node imap-poller.cjs              # Run once (for cron)
 *   GMAIL_USER=x GMAIL_PASS=y node imap-poller.cjs
 * 
 * Environment:
 *   GMAIL_USER — Gmail address (default: mondaymendy1@gmail.com)
 *   GMAIL_PASS — Gmail password or app password
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const { classify } = require('./classifier.cjs');

// Load .env manually
function loadEnv() {
  try {
    const envPath = path.join(process.env.HOME, '.openclaw', '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {}
}
loadEnv();

const GMAIL_USER = process.env.GMAIL_USER || 'mondaymendy1@gmail.com';
const GMAIL_PASS = process.env.GMAIL_PASS || process.env.GMAIL_APP_PASSWORD || process.env.GMAIL_PASSWORD || '';

const STATE_PATH = path.join(__dirname, 'state.json');
const QUEUE_PATH = path.join(__dirname, 'notifications-queue.jsonl');

// Known notification senders to filter
const NOTIFICATION_SENDERS = [
  'notify@x.com', 'info@x.com', 'noreply@x.com',
  'notifications-noreply@linkedin.com', 'linkedin@e.linkedin.com',
  'messages-noreply@linkedin.com', 'invitations@linkedin.com',
];

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { processedIds: [], lastCheck: null }; }
}

function saveState(state) {
  if (state.processedIds.length > 500) state.processedIds = state.processedIds.slice(-500);
  state.lastCheck = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function connectImap() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: GMAIL_USER,
      password: GMAIL_PASS,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once('ready', () => resolve(imap));
    imap.once('error', (err) => reject(err));
    imap.connect();
  });
}

function openInbox(imap) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function searchEmails(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => {
      if (err) reject(err);
      else resolve(results || []);
    });
  });
}

function fetchEmail(imap, uid) {
  return new Promise((resolve, reject) => {
    const f = imap.fetch([uid], { bodies: '', struct: true });
    let raw = '';

    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      });
    });

    f.once('error', reject);
    f.once('end', async () => {
      try {
        const parsed = await simpleParser(raw);
        resolve({
          uid,
          messageId: parsed.messageId,
          from: parsed.from ? parsed.from.text : '',
          subject: parsed.subject || '',
          date: parsed.date ? parsed.date.toISOString() : '',
          snippet: (parsed.text || '').substring(0, 300),
          body: parsed.text || '',
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function main() {
  if (!GMAIL_PASS) {
    console.error('❌ No Gmail password set. Set GMAIL_PASSWORD in ~/.openclaw/.env');
    process.exit(1);
  }

  console.log(`📧 Connecting to Gmail as ${GMAIL_USER}...`);

  let imap;
  try {
    imap = await connectImap();
  } catch (err) {
    console.error('❌ IMAP connection failed:', err.message);
    if (err.message.includes('Invalid credentials') || err.message.includes('AUTHENTICATIONFAILED')) {
      console.error('💡 You may need an App Password. Go to myaccount.google.com/apppasswords');
    }
    process.exit(1);
  }

  console.log('✅ Connected to Gmail IMAP');

  try {
    await openInbox(imap);
    const state = loadState();

    // Search for unread emails from notification senders
    // IMAP OR search: search for each sender separately
    let allUids = [];
    for (const sender of NOTIFICATION_SENDERS) {
      try {
        const uids = await searchEmails(imap, ['UNSEEN', ['FROM', sender]]);
        allUids.push(...uids);
      } catch {}
    }

    // Deduplicate
    allUids = [...new Set(allUids)];

    if (allUids.length === 0) {
      console.log('No new notifications.');
      saveState(state);
      imap.end();
      return;
    }

    console.log(`Found ${allUids.length} unread notification email(s)`);

    const results = [];
    for (const uid of allUids) {
      // Skip already processed
      if (state.processedIds.includes(uid)) continue;

      try {
        const email = await fetchEmail(imap, uid);
        const classified = classify(email);

        if (classified.action === 'ignore') {
          console.log(`  ⏭️  Skip: ${email.subject}`);
        } else {
          const notification = {
            timestamp: new Date().toISOString(),
            platform: classified.platform,
            action: classified.action,
            emailUid: uid,
            from: email.from,
            subject: email.subject,
            date: email.date,
            ...classified.data,
          };

          console.log(`  📬 ${classified.platform.toUpperCase()} ${classified.action}: ${classified.data.who || 'unknown'} — ${email.subject}`);
          
          // Append to queue
          fs.appendFileSync(QUEUE_PATH, JSON.stringify(notification) + '\n');
          results.push(notification);
        }

        state.processedIds.push(uid);
      } catch (err) {
        console.error(`  ❌ Error processing uid ${uid}:`, err.message);
      }
    }

    saveState(state);

    // Summary
    console.log(`\n✅ Processed ${results.length} notification(s)`);
    if (results.length > 0) {
      console.log('\n--- NOTIFICATIONS_JSON ---');
      console.log(JSON.stringify(results, null, 2));
      console.log('--- END_NOTIFICATIONS_JSON ---');
    }

  } finally {
    imap.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
