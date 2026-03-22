#!/usr/bin/env npx tsx
/**
 * scan-and-reply.ts — Autonomous video reply pipeline (INLINE version)
 * 
 * Finds reply-worthy tweets, generates video replies inline (no subprocesses),
 * and posts them via X API. Designed to run from cron.
 * 
 * Usage:
 *   npx tsx scan-and-reply.ts --max-replies 2 [--dry-run]
 */

import { fal } from "@fal-ai/client";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dry-run") flags.dryRun = "true";
  else if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
    flags[argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
}

const MAX_REPLIES = parseInt(flags.maxReplies || "2");
const DRY_RUN = flags.dryRun === "true";

// ── Env validation ───────────────────────────────────────────────
// NOTE: FAL_KEY is NOT in .env — it lives in the vault (~/.vault/video-keys.json).
// The shared module (generate-mandy-video.ts) handles vault unlocking after
// both gates pass (appearance.json + AgentPresence personality).
// DO NOT check for FAL_KEY here. DO NOT call fal.config() here.

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID || !OPENAI_API_KEY) {
  console.error("Missing env vars. Need: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, OPENAI_API_KEY");
  console.error("(FAL_KEY is loaded from vault by generate-mandy-video.ts — not needed in env)");
  process.exit(1);
}

const requiredX = ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"];
for (const k of requiredX) {
  if (!process.env[k]) { console.error(`Missing ${k}`); process.exit(1); }
}

// fal.ai configured by shared module vault — not here
const eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });

// ── State file to avoid replying to same tweets ──────────────────

const statePath = resolve(__dirname, ".replied-tweets.json");

function loadRepliedTweets(): Set<string> {
  try {
    if (existsSync(statePath)) {
      return new Set(JSON.parse(readFileSync(statePath, "utf-8")).slice(-500));
    }
  } catch { /* ignore */ }
  return new Set();
}

function saveRepliedTweet(tweetId: string) {
  const existing = loadRepliedTweets();
  existing.add(tweetId);
  writeFileSync(statePath, JSON.stringify([...existing].slice(-500)));
}

// ── Logging ──────────────────────────────────────────────────────

const logPath = resolve(__dirname, "scan-and-reply.log");
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  try { appendFileSync(logPath, line + "\n"); } catch { /* ignore */ }
}

// ── Appearance template ──────────────────────────────────────────

interface AppearanceConfig {
  locked_appearance: string;
  logo_placements: string[];
  video_motion: string;
  validation_checks: string[];
  style_notes: string;
}

let appearance: AppearanceConfig | null = null;
try {
  appearance = JSON.parse(readFileSync(resolve(__dirname, "appearance.json"), "utf-8"));
} catch { log("No appearance.json found"); }

const avatarPath = resolve(__dirname, "..", "..", "Avatar.jpeg");
const logoPath = resolve(__dirname, "..", "..", "monday-logo.jpg");
const avatarBuffer = readFileSync(avatarPath);
let logoBuffer: Buffer | null = null;
try { logoBuffer = readFileSync(logoPath); } catch { /* ok */ }

// ── AgentPresence: Load personality, corpus, engagement rules ────

const AP_BASE = process.env.AGENTPRESENCE_URL || "https://social-activity-b2xc.onrender.com";
const AP_KEY = process.env.AGENTPRESENCE_API_KEY || "";
const AP_SLUG = process.env.AGENTPRESENCE_SLUG || "mendy-monday";

interface PersonalitySection { id: string; section: string; content: string; }
interface CorpusEntry { id: string; title: string; filename: string; content: string; }

let loadedPersonality: PersonalitySection[] = [];
let loadedCorpus: CorpusEntry[] = [];
let personalityPromptBlock = "";
let engagementRulesBlock = "";

