import { fal } from "@fal-ai/client";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ── CLI arg parsing ──────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--first-frame" && argv[i + 1]) {
      args.firstFrame = argv[++i];
    } else if (arg === "--narration" && argv[i + 1]) {
      args.narration = argv[++i];
    } else if (arg === "--video-prompt" && argv[i + 1]) {
      args.videoPrompt = argv[++i];
    } else if (arg === "--first-frame-url" && argv[i + 1]) {
      args.firstFrameUrl = argv[++i];
    } else if (arg === "--audio-url" && argv[i + 1]) {
      args.audioUrl = argv[++i];
    } else if (arg === "--notify" && argv[i + 1]) {
      args.notify = argv[++i];
    } else if (arg === "--notify-channel" && argv[i + 1]) {
      args.notifyChannel = argv[++i];
    } else if (arg === "--aspect-ratio" && argv[i + 1]) {
      args.aspectRatio = argv[++i];
    } else if (arg === "--resume") {
      args.resume = "true";
    } else if (arg === "--dry-run") {
      args.dryRun = "true";
    }
  }
  return args;
}

const args = parseArgs(process.argv);

// With --resume, we only need --video-prompt (frame + audio come from checkpoint)
// With --first-frame-url + --audio-url, we skip to step 3
// Otherwise, all three prompts are required
const hasResumeInputs = args.firstFrameUrl && args.audioUrl;
if (!hasResumeInputs && !args.resume) {
  if (!args.firstFrame || !args.narration || !args.videoPrompt) {
    console.error(
      "Usage: npx tsx generate-video.ts --first-frame <prompt> --narration <script> --video-prompt <prompt>\n" +
      "  Resume: --resume (uses checkpoint file)\n" +
      "  Skip to video: --first-frame-url <url> --audio-url <url> --video-prompt <prompt>"
    );
    process.exit(1);
  }
}

if (args.dryRun) {
  console.log(
    JSON.stringify({
      dryRun: true,
      firstFrame: args.firstFrame,
      narration: args.narration,
      videoPrompt: args.videoPrompt,
      firstFrameUrl: args.firstFrameUrl,
      audioUrl: args.audioUrl,
      aspectRatio: args.aspectRatio || "landscape_4_3",
      resume: !!args.resume,
    }, null, 2)
  );
  process.exit(0);
}

// ── Environment ──────────────────────────────────────────────────

const FAL_KEY = process.env.FAL_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!FAL_KEY) {
  console.error("Missing FAL_KEY env var");
  process.exit(1);
}
if (!ELEVENLABS_API_KEY) {
  console.error("Missing ELEVENLABS_API_KEY env var");
  process.exit(1);
}
if (!ELEVENLABS_VOICE_ID) {
  console.error("Missing ELEVENLABS_VOICE_ID env var");
  process.exit(1);
}

fal.config({ credentials: FAL_KEY });

const eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });

// ── Checkpoint ───────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkpointPath = resolve(__dirname, ".checkpoint.json");

interface Checkpoint {
  firstFrameUrl?: string;
  audioUrl?: string;
  videoPrompt?: string;
  firstFrame?: string;
  narration?: string;
  timestamp: number;
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (existsSync(checkpointPath)) {
      const data = JSON.parse(readFileSync(checkpointPath, "utf-8"));
      // Checkpoints expire after 1 hour (fal URLs have TTL)
      if (Date.now() - data.timestamp < 3600_000) {
        return data;
      }
      console.error("[checkpoint] Expired (>1h old), starting fresh");
      unlinkSync(checkpointPath);
    }
  } catch {
    // ignore corrupt checkpoint
  }
  return null;
}

function saveCheckpoint(cp: Partial<Checkpoint>) {
  const existing = loadCheckpoint() ?? { timestamp: Date.now() };
  const merged = { ...existing, ...cp, timestamp: Date.now() };
  writeFileSync(checkpointPath, JSON.stringify(merged, null, 2));
  console.error(`[checkpoint] Saved: ${Object.keys(cp).join(", ")}`);
}

function clearCheckpoint() {
  try {
    if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
  } catch { /* ignore */ }
}

// ── Resolve starting state ───────────────────────────────────────

let firstFrameUrl: string | undefined = args.firstFrameUrl;
let audioUrl: string | undefined = args.audioUrl;
let videoPrompt: string = args.videoPrompt ?? "";

// If --resume, load from checkpoint
if (args.resume) {
  const cp = loadCheckpoint();
  if (!cp) {
    console.error("[resume] No valid checkpoint found. Run the full pipeline first.");
    process.exit(1);
  }
  firstFrameUrl = firstFrameUrl ?? cp.firstFrameUrl;
  audioUrl = audioUrl ?? cp.audioUrl;
  videoPrompt = videoPrompt || cp.videoPrompt || "";
  // Restore original prompts for re-generation if needed
  if (!args.firstFrame && cp.firstFrame) args.firstFrame = cp.firstFrame;
  if (!args.narration && cp.narration) args.narration = cp.narration;
  console.error(`[resume] Loaded checkpoint — firstFrame: ${!!firstFrameUrl}, audio: ${!!audioUrl}`);
}

