import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Video Reply Orchestrator
 * 
 * Takes a tweet URL + author handle, generates a video reply as a NEW tweet
 * that mentions them. The tweet text contains their question/topic,
 * the video is Mandy's response.
 * 
 * Usage:
 *   npx tsx generate-video-reply.ts \
 *     --tweet-url "https://x.com/user/status/123" \
 *     --author "@username" \
 *     --topic "Their question or hot take summarized" \
 *     --narration "Mandy's spoken response script" \
 *     --scene "Scene description for first frame" \
 *     --tweet-text "The tweet text that goes with the video" \
 *     [--logo-placement "where monday.com logo goes"] \
 *     [--aspect-ratio landscape_4_3] \
 *     [--no-validate] \
 *     [--notify <chat_id>] [--notify-channel whatsapp] \
 *     [--dry-run]
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI arg parsing ──────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      const key = arg.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[++i];
    } else if (arg === "--no-validate") {
      args.noValidate = "true";
    } else if (arg === "--dry-run") {
      args.dryRun = "true";
    }
  }
  return args;
}

const args = parseArgs(process.argv);

// ── Validate required args ───────────────────────────────────────

if (!args.author || !args.narration || !args.scene) {
  console.error(`Video Reply Orchestrator

Usage: npx tsx generate-video-reply.ts \\
  --author "@username" \\
  --topic "Their question or hot take" \\
  --narration "Mandy's spoken response" \\
  --scene "Scene description" \\
  --tweet-text "Tweet text mentioning them" \\
  [--tweet-url "original tweet URL"] \\
  [--logo-placement "where monday.com logo goes"] \\
  [--aspect-ratio landscape_4_3] \\
  [--no-validate] \\
  [--notify <chat_id>] [--notify-channel whatsapp] \\
  [--dry-run]

The tweet format will be:
  .@username asked: "[topic summary]"
  
  Here's my take 👇
  [VIDEO]
`);
  process.exit(1);
}

// ── Build tweet text ─────────────────────────────────────────────

const author = args.author.replace(/^@/, "");
const tweetText = args.tweetText || buildDefaultTweetText(author, args.topic);

function buildDefaultTweetText(handle: string, topic?: string): string {
  if (topic) {
    return `.@${handle}: "${topic}"\n\nHere's my take:`;
  }
  return `.@${handle} Here's my take:`;
}

// ── Dry run ──────────────────────────────────────────────────────

if (args.dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    tweetText,
    author: `@${author}`,
    tweetUrl: args.tweetUrl || null,
    narration: args.narration,
    scene: args.scene,
    logoPlacement: args.logoPlacement || "random from appearance.json",
    aspectRatio: args.aspectRatio || "landscape_4_3",
    validate: args.noValidate !== "true",
  }, null, 2));
  process.exit(0);
}

// ── Step 1: Generate video using the base pipeline ───────────────

console.error("=== VIDEO REPLY ORCHESTRATOR ===");
console.error(`Author: @${author}`);
console.error(`Tweet text: ${tweetText}`);
console.error(`Scene: ${args.scene}`);
console.error("");

const generateCmd = [
  "npx", "tsx", resolve(__dirname, "generate-video.ts"),
  "--scene", args.scene,
  "--narration", args.narration,
  "--video-prompt", args.videoPrompt || "animated talking to camera, expressive hand gestures, engaging eye contact",
];

if (args.logoPlacement) {
  generateCmd.push("--logo-placement", args.logoPlacement);
}
if (args.aspectRatio) {
  generateCmd.push("--aspect-ratio", args.aspectRatio);
}
if (args.noValidate === "true") {
  generateCmd.push("--no-validate");
}

console.error("[1/2] Generating video...");

// Run the base pipeline and capture output
const env = { ...process.env };
const videoOutput = execSync(
  generateCmd.map(c => `"${c.replace(/"/g, '\\"')}"`).join(" "),
  { encoding: "utf-8", timeout: 600_000, env, stdio: ["pipe", "pipe", "inherit"] }
);

let videoResult: { videoUrl: string; firstFrameUrl: string };
try {
  videoResult = JSON.parse(videoOutput.trim());
} catch {
  console.error("Failed to parse video pipeline output:");
  console.error(videoOutput);
  process.exit(1);
}

console.error(`[1/2] Video ready: ${videoResult.videoUrl}`);
console.error(`[1/2] First frame: ${videoResult.firstFrameUrl}`);

// ── Step 2: Download video for posting ───────────────────────────

console.error("[2/2] Downloading video...");

const videoPath = "/tmp/video-reply.mp4";
execSync(`curl -sL "${videoResult.videoUrl}" -o "${videoPath}"`, { timeout: 60_000 });
const videoSize = readFileSync(videoPath).length;
console.error(`[2/2] Downloaded: ${videoPath} (${(videoSize / 1024 / 1024).toFixed(1)}MB)`);

// ── Output ───────────────────────────────────────────────────────

const output = {
  tweetText,
  author: `@${author}`,
  tweetUrl: args.tweetUrl || null,
  videoUrl: videoResult.videoUrl,
  firstFrameUrl: videoResult.firstFrameUrl,
  videoPath,
  videoSizeMB: (videoSize / 1024 / 1024).toFixed(1),
};

console.log(JSON.stringify(output, null, 2));

// ── Notify ───────────────────────────────────────────────────────

if (args.notify) {
  const channel = args.notifyChannel || "whatsapp";
  const message = [
    `🎬 Video reply ready for @${author}!`,
    ``,
    `📝 Tweet text:`,
    tweetText,
    ``,
    `🖼️ First frame: ${videoResult.firstFrameUrl}`,
    `📹 Video: ${videoResult.videoUrl}`,
    ``,
    `Video downloaded to ${videoPath} — ready to post on X`,
  ].join("\n");

  try {
    console.error(`[notify] Sending to ${args.notify}...`);
    execSync(
      `openclaw message send --channel ${channel} --target "${args.notify}" --message "${message.replace(/"/g, '\\"')}"`,
      { stdio: "inherit", timeout: 30_000 }
    );
  } catch (err) {
    console.error(`[notify] Failed: ${err}`);
  }
}