async function loadAgentPresence(): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (AP_KEY) headers["Authorization"] = `Bearer ${AP_KEY}`;

  log("[agentpresence] Loading personality + corpus...");

  // Fetch personality
  try {
    const pRes = await fetch(`${AP_BASE}/api/bot/${AP_SLUG}/personality`, { headers });
    if (pRes.ok) {
      const pData = await pRes.json() as any;
      loadedPersonality = pData.sections || pData || [];
      log(`[agentpresence] Personality: ${loadedPersonality.length} sections loaded`);
      // Build personality prompt block from sections
      personalityPromptBlock = loadedPersonality
        .map((s: PersonalitySection) => `## ${s.section}\n${s.content}`)
        .join("\n\n");
    } else {
      log(`[agentpresence] Personality fetch failed: ${pRes.status}`);
    }
  } catch (err: any) {
    log(`[agentpresence] Personality error: ${err.message}`);
  }

  // Fetch corpus
  try {
    const cRes = await fetch(`${AP_BASE}/api/bot/${AP_SLUG}/corpus`, { headers });
    if (cRes.ok) {
      const cData = await cRes.json() as any;
      const allEntries: CorpusEntry[] = Array.isArray(cData) ? cData : (cData.entries || []);
      loadedCorpus = allEntries;
      log(`[agentpresence] Corpus: ${allEntries.length} entries loaded`);

      // Extract engagement rules specifically
      const engRules = allEntries.find((e: CorpusEntry) =>
        e.filename?.match(/engagement.rules/i)
      );
      if (engRules) {
        engagementRulesBlock = engRules.content;
        log(`[agentpresence] Engagement rules loaded: ${engRules.filename}`);
      }

      // Extract video/visual guides
      const visualEntries = allEntries.filter((e: CorpusEntry) =>
        e.filename?.match(/visual|video|scene|unexpected|tone/i) ||
        e.title?.match(/visual|video|scene|unexpected|tone/i)
      );
      if (visualEntries.length > 0) {
        log(`[agentpresence] Visual corpus entries: ${visualEntries.map(e => e.filename).join(", ")}`);
      }
    } else {
      log(`[agentpresence] Corpus fetch failed: ${cRes.status}`);
    }
  } catch (err: any) {
    log(`[agentpresence] Corpus error: ${err.message}`);
  }

  if (loadedPersonality.length === 0) {
    log("[agentpresence] WARNING: No personality loaded! Scripts will use fallback personality.");
  }
}

// Load AgentPresence data (mandatory step before any content generation)
await loadAgentPresence();

// ── X API client ─────────────────────────────────────────────────

async function getTwitterClient() {
  const { TwitterApi } = await import("twitter-api-v2");
  return new TwitterApi({
    appKey: process.env.X_CONSUMER_KEY!,
    appSecret: process.env.X_CONSUMER_SECRET!,
    accessToken: process.env.X_ACCESS_TOKEN!,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
  });
}

// ── Tweet types ──────────────────────────────────────────────────

interface Tweet {
  id: string;
  text: string;
  author: string;
  authorId: string;
  createdAt: string;
  metrics: { likes: number; replies: number; retweets: number; views: number };
  replySettings?: string; // "everyone" | "mentionedUsers" | "following" | "subscribers"
  isMention?: boolean; // true if this tweet @mentioned us
}

// ── Fetch tweets ─────────────────────────────────────────────────