// ── Resolve Avatar path ──────────────────────────────────────────

const avatarPath = resolve(__dirname, "..", "..", "Avatar.jpeg");

let avatarBuffer: Buffer | null = null;
if (!firstFrameUrl) {
  try {
    avatarBuffer = readFileSync(avatarPath);
  } catch {
    console.error(`Avatar.jpeg not found at ${avatarPath}`);
    process.exit(1);
  }
}

// ── Step 1: First Frame (Seedream v4.5 Edit) ────────────────────

if (firstFrameUrl) {
  console.error(`[1/3] Skipping first frame (using provided URL)`);
} else {
  console.error("[1/3] Generating first frame with Seedream v4.5...");

  const avatarUrl = await fal.storage.upload(
    new Blob([avatarBuffer!], { type: "image/jpeg" })
  );

  const firstFrameResult = await fal.subscribe(
    "fal-ai/bytedance/seedream/v4.5/edit" as any,
    {
      input: {
        prompt: `Generate an image based on the character in Figure 1. ${args.firstFrame}`,
        image_urls: [avatarUrl],
      } as any,
      logs: false,
    }
  );

  const firstFrameData = firstFrameResult.data as any;
  firstFrameUrl =
    firstFrameData?.images?.[0]?.url ?? firstFrameData?.image?.url;

  if (!firstFrameUrl) {
    console.error("Seedream returned no image URL");
    console.error(JSON.stringify(firstFrameData, null, 2));
    process.exit(1);
  }

  console.error(`[1/3] First frame ready: ${firstFrameUrl}`);

  // Save checkpoint after step 1
  saveCheckpoint({
    firstFrameUrl,
    firstFrame: args.firstFrame,
    narration: args.narration,
    videoPrompt,
  });
}

// ── Step 2: Voiceover (ElevenLabs TTS) ──────────────────────────

if (audioUrl) {
  console.error(`[2/3] Skipping voiceover (using provided URL)`);
} else {
  console.error("[2/3] Generating voiceover with ElevenLabs...");

  const audioResponse = await eleven.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
    text: args.narration,
    model_id: "eleven_multilingual_v2",
    output_format: "mp3_44100_128",
  });

  // Collect audio stream into a buffer
  const audioChunks: Uint8Array[] = [];
  for await (const chunk of audioResponse as any) {
    audioChunks.push(new Uint8Array(chunk));
  }
  const audioBuffer = Buffer.concat(audioChunks);

  console.error(`[2/3] Voiceover generated (${audioBuffer.length} bytes)`);

  // Upload audio to fal storage
  audioUrl = await fal.storage.upload(
    new Blob([audioBuffer], { type: "audio/mpeg" })
  );

  console.error(`[2/3] Audio uploaded: ${audioUrl}`);

  // Save checkpoint after step 2
  saveCheckpoint({
    firstFrameUrl,
    audioUrl,
    firstFrame: args.firstFrame,
    narration: args.narration,
    videoPrompt,
  });
}

// ── Step 3: Video (LTX-2 19B Audio-to-Video) ────────────────────

console.error("[3/3] Generating video with LTX-2 19B...");

const videoResult = await fal.subscribe(
  "fal-ai/ltx-2-19b/audio-to-video" as any,
  {
    input: {
      image_url: firstFrameUrl,
      audio_url: audioUrl,
      prompt: videoPrompt,
      match_audio_length: true,
      aspect_ratio: args.aspectRatio || "landscape_4_3",
      use_multiscale: true,
    } as any,
    logs: false,
  }
);

const videoData = videoResult.data as any;
const videoUrl: string = videoData?.video?.url;

if (!videoUrl) {
  console.error("LTX-2 returned no video URL");
  console.error(JSON.stringify(videoData, null, 2));
  process.exit(1);
}

console.error(`[3/3] Video ready!`);

// Clear checkpoint on success
clearCheckpoint();

// ── Output ───────────────────────────────────────────────────────

const result = JSON.stringify({ videoUrl, firstFrameUrl }, null, 2);
console.log(result);

// ── Notify (optional) ────────────────────────────────────────────

if (args.notify) {
  const channel = args.notifyChannel || "whatsapp";
  const message = `🎬 Video ready!\n\n🖼️ First frame: ${firstFrameUrl}\n📹 Video: ${videoUrl}`;

  try {
    console.error(`[notify] Sending result to ${args.notify} via ${channel}...`);
    execSync(
      `openclaw message send --channel ${channel} --target "${args.notify}" --message "${message.replace(/"/g, '\\"')}"`,
      { stdio: "inherit", timeout: 30_000 }
    );
    console.error(`[notify] Sent!`);
  } catch (err) {
    console.error(`[notify] Failed to send notification: ${err}`);
    // Don't fail the whole pipeline over a notification error
  }
}
