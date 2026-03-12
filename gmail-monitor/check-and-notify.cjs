#!/usr/bin/env node
/**
 * Gmail Notification Check & Notify
 * 
 * Runs the IMAP poller, then checks for NEW actionable notifications
 * (comments, mentions, DMs) that need a reply.
 * 
 * When actionable items found: creates a one-shot OpenClaw cron to wake
 * the main session with the notification details.
 * 
 * Designed to run from system crontab every 1-2 min — zero AI cost when idle.
 * 
 * Usage:
 *   node check-and-notify.cjs           # Normal mode (poll + notify)
 *   node check-and-notify.cjs --dry-run # Show what would be sent, don't notify
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const QUEUE_PATH = path.join(__dirname, 'notifications-queue.jsonl');
const HANDLED_PATH = path.join(__dirname, 'handled-state.json');
const DRY_RUN = process.argv.includes('--dry-run');

// Actions that need AI response (open Chrome, compose reply)
const ACTIONABLE = new Set(['comment', 'mention', 'dm']);

// Actions handled in bulk by heartbeat (don't need individual notification)
const BULK_HANDLED = new Set(['connection_request', 'follow', 'like', 'profile_view', 'other', 'ignore']);

function loadHandled() {
  try { return JSON.parse(fs.readFileSync(HANDLED_PATH, 'utf8')); }
  catch { return { lastProcessedLine: 0, handledUids: [] }; }
}

function saveHandled(state) {
  if (state.handledUids.length > 1000) {
    state.handledUids = state.handledUids.slice(-1000);
  }
  fs.writeFileSync(HANDLED_PATH, JSON.stringify(state, null, 2));
}

function runPoller() {
  try {
    const result = execSync(`node ${path.join(__dirname, 'imap-poller.cjs')}`, {
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: process.env.HOME },
    });
    return result.toString();
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    if (stderr.includes('Invalid credentials') || stderr.includes('AUTHENTICATIONFAILED')) {
      console.error('❌ GMAIL_AUTH_ERROR: Check app password');
      process.exit(1);
    }
    // Other errors (no new mail, network) — continue, check queue anyway
    return '';
  }
}

function wakeMainSession(message) {
  if (DRY_RUN) {
    console.log('DRY RUN — would send to main session:');
    console.log(message);
    return;
  }

  try {
    // Create a one-shot cron that fires immediately to wake the main session
    const escaped = message.replace(/'/g, "'\\''");
    execSync(
      `openclaw cron add --name "gmail-alert" --at "+0s" --session main --delete-after-run --timeout-seconds 300 --system-event '${escaped}'`,
      { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    console.log(`✅ Woke main session with ${message.split('\n').length} line alert`);
  } catch (err) {
    console.error('❌ Failed to wake main session:', err.message);
    // Fallback: write to a file the heartbeat can pick up
    const alertPath = path.join(__dirname, 'pending-alert.txt');
    fs.writeFileSync(alertPath, message);
    console.log('⚠️ Wrote to pending-alert.txt for heartbeat pickup');
  }
}

function main() {
  // Step 1: Run the IMAP poller
  runPoller();

  // Step 2: Read queue for unhandled actionable items
  if (!fs.existsSync(QUEUE_PATH)) {
    process.exit(0);
  }

  const state = loadHandled();
  const lines = fs.readFileSync(QUEUE_PATH, 'utf8').trim().split('\n').filter(Boolean);
  
  const actionable = [];
  
  for (let i = state.lastProcessedLine; i < lines.length; i++) {
    try {
      const notif = JSON.parse(lines[i]);
      
      if (state.handledUids.includes(notif.emailUid)) continue;
      
      if (BULK_HANDLED.has(notif.action)) {
        state.handledUids.push(notif.emailUid);
        continue;
      }
      
      if (ACTIONABLE.has(notif.action)) {
        actionable.push(notif);
        state.handledUids.push(notif.emailUid);
      }
    } catch {}
  }
  
  state.lastProcessedLine = lines.length;
  saveHandled(state);

  // Step 3: If actionable items, wake main session
  if (actionable.length === 0) {
    process.exit(0);
  }

  let message = `📧 Gmail detected ${actionable.length} new notification(s) that need replies:\n\n`;
  
  for (const n of actionable) {
    const platform = n.platform.toUpperCase();
    const who = n.who || 'Unknown';
    const snippet = (n.snippet || '').substring(0, 150).replace(/\n/g, ' ');
    message += `• [${platform}] ${n.action} from ${who}: ${n.subject || ''}\n`;
    if (snippet) message += `  Preview: ${snippet}\n`;
  }
  
  message += `\nOpen Chrome via AppleScript JS, navigate to each notification, compose and post replies, log all engagements. Follow your engagement rules.`;

  wakeMainSession(message);
}

main();