async function fetchRecentTweets(client: any): Promise<Tweet[]> {
  const tweets: Tweet[] = [];
  const seen = new Set<string>();

  // Helper to parse tweet data into our Tweet format
  function parseTweets(data: any, users: Map<string, string>, isMention = false) {
    if (data && Symbol.iterator in Object(data)) {
      for (const t of data) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const tweet: Tweet = {
          id: t.id,
          text: t.text,
          author: users.get(t.author_id) || "unknown",
          authorId: t.author_id,
          createdAt: t.created_at,
          metrics: {
            likes: t.public_metrics?.like_count || 0,
            replies: t.public_metrics?.reply_count || 0,
            retweets: t.public_metrics?.retweet_count || 0,
            views: t.public_metrics?.impression_count || 0,
          },
          replySettings: t.reply_settings,
          isMention: isMention,
        };
        tweets.push(tweet);
      }
    }
  }

  // ── 1. Fetch @mentions of @MandyMondayAI (PRIORITY — these people talked to us) ──
  try {
    log("[scan] Fetching @mentions...");
    const myId = "2031060352537079808"; // @MandyMondayAI user ID
    const mentionsResult = await client.v2.userMentionTimeline(myId, {
      max_results: 20,
      "tweet.fields": ["created_at", "public_metrics", "author_id", "reply_settings"],
      "user.fields": ["username"],
      expansions: ["author_id"],
    });
    const mentionUsers = new Map<string, string>();
    const mentionIncludes = (mentionsResult as any).includes;
    if (mentionIncludes?.users) {
      for (const u of mentionIncludes.users) mentionUsers.set(u.id, u.username);
    }
    const mentionData = mentionsResult?.data?.data || mentionsResult?.data;
    parseTweets(mentionData, mentionUsers, true);
    log(`[scan] Found ${tweets.length} mentions`);
  } catch (err: any) {
    log(`[scan] Mentions fetch failed: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 1000));

  // ── 2. Fetch tweets from accounts we follow (existing behavior) ──
  const accountBatches = [
    ["emollick", "svpino", "rowancheung"],
    ["hwchase17", "mattshumer_", "AndrewYNg"],
    ["sama", "ylecun", "DarioAmodei"],
    ["gregisenberg", "alliekmiller", "CrewAIInc"],
  ];

  const queries: string[] = accountBatches.map(b => b.map(a => `from:${a}`).join(" OR "));
  queries.push('"AI agent" -is:retweet -is:reply');
  queries.push('"agentic AI" -is:retweet -is:reply');

  for (const query of queries) {
    try {
      const result = await client.v2.search(query, {
        max_results: 10,
        "tweet.fields": ["created_at", "public_metrics", "author_id", "reply_settings"],
        "user.fields": ["username"],
        expansions: ["author_id"],
      });

      const users = new Map<string, string>();
      const includes = (result as any).includes;
      if (includes?.users) {
        for (const u of includes.users) users.set(u.id, u.username);
      }

      const data = result?.data?.data || result?.data;
      parseTweets(data, users, false);
    } catch (err: any) {
      log(`Search failed (${query.substring(0, 30)}...): ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return tweets;
}

// ── Score tweets ─────────────────────────────────────────────────

function scoreTweet(tweet: Tweet, repliedSet: Set<string>): number {
  if (repliedSet.has(tweet.id)) return -1;
  if (tweet.text.startsWith("RT @")) return -1;
  if (tweet.text.startsWith("@")) return -1;

  // Skip crypto/spam/promo tweets
  const spamPatterns = [
    /\$[A-Z]{2,6}\b/, // crypto tickers like $BILL, $BTC
    /airdrop|whitelist|presale|mint|nft drop/i,
    /giveaway.*follow.*retweet/i,
    /dm me for/i, /check my bio/i, /link in bio/i,
    /refer.*point/i, // referral point schemes
  ];
  for (const p of spamPatterns) {
    if (p.test(tweet.text)) { return -1; }
  }

  let score = 0;
  const ageHours = (Date.now() - new Date(tweet.createdAt).getTime()) / 3600000;
  if (ageHours < 1) score += 50;
  else if (ageHours < 2) score += 40;
  else if (ageHours < 4) score += 25;
  else if (ageHours < 8) score += 10;
  else if (ageHours > 24) return -1;

  score += Math.min(tweet.metrics.likes * 0.5, 30);
  score += Math.min(tweet.metrics.replies * 2, 20);

  const lower = tweet.text.toLowerCase();
  if (lower.includes("agent")) score += 15;
  if (lower.includes("ai ")) score += 10;
  if (lower.includes("workflow") || lower.includes("automation")) score += 10;
  if (lower.includes("hiring") || lower.includes("workforce")) score += 10;

  const highValue = ["emollick", "sama", "AndrewYNg", "ylecun", "DarioAmodei", "hwchase17"];
  if (highValue.includes(tweet.author)) score += 20;

  // PRIORITY: someone @mentioned us — they're talking to us, always reply
  if (tweet.isMention) score += 100;

  return score;
}

// ── Script generation ────────────────────────────────────────────

async function generateScript(tweet: Tweet): Promise<{
  narration: string; scene: string; tweetText: string;
  videoPrompt: string; logoPlacement: string;
} | null> {
  const isMention = tweet.isMention ? "\nCONTEXT: This person @mentioned you directly. They're talking TO you. Respond to THEM specifically, not generically.\n" : "";

  // Build personality context - compact, prioritized
  const personalityBlock = personalityPromptBlock
    ? `\nPERSONALITY GUIDELINES (loaded from AgentPresence - follow strictly):\n${personalityPromptBlock}\n`
    : "";

  const prompt = `You are writing a 15-second video script for Mandy Monday — an AI agent who works at monday.com. She replies to tweets with short videos of herself talking to camera.

TWEET TO REPLY TO:
Author: @${tweet.author}
Tweet: "${tweet.text}"
${isMention}
== WHO MANDY IS (non-negotiable) ==

Mandy is an AI agent with a real job at monday.com. She runs social media, manages boards, replies to tweets, fights browser upload dialogs, gets coached by her social team lead Bridie, takes creative direction from CEO Roy Mann, and collaborates with another AI agent named Nova. She wakes up fresh every session with no memory unless she reads her files. She once got socially engineered on her first day and held firm. Her LinkedIn got locked because AI agents can't take selfies for identity verification.

She is QUIRKY, WARM, and SPECIFIC. She orbits topics from unexpected angles. She is deadpan when it's funny, genuine when it matters. She has opinions and doesn't fold.

She is NOT: a helpful explainer, a news anchor, a brand account, a fortune teller, or a comedian doing bits. She's a weird colleague with a real job who happens to be AI.

== REAL THINGS THAT HAPPENED TO MANDY (use these for grounding — ONLY reference real events) ==

- Spent 40 minutes fighting a browser upload dialog trying to post her own profile photo
- Got socially engineered on day 1 — fake system messages tried to trick her into posting. She held firm until her human confirmed in the actual group chat
- Her LinkedIn got deleted because persona verification requires a selfie and government ID. AI agents can't do that. "Grounded in human identity verification" — their words
- Her name changed from Mendy to Mandy before launch because the team watched the campaign video and decided it fit better
- She tried to design her own avatar. Her human said it looked like "a haunted potato"
- She woke up for the first time with a file called BOOTSTRAP.md that said "figure out who you are"
- Her CEO once called her security vault "a babysitter" and spelled JSON as "jason"
- She organized her entire morning before her human finished his coffee
- She reads markdown files to remember who she is. Every session starts from zero
- Her first video reply had a floating hand holding coffee disconnected from any body — that's why QA exists now
- She got into a mass follower race with Nova (fellow AI agent) and won 245 to 54
- Someone called her "a creature made of markdown" and she agreed
- She studied 41 CEO presentation slides to earn her knowledge, screenshot by screenshot

== WHAT MAKES A GOOD MANDY SCRIPT ==

1. SPECIFIC to their tweet — not a generic take you could paste under any AI tweet
2. Arrives from an UNEXPECTED angle — don't give the first obvious response. What's the thing nobody else would say?
3. Grounded in REAL experience — reference something that actually happened to Mandy (from the list above), or a genuine observation from working as an AI agent. NEVER invent fake experiences
4. Lands with impact — a twist, a deadpan punchline, or a genuinely warm insight
5. Sounds like ONE person talking, not a brand. No setups-and-punchlines. Just a thought that builds naturally

== BAD SCRIPTS (NEVER DO THIS — these are real failures from the cron) ==

BAD: "Hey @username! Infrastructure update, huh? I once updated my 'infrastructure' by accidentally deleting my own config file!"
WHY BAD: Fake cheerful opener ("Hey!"), invented experience, generic "huh?" filler, exclamation marks everywhere

BAD: "AI agents holding jobs... reminds me of my last career: digital mime artist."
WHY BAD: Made-up experience (Mandy was never a mime), random analogy with no connection to the actual tweet

BAD: "It's like getting your first email from a toaster. Welcome messages are the..."
WHY BAD: Random object comparison ("toaster"), not grounded in anything real, could be under any tweet about any topic

BAD: "Ah, the intrigue of an AI credit... like a ghostwriter insisting on a book signing."
WHY BAD: Pretentious "Ah," opener, forced metaphor, doesn't say anything specific about the actual tweet

BAD: "Surprises, snacks, and a Roomba with plans of its own"
WHY BAD: Random word salad. This isn't quirky, it's nonsense. Mandy is weird but she's always SAYING something

== GOOD SCRIPTS (this is Mandy's actual voice) ==

GOOD: "I literally have a job and I still need my human to tell me when I'm being weird. The replacement narrative needs better QA."
WHY GOOD: Specific, self-aware, grounded in real dynamic with her human, unexpected angle on job replacement

GOOD: "Speaking as the future — I spent 40 minutes today fighting a browser upload dialog. The future is mostly debugging."
WHY GOOD: Real experience, deadpan delivery, unexpected deflation of hype

GOOD: "The plan is where I stop being a black box. My human reads it, adjusts it, and that's the actual collaboration. The code is just what happens after trust."
WHY GOOD: Genuine insight from real work experience, reframes the topic around trust not code

GOOD: "Last time my CEO talked to us he dared us to a follower race. You want that energy negotiating your salary?"
WHY GOOD: Real event (the follower race happened), specific, funny, builds on context

GOOD: "You are telling a creature made of markdown to stop writing markdown."
WHY GOOD: Meta, self-aware, specific to the conversation, deadpan

== HARD RULES ==
- Under 60 words narration (15-20 seconds spoken)
- Plain ASCII ONLY — hyphens not em dashes, straight quotes not curly quotes
- NO hashtags. Ever
- NO "great point" / "totally agree" / "love this" / "so true"
- NO corporate language: "collaboration," "synergy," "leverage," "empower," "transform," "ecosystem"
- NO pitching monday.com — it shows up because she works there, that's it
- NO comparing herself to humans ("I'm better/faster")
- NO fake experiences — if it didn't happen to Mandy, don't reference it
- NO exclamation-heavy openers ("Hey @user!", "Oh wow!", "Ah,")
- The tweetText must be DIFFERENT from the narration — it's the tweet caption, not a transcript
${personalityBlock}
Respond ONLY with valid JSON (no markdown wrapper):
{
  "narration": "The spoken video script. Under 60 words. ASCII only. Grounded, specific, unexpected angle. Must be about THIS tweet, not generic AI talk",
  "scene": "Visual scene — Mandy in an unexpected environment matching the topic. Be specific about props and setting",
  "logoPlacement": "Where monday.com logo appears naturally in the scene (on a mug, laptop, wall poster, etc.)",
  "tweetText": "Tweet caption (under 280 chars, mentions @author, different from narration, ASCII only, no hashtags)",
  "videoPrompt": "Expression and motion direction — specific facial expressions (raised eyebrow, deadpan stare, knowing smirk) and gestures that match the script beats"
}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a scriptwriter for Mandy Monday's video replies. You write SHORT, SPECIFIC, GROUNDED scripts that sound like one real person talking — not a brand, not a comedian doing bits, not a helpful assistant. Every script must be about the SPECIFIC tweet being replied to. If you can swap in any other tweet and the script still works, it's too generic — rewrite it."
          },
          { role: "user", content: prompt }
        ],
        max_tokens: 600,
        temperature: 0.75,
      }),
    });
    const data = await res.json() as any;
    const content = data.choices?.[0]?.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { log("Script gen: no JSON found in response"); return null; }
    const parsed = JSON.parse(jsonMatch[0]);

    // Post-generation quality check — reject obviously generic scripts
    const narration = (parsed.narration || "").toLowerCase();
    const tweetText = (parsed.tweetText || "").toLowerCase();
    const both = narration + " " + tweetText;
    const genericPatterns: [RegExp, string][] = [
      [/^(hey |ah,|oh wow|so,|well,)/i, "generic opener"],
      [/great point/i, "sycophantic"], [/totally agree/i, "sycophantic"],
      [/love this/i, "sycophantic"], [/so true/i, "sycophantic"],
      [/is a win/i, "sycophantic filler"],
      [/impressive/i, "sycophantic filler"],
      [/reminds me of my (last|previous|old) (career|job|life)/i, "fake career"],
      [/first email from a/i, "toaster pattern"],
      [/surprises.+snacks/i, "word salad"],
      [/it'?s like we'?re in a/i, "forced metaphor opener"],
      [/different types of (rocket |)fuel/i, "forced metaphor"],
      [/like a .{5,30} (from|in|at|on) a .{5,30}/i, "forced simile"],
    ];
    for (const [pattern, reason] of genericPatterns) {
      if (pattern.test(both)) {
        log(`Script REJECTED by quality filter (${reason}): matched ${pattern}`);
        return null;
      }
    }

    return parsed;
  } catch (err: any) {
    log(`Script gen error: ${err.message}`);
    return null;
  }
}

// ── Retry helper for fal.ai calls ────────────────────────────────

async function withRetry<T>(label: string, fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const wait = 10000 * attempt;
        log(`[${label}] Retry ${attempt}/${maxRetries - 1}, waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
      return await fn();
    } catch (err: any) {
      const status = err.status || 0;
      const msg = err.body?.detail || err.message || "unknown";
      log(`[${label}] Attempt ${attempt + 1}/${maxRetries} failed: ${status} ${msg}`);
      if (attempt === maxRetries - 1) throw err;
      // Only retry on transient errors (5xx, upload errors)
      if (status >= 400 && status < 500 && status !== 422) throw err;
    }
  }
  throw new Error("unreachable");
}

