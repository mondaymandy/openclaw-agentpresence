/**
 * Gmail Notification Classifier
 * Routes incoming notification emails by type and platform.
 */

const SENDERS = {
  x: ['notify@x.com', 'info@x.com', 'noreply@x.com'],
  linkedin: ['notifications-noreply@linkedin.com', 'linkedin@e.linkedin.com', 'messages-noreply@linkedin.com', 'invitations@linkedin.com'],
};

/**
 * Classify an email notification into an action type.
 * @param {Object} email - Parsed email { from, subject, body, snippet }
 * @returns {Object} { platform, action, data }
 */
function classify(email) {
  const from = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const snippet = (email.snippet || '').toLowerCase();

  // Determine platform
  let platform = 'unknown';
  if (SENDERS.x.some(s => from.includes(s))) platform = 'x';
  else if (SENDERS.linkedin.some(s => from.includes(s))) platform = 'linkedin';
  else return { platform: 'unknown', action: 'ignore', data: { reason: 'unrecognized sender', from } };

  // --- X/Twitter Classification ---
  if (platform === 'x') {
    // Reply/Comment on your post
    if (subject.includes('replied to') || subject.includes('reply to') || subject.includes('responded to')) {
      return { platform, action: 'comment', data: parseXComment(email) };
    }
    // Mention
    if (subject.includes('mentioned you') || subject.includes('tagged you')) {
      return { platform, action: 'mention', data: parseXMention(email) };
    }
    // DM
    if (subject.includes('sent you a direct message') || subject.includes('new message from')) {
      return { platform, action: 'dm', data: parseXDM(email) };
    }
    // New follower
    if (subject.includes('followed you') || subject.includes('new follower')) {
      return { platform, action: 'follow', data: parseXFollow(email) };
    }
    // Like
    if (subject.includes('liked your') || subject.includes('likes your')) {
      return { platform, action: 'like', data: { subject: email.subject, snippet: email.snippet } };
    }
    // Quote tweet
    if (subject.includes('quoted your') || subject.includes('reposted your')) {
      return { platform, action: 'quote', data: parseXComment(email) };
    }
    return { platform, action: 'other', data: { subject: email.subject, snippet: email.snippet } };
  }

  // --- LinkedIn Classification ---
  if (platform === 'linkedin') {
    // Filter out LinkedIn system/marketing emails
    const systemSubjects = [
      'welcome to premium', 'better on the app', 'get started',
      'people viewed your profile', 'your weekly digest', 'jobs you may',
      'congratulate', 'work anniversary', 'birthday', 'trending on linkedin',
      'your daily rundown', 'suggested for you', 'newsletter',
    ];
    if (systemSubjects.some(s => subject.includes(s))) {
      return { platform, action: 'ignore', data: { reason: 'linkedin system email', subject: email.subject } };
    }
    // Comment on your post
    if (subject.includes('commented on') || subject.includes('replied to your comment') || subject.includes('reaction to your')) {
      return { platform, action: 'comment', data: parseLinkedInComment(email) };
    }
    // Connection request
    if (subject.includes('connect with you') || subject.includes('invitation to connect') || subject.includes('wants to connect') || from.includes('invitations@')) {
      return { platform, action: 'connection_request', data: parseLinkedInConnection(email) };
    }
    // DM
    if (subject.includes('sent you a message') || subject.includes('new message') || from.includes('messages-noreply@')) {
      return { platform, action: 'dm', data: parseLinkedInDM(email) };
    }
    // Mention
    if (subject.includes('mentioned you') || subject.includes('tagged you')) {
      return { platform, action: 'mention', data: parseLinkedInMention(email) };
    }
    // Profile view
    if (subject.includes('viewed your profile') || subject.includes('people viewed')) {
      return { platform, action: 'profile_view', data: { subject: email.subject, snippet: email.snippet } };
    }
    // Like/Reaction
    if (subject.includes('likes your') || subject.includes('reacted to your')) {
      return { platform, action: 'like', data: { subject: email.subject, snippet: email.snippet } };
    }
    return { platform, action: 'other', data: { subject: email.subject, snippet: email.snippet } };
  }

  return { platform, action: 'ignore', data: { reason: 'no match' } };
}

// --- Parsers ---

function parseXComment(email) {
  // Extract commenter name from subject: "John Doe replied to your post"
  const nameMatch = (email.subject || '').match(/^(.+?)\s+(replied|responded|quoted)/i);
  return {
    who: nameMatch ? nameMatch[1].trim() : 'Unknown',
    subject: email.subject,
    snippet: email.snippet,
    body: email.body,
  };
}

function parseXMention(email) {
  const nameMatch = (email.subject || '').match(/^(.+?)\s+mentioned/i);
  return {
    who: nameMatch ? nameMatch[1].trim() : 'Unknown',
    subject: email.subject,
    snippet: email.snippet,
    body: email.body,
  };
}

function parseXDM(email) {
  const nameMatch = (email.subject || '').match(/from\s+(.+?)$/i) || (email.subject || '').match(/^(.+?)\s+sent/i);
  return {
    who: nameMatch ? nameMatch[1].trim() : 'Unknown',
    subject: email.subject,
    snippet: email.snippet,
  };
}

function parseXFollow(email) {
  const nameMatch = (email.subject || '').match(/^(.+?)\s+followed/i);
  return {
    who: nameMatch ? nameMatch[1].trim() : 'Unknown',
    subject: email.subject,
  };
}

function parseLinkedInComment(email) {
  const nameMatch = (email.subject || '').match(/^(.+?)\s+(commented|replied|reaction)/i);
  const fromName = extractSenderName(email.from);
  return {
    who: nameMatch ? nameMatch[1].trim() : (fromName || 'Unknown'),
    subject: email.subject,
    snippet: email.snippet,
    body: email.body,
  };
}

function parseLinkedInConnection(email) {
  // Try subject first, then fall back to sender display name
  const nameMatch = (email.subject || '').match(/^(.+?)\s+(wants|sent|invitation)/i);
  const fromName = extractSenderName(email.from);
  return {
    who: nameMatch ? nameMatch[1].trim() : (fromName || 'Unknown'),
    subject: email.subject,
  };
}

function parseLinkedInDM(email) {
  const nameMatch = (email.subject || '').match(/^(.+?)\s+sent/i) || (email.subject || '').match(/from\s+(.+?)$/i);
  const fromName = extractSenderName(email.from);
  return {
    who: nameMatch ? nameMatch[1].trim() : (fromName || 'Unknown'),
    subject: email.subject,
    snippet: email.snippet,
  };
}

function parseLinkedInMention(email) {
  const nameMatch = (email.subject || '').match(/^(.+?)\s+mentioned/i);
  const fromName = extractSenderName(email.from);
  return {
    who: nameMatch ? nameMatch[1].trim() : (fromName || 'Unknown'),
    subject: email.subject,
    snippet: email.snippet,
    body: email.body,
  };
}

/**
 * Extract display name from email "from" field.
 * e.g. '"Lital Piker" <invitations@linkedin.com>' → 'Lital Piker'
 */
function extractSenderName(from) {
  if (!from) return null;
  // "Name" <email> or Name <email>
  const quoted = from.match(/^"?([^"<]+)"?\s*</);
  if (quoted) return quoted[1].trim();
  // Just email
  return null;
}

module.exports = { classify, SENDERS };