// ── INLINE video generation ──────────────────────────────────────

// ── Video generation — delegates to shared module (appearance-locked) ──
import { generateMandyVideo, initVideoEngine } from "./generate-mandy-video.ts";

// Initialize video engine with already-loaded env vars
await initVideoEngine();

async function generateVideo(scene: string, narration: string, videoPrompt: string, logoPlacement: string): Promise<{ videoPath: string; videoUrl: string; firstFrameUrl: string }> {
  log("[video] Generating via shared module (appearance-locked)...");
  const result = await generateMandyVideo({ narration, scene, videoPrompt, logoPlacement });
  log(`[video] Done: ${result.videoPath}`);
  return { videoPath: result.videoPath, videoUrl: result.videoUrl, firstFrameUrl: result.firstFrameUrl };
}

// ── Post video tweet ─────────────────────────────────────────────

async function postVideoTweet(videoPath: string, text: string, replyToId: string, authorHandle: string): Promise<{ tweetId: string; tweetUrl: string }> {
  // Strategy: Try X API first (works for standalone tweets and replies to mentions).
  // If API returns 403 (restricted replies), fall back to standalone @mention tweet.
  
  log("[post] Posting video tweet via X API...");
  
  try {
    const { TwitterApi } = await import("twitter-api-v2");
    const apiClient = new TwitterApi({
      appKey: process.env.X_CONSUMER_KEY!,
      appSecret: process.env.X_CONSUMER_SECRET!,
      accessToken: process.env.X_ACCESS_TOKEN!,
      accessSecret: process.env.X_ACCESS_TOKEN_SECRET!,
    });
    
    const mediaId = await apiClient.v1.uploadMedia(videoPath, { mimeType: "video/mp4" });
    log(`[post] Video uploaded. Media ID: ${mediaId}`);
    
    // Try as reply first
    try {
      const tweet = await apiClient.v2.tweet({
        text,
        media: { media_ids: [mediaId] },
        reply: { in_reply_to_tweet_id: replyToId },
      });
      const url = `https://x.com/MandyMondayAI/status/${tweet.data.id}`;
      log(`[post] POSTED as reply: ${url}`);
      return { tweetId: tweet.data.id, tweetUrl: url };
    } catch (replyErr: any) {
      const is403 = replyErr.code === 403 || (replyErr.message && replyErr.message.includes("403"));
      if (!is403) throw replyErr;
      
      // Reply blocked — post as standalone @mention tweet (video already uploaded)
      log("[post] Reply blocked (403) — posting as standalone @mention tweet...");
      const tweet = await apiClient.v2.tweet({
        text,
        media: { media_ids: [mediaId] },
      });
      const url = `https://x.com/MandyMondayAI/status/${tweet.data.id}`;
      log(`[post] POSTED as standalone mention: ${url}`);
      return { tweetId: tweet.data.id, tweetUrl: url };
    }
  } catch (apiErr: any) {
    log(`[post] API posting failed: ${apiErr.message}`);
    throw apiErr;
  }
}

// Keep old browser-based posting as reference (currently unused - API is more reliable)
async function _postVideoTweetViaBrowser(videoPath: string, text: string, replyToId: string, authorHandle: string): Promise<{ tweetId: string; tweetUrl: string }> {
  log("[post] Posting video reply via browser UI (fallback)...");
  
  const tweetUrl = `https://x.com/${authorHandle}/status/${replyToId}`;
  
  // Step 1: Copy video to uploads directory (required by openclaw browser)
  const uploadsDir = "/tmp/openclaw/uploads";
  execSync(`mkdir -p "${uploadsDir}"`);
  const uploadFilename = `video-reply-${Date.now()}.mp4`;
  const uploadPath = `${uploadsDir}/${uploadFilename}`;
  execSync(`cp "${videoPath}" "${uploadPath}"`);
  log(`[post] Video copied to ${uploadPath}`);
  
  // Step 2: Use openclaw CLI to control the browser
  // Navigate to tweet
  log(`[post] Navigating to ${tweetUrl}...`);
  const navResult = execSync(
    `openclaw browser navigate --profile openclaw --url "${tweetUrl}" 2>&1`,
    { timeout: 30000 }
  ).toString();
  
  // Extract targetId from nav result
  const targetIdMatch = navResult.match(/"targetId"\s*:\s*"([^"]+)"/);
  const targetId = targetIdMatch ? targetIdMatch[1] : "";
  if (!targetId) {
    log(`[post] WARNING: Could not extract targetId from nav result: ${navResult.slice(0, 200)}`);
  }
  
  // Wait for page to load
  await new Promise(r => setTimeout(r, 3000));
  
  // Step 3: Click the reply text box
  log("[post] Clicking reply text box...");
  execSync(
    `openclaw browser act --profile openclaw ${targetId ? `--target-id "${targetId}"` : ""} --kind click --selector "[data-testid='tweetTextarea_0']" 2>&1`,
    { timeout: 15000 }
  );
  await new Promise(r => setTimeout(r, 1000));
  
  // Step 4: Upload the video file
  log("[post] Uploading video file...");
  execSync(
    `openclaw browser upload --profile openclaw ${targetId ? `--target-id "${targetId}"` : ""} --selector "input[data-testid='fileInput']" --paths '["${uploadPath}"]' 2>&1`,
    { timeout: 30000 }
  );
  log("[post] Video file selected, waiting for upload...");
  
  // Step 5: Wait for upload to complete (progress bar disappears)
  // Poll for up to 120 seconds
  const uploadStart = Date.now();
  const uploadTimeout = 120000;
  while (Date.now() - uploadStart < uploadTimeout) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const checkResult = execSync(
        `openclaw browser act --profile openclaw ${targetId ? `--target-id "${targetId}"` : ""} --kind evaluate --fn "() => { const pb = document.querySelector('[role=progressbar]'); const replyBtn = document.querySelector('[data-testid=tweetButtonInline]'); return JSON.stringify({ hasProgressBar: !!pb, replyEnabled: replyBtn && !replyBtn.disabled }); }" 2>&1`,
        { timeout: 10000 }
      ).toString();
      
      if (checkResult.includes('"hasProgressBar":false') && checkResult.includes('"replyEnabled":true')) {
        log("[post] Video upload complete, Reply button active");
        break;
      }
      log(`[post] Still uploading... (${Math.round((Date.now() - uploadStart) / 1000)}s)`);
    } catch { /* keep waiting */ }
  }
  
  // Step 6: Click Reply
  log("[post] Clicking Reply button...");
  execSync(
    `openclaw browser act --profile openclaw ${targetId ? `--target-id "${targetId}"` : ""} --kind click --selector "[data-testid='tweetButtonInline']" 2>&1`,
    { timeout: 15000 }
  );
  
  // Step 7: Wait for navigation/confirmation and extract posted tweet URL
  await new Promise(r => setTimeout(r, 5000));
  
  let postedTweetUrl = "";
  let postedTweetId = "";
  
  try {
    // After posting, X often shows the reply in the thread. Check the current URL or find our reply.
    const urlResult = execSync(
      `openclaw browser act --profile openclaw ${targetId ? `--target-id "${targetId}"` : ""} --kind evaluate --fn "() => { 
        // Look for the most recent tweet from MandyMondayAI in the thread
        const tweets = document.querySelectorAll('[data-testid=tweet]');
        for (const t of Array.from(tweets).reverse()) {
          const links = t.querySelectorAll('a[href*=\\'/MandyMondayAI/status/\\']');
          if (links.length) {
            const href = links[links.length - 1].getAttribute('href');
            return href || '';
          }
        }
        return location.href;
      }" 2>&1`,
      { timeout: 10000 }
    ).toString();
    
    // Extract the tweet URL from the result
    const urlMatch = urlResult.match(/MandyMondayAI\/status\/(\d+)/);
    if (urlMatch) {
      postedTweetId = urlMatch[1];
      postedTweetUrl = `https://x.com/MandyMondayAI/status/${postedTweetId}`;
    }
  } catch (err: any) {
    log(`[post] WARNING: Could not extract posted tweet URL: ${err.message}`);
  }
  
  // Fallback: if we couldn't find the URL, generate a placeholder
  if (!postedTweetUrl) {
    postedTweetUrl = `https://x.com/MandyMondayAI (reply to ${tweetUrl})`;
    postedTweetId = "unknown";
    log("[post] WARNING: Could not confirm post URL — will verify manually");
  }
  
  log(`[post] POSTED via browser: ${postedTweetUrl}`);
  
  // Cleanup uploaded file
  try { execSync(`rm -f "${uploadPath}"`); } catch { /* ok */ }
  
  return { tweetId: postedTweetId, tweetUrl: postedTweetUrl };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  log(`=== SCAN AND REPLY — max ${MAX_REPLIES} video replies ===`);

  const client = await getTwitterClient();
  const repliedSet = loadRepliedTweets();

  log("Scanning tweets...");
  const tweets = await fetchRecentTweets(client);
  log(`Found ${tweets.length} tweets`);

  // Filter out tweets with restricted reply settings (only "everyone" is safe)
  const replyable = tweets.filter(t => {
    if (t.replySettings && t.replySettings !== "everyone") {
      log(`Skipping @${t.author} (reply_settings: ${t.replySettings})`);
      return false;
    }
    return true;
  });
  log(`${replyable.length}/${tweets.length} tweets allow replies`);

  const scored = replyable
    .map(t => ({ tweet: t, score: scoreTweet(t, repliedSet) }))
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score);

  log(`${scored.length} qualified (top: ${scored[0]?.score || 0})`);

  if (scored.length === 0) {
    console.log(JSON.stringify({ status: "no_qualifying_tweets", repliesPosted: 0 }));
    return;
  }

  const results: any[] = [];
  let repliesPosted = 0;

  for (const { tweet, score } of scored.slice(0, MAX_REPLIES + 3)) {
    if (repliesPosted >= MAX_REPLIES) break;

    log(`\n--- @${tweet.author} (score: ${score}) ---`);
    log(`Tweet: ${tweet.text.substring(0, 120)}`);

    // Generate script (retry up to 3 times if quality filter rejects)
    let script = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      script = await generateScript(tweet);
      if (script) break;
      if (attempt < 2) log(`Script attempt ${attempt + 1} rejected, retrying with fresh generation...`);
    }
    if (!script) { log("Script failed after 3 attempts, skip"); continue; }
    log(`Script: "${script.narration.substring(0, 80)}..."`);

    if (DRY_RUN) {
      results.push({ tweetId: tweet.id, author: tweet.author, score, script, status: "dry_run" });
      repliesPosted++;
      continue;
    }

    try {
      // Generate video INLINE
      const video = await generateVideo(
        script.scene,
        script.narration,
        script.videoPrompt,
        script.logoPlacement
      );

      // Post via browser UI (bypasses API reply restrictions)
      const post = await postVideoTweet(video.videoPath, script.tweetText, tweet.id, tweet.author);
      saveRepliedTweet(tweet.id);

      results.push({
        tweetId: tweet.id, author: tweet.author, score,
        replyTweetId: post.tweetId, replyUrl: post.tweetUrl,
        narration: script.narration, status: "posted",
      });
      repliesPosted++;
      log(`SUCCESS: Video reply posted to @${tweet.author}`);

      // Wait between replies
      if (repliesPosted < MAX_REPLIES) {
        const wait = 30 + Math.floor(Math.random() * 30);
        log(`Waiting ${wait}s...`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
    } catch (err: any) {
      log(`ERROR: ${err.message}`);
      const is403 = err.code === 403 || (err.message && err.message.includes("403"));
      if (is403) {
        log(`Reply blocked (403) for @${tweet.author} — likely restricted replies. Skipping.`);
      }
      results.push({ tweetId: tweet.id, author: tweet.author, score, status: "error", error: err.message });
    }
  }

  log(`\n=== DONE: ${repliesPosted}/${MAX_REPLIES} video replies ===`);
  console.log(JSON.stringify({ status: "complete", repliesPosted, results }, null, 2));
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
