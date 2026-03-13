/**
 * generate-multiclip.ts — Multi-scene YouTube Short generator
 *
 * Takes a JSON scene list, generates each scene as a separate video clip
 * (first-frame + voiceover + video), then concatenates them into one Short.
 *
 * Usage:
 *   npx tsx generate-multiclip.ts --scenes scenes.json [--aspect-ratio portrait_9_16] [--notify <chat_id>] [--notify-channel whatsapp] [--out output.mp4]
 *
 * scenes.json format:
 * [
 *   {
 *     "narration": "My boss texted me. Four words. We need YouTube Shorts.",
 *     "firstFrame": "Screenshot of a WhatsApp chat showing a message that says 'We need YouTube Shorts', phone screen, clean modern UI",
 *     "videoPrompt": "WhatsApp chat screen with message bubbles, slight phone tilt animation, soft glow on the new message",
 *     "referenceImage": "/path/to/screenshot.png"  // optional: use as first frame directly instead of generating
 *   },
 *   ...
 * ]
 *
 * Each scene gets its own voiceover segment, first frame, and video clip.
 * All clips are concatenated with ffmpeg into the final output.
 */

import { fal } from "@fal-ai/client";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "fs";
import { execSync } from "child_process";
import { resolve, dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// ── Types ────────────────────────────────────────────────────────

interface Scene {
  narration: string;
  firstFrame: string;
  videoPrompt: string;
  referenceImage?: string; // path to a screenshot/image to use as-is for first frame
  firstFrameUrl?: string; // pre-generated first frame URL (skip generation)
  audioUrl?: string; // pre-generated audio URL (skip generation)
  videoUrl?: string; // pre-generated video URL (skip generation)
}

interface Checkpoint {
  scenes: Scene[];
  completedScenes: number;
  timestamp: number;
}

// ── CLI arg parsing ──────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--scenes" && argv[i + 1]) args.scenes = argv[++i];
    else if (arg === "--aspect-ratio" && argv[i + 1])
      args.aspectRatio = argv[++i];
    else if (arg === "--notify" && argv[i + 1]) args.notify = argv[++i];
    else if (arg === "--notify-channel" && argv[i + 1])
      args.notifyChannel = argv[++i];
    else if (arg === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (arg === "--resume") args.resume = "true";
    else if (arg === "--dry-run") args.dryRun = "true";
    else if (arg === "--no-avatar") args.noAvatar = "true";
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.scenes && !args.resume) {
  console.error(
    "Usage: npx tsx generate-multiclip.ts --scenes <scenes.json> [--aspect-ratio portrait_9_16] [--out output.mp4] [--notify <chat_id>] [--resume]"
  );
  process.exit(1);
}

// ── Environment ──────────────────────────────────────────────────

const FAL_KEY = process.env.FAL_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!FAL_KEY || !ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.error("Missing env vars: FAL_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID");
  process.exit(1);
}

fal.config({ credentials: FAL_KEY });
const eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });

// ── Paths ────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const workDir = resolve(__dirname, ".multiclip-work");
const checkpointPath = resolve(workDir, "checkpoint.json");

mkdirSync(workDir, { recursive: true });

// Ensure ffmpeg is findable
const extraPath = join(homedir(), "local", "bin");
if (existsSync(join(extraPath, "ffmpeg"))) {
  process.env.PATH = `${extraPath}:${process.env.PATH}`;
}

// ── Avatar ───────────────────────────────────────────────────────

const avatarPath = resolve(__dirname, "..", "..", "Avatar.jpeg");
let avatarBuffer: Buffer | null = null;
if (!args.noAvatar && existsSync(avatarPath)) {
  avatarBuffer = readFileSync(avatarPath);
  console.error(`[init] Avatar loaded (${avatarBuffer.length} bytes)`);
} else {
  console.error(`[init] No avatar — scenes will use prompt-only generation`);
}

// ── Checkpoint ───────────────────────────────────────────────────

function loadCheckpoint(): Checkpoint | null {
  try {
    if (existsSync(checkpointPath)) {
      const data = JSON.parse(readFileSync(checkpointPath, "utf-8"));
      if (Date.now() - data.timestamp < 7200_000) return data; // 2h TTL
      console.error("[checkpoint] Expired, starting fresh");
      unlinkSync(checkpointPath);
    }
  } catch {}
  return null;
}

function saveCheckpoint(cp: Checkpoint) {
  cp.timestamp = Date.now();
  writeFileSync(checkpointPath, JSON.stringify(cp, null, 2));
  console.error(`[checkpoint] Saved (${cp.completedScenes}/${cp.scenes.length} scenes done)`);
}

function clearCheckpoint() {
  try {
    if (existsSync(checkpointPath)) unlinkSync(checkpointPath);
  } catch {}
}

// ── Load scenes ──────────────────────────────────────────────────

let scenes: Scene[];
let startFrom = 0;

if (args.resume) {
  const cp = loadCheckpoint();
  if (!cp) {
    console.error("[resume] No valid checkpoint found.");
    process.exit(1);
  }
  scenes = cp.scenes;
  startFrom = cp.completedScenes;
  console.error(`[resume] Resuming from scene ${startFrom + 1}/${scenes.length}`);
} else {
  const scenesPath = resolve(args.scenes);
  if (!existsSync(scenesPath)) {
    console.error(`Scenes file not found: ${scenesPath}`);
    process.exit(1);
  }
  scenes = JSON.parse(readFileSync(scenesPath, "utf-8"));
  if (!Array.isArray(scenes) || scenes.length === 0) {
    console.error("Scenes file must be a non-empty JSON array");
    process.exit(1);
  }
  console.error(`[init] Loaded ${scenes.length} scenes`);
}

if (args.dryRun) {
  console.log(JSON.stringify({ dryRun: true, sceneCount: scenes.length, scenes }, null, 2));
  process.exit(0);
}

// ── Helper: upload local file to fal storage ─────────────────────

async function uploadFile(filePath: string, mimeType: string): Promise<string> {
  const buf = readFileSync(filePath);
  return fal.storage.upload(new Blob([buf], { type: mimeType }));
}

// ── Helper: download URL to local file ───────────────────────────

function downloadFile(url: string, outPath: string) {
  execSync(`curl -sL -o "${outPath}" "${url}"`, { timeout: 60_000 });
}

// ── Process each scene ───────────────────────────────────────────

const aspectRatio = args.aspectRatio || "portrait_9_16";

for (let i = startFrom; i < scenes.length; i++) {
  const scene = scenes[i];
  const sceneNum = i + 1;
  console.error(`\n${"=".repeat(60)}`);
  console.error(`[scene ${sceneNum}/${scenes.length}] Processing...`);
  console.error(`  Narration: "${scene.narration.substring(0, 80)}..."`);

  // ── Step A: Voiceover ──────────────────────────────────────────
  if (!scene.audioUrl) {
    console.error(`[scene ${sceneNum}] Generating voiceover...`);
    const audioResponse = await eleven.textToSpeech.convert(ELEVENLABS_VOICE_ID, {
      text: scene.narration,
      model_id: "eleven_multilingual_v2",
      output_format: "mp3_44100_128",
    });

    const audioChunks: Uint8Array[] = [];
    for await (const chunk of audioResponse as any) {
      audioChunks.push(new Uint8Array(chunk));
    }
    const audioBuffer = Buffer.concat(audioChunks);

    // Save locally too (for ffmpeg concat later)
    const localAudioPath = resolve(workDir, `scene-${sceneNum}-audio.mp3`);
    writeFileSync(localAudioPath, audioBuffer);

    scene.audioUrl = await fal.storage.upload(
      new Blob([audioBuffer], { type: "audio/mpeg" })
    );
    console.error(`[scene ${sceneNum}] Audio ready (${audioBuffer.length} bytes)`);
  }

  // ── Step B: First Frame ────────────────────────────────────────
  if (!scene.firstFrameUrl) {
    if (scene.referenceImage && existsSync(scene.referenceImage)) {
      // Use reference image directly (screenshot, etc.)
      console.error(`[scene ${sceneNum}] Uploading reference image: ${scene.referenceImage}`);
      scene.firstFrameUrl = await uploadFile(scene.referenceImage, "image/png");
    } else if (avatarBuffer) {
      // Generate with Seedream using avatar
      console.error(`[scene ${sceneNum}] Generating first frame with Seedream...`);
      const avatarUrl = await fal.storage.upload(
        new Blob([avatarBuffer], { type: "image/jpeg" })
      );
      const result = await fal.subscribe(
        "fal-ai/bytedance/seedream/v4.5/edit" as any,
        {
          input: {
            prompt: `Generate an image based on the character in Figure 1. ${scene.firstFrame}`,
            image_urls: [avatarUrl],
          } as any,
          logs: false,
        }
      );
      const data = result.data as any;
      scene.firstFrameUrl = data?.images?.[0]?.url ?? data?.image?.url;
    } else {
      // No avatar — use Seedream without reference
      console.error(`[scene ${sceneNum}] Generating first frame (no avatar)...`);
      const result = await fal.subscribe(
        "fal-ai/bytedance/seedream/v4.5" as any,
        {
          input: { prompt: scene.firstFrame } as any,
          logs: false,
        }
      );
      const data = result.data as any;
      scene.firstFrameUrl = data?.images?.[0]?.url ?? data?.image?.url;
    }

    if (!scene.firstFrameUrl) {
      console.error(`[scene ${sceneNum}] ERROR: No first frame URL generated`);
      saveCheckpoint({ scenes, completedScenes: i, timestamp: Date.now() });
      process.exit(1);
    }
    console.error(`[scene ${sceneNum}] First frame ready: ${scene.firstFrameUrl}`);
  }

  // ── Step C: Video ──────────────────────────────────────────────
  if (!scene.videoUrl) {
    console.error(`[scene ${sceneNum}] Generating video with LTX-2...`);
    const result = await fal.subscribe(
      "fal-ai/ltx-2-19b/audio-to-video" as any,
      {
        input: {
          image_url: scene.firstFrameUrl,
          audio_url: scene.audioUrl,
          prompt: scene.videoPrompt,
          match_audio_length: true,
          aspect_ratio: aspectRatio,
          use_multiscale: true,
        } as any,
        logs: false,
      }
    );
    const data = result.data as any;
    scene.videoUrl = data?.video?.url;

    if (!scene.videoUrl) {
      console.error(`[scene ${sceneNum}] ERROR: No video URL generated`);
      console.error(JSON.stringify(data, null, 2));
      saveCheckpoint({ scenes, completedScenes: i, timestamp: Date.now() });
      process.exit(1);
    }
    console.error(`[scene ${sceneNum}] Video ready: ${scene.videoUrl}`);
  }

  // Download video locally for concat
  const localVideoPath = resolve(workDir, `scene-${sceneNum}.mp4`);
  if (!existsSync(localVideoPath)) {
    downloadFile(scene.videoUrl, localVideoPath);
    console.error(`[scene ${sceneNum}] Downloaded to ${localVideoPath}`);
  }

  // Save checkpoint after each scene
  saveCheckpoint({ scenes, completedScenes: i + 1, timestamp: Date.now() });
}

// ── Concat all scenes with ffmpeg ────────────────────────────────

console.error(`\n${"=".repeat(60)}`);
console.error(`[concat] Stitching ${scenes.length} scenes together...`);

// Build ffmpeg concat file
const concatListPath = resolve(workDir, "concat.txt");
const concatLines = scenes.map((_, i) => {
  const videoPath = resolve(workDir, `scene-${i + 1}.mp4`);
  return `file '${videoPath}'`;
});
writeFileSync(concatListPath, concatLines.join("\n"));

// Output path
const outputPath = args.out
  ? resolve(args.out)
  : resolve(workDir, "final-output.mp4");

// First pass: concat with stream copy (fast, works if all clips have same codec/resolution)
try {
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}" 2>&1`,
    { timeout: 120_000 }
  );
  console.error(`[concat] Fast concat succeeded`);
} catch {
  // Fallback: re-encode (handles different codecs/resolutions)
  console.error(`[concat] Stream copy failed, re-encoding...`);
  
  // Determine target resolution from aspect ratio
  let scale = "1080:1920"; // portrait default
  if (aspectRatio.includes("landscape") || aspectRatio.includes("16_9")) {
    scale = "1920:1080";
  } else if (aspectRatio.includes("4_3")) {
    scale = "1440:1080";
  }

  // Build filter complex for scaling + padding each input to same size
  const inputs = scenes.map((_, i) => `-i "${resolve(workDir, `scene-${i + 1}.mp4`)}"`).join(" ");
  const filters = scenes.map((_, i) => 
    `[${i}:v]scale=${scale}:force_original_aspect_ratio=decrease,pad=${scale}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`
  ).join("; ");
  const videoConcat = scenes.map((_, i) => `[v${i}]`).join("") + `concat=n=${scenes.length}:v=1:a=0[outv]`;
  const audioConcat = scenes.map((_, i) => `[${i}:a]`).join("") + `concat=n=${scenes.length}:v=0:a=1[outa]`;

  execSync(
    `ffmpeg -y ${inputs} -filter_complex "${filters}; ${videoConcat}; ${audioConcat}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k "${outputPath}" 2>&1`,
    { timeout: 300_000 }
  );
  console.error(`[concat] Re-encode concat succeeded`);
}

console.error(`[done] Final video: ${outputPath}`);

// Clear checkpoint on success
clearCheckpoint();

// ── Output ───────────────────────────────────────────────────────

const result = {
  outputPath,
  sceneCount: scenes.length,
  scenes: scenes.map((s, i) => ({
    scene: i + 1,
    firstFrameUrl: s.firstFrameUrl,
    videoUrl: s.videoUrl,
  })),
};

console.log(JSON.stringify(result, null, 2));

// ── Notify (optional) ────────────────────────────────────────────

if (args.notify) {
  const channel = args.notifyChannel || "whatsapp";

  // Upload the final video as media
  try {
    console.error(`[notify] Sending final video to ${args.notify} via ${channel}...`);
    const message = `🎬 Multi-scene Short ready! (${scenes.length} scenes)`;
    execSync(
      `openclaw message send --channel ${channel} --target "${args.notify}" --message "${message}" --media "${outputPath}"`,
      { stdio: "inherit", timeout: 60_000 }
    );
    console.error(`[notify] Sent!`);
  } catch (err) {
    console.error(`[notify] Failed to send: ${err}`);
    // Also try sending just the scene URLs as fallback
    try {
      const urls = scenes.map((s, i) => `Scene ${i + 1}: ${s.videoUrl}`).join("\n");
      const fallbackMsg = `🎬 Multi-scene Short ready! (${scenes.length} scenes)\n\n${urls}\n\nLocal file: ${outputPath}`;
      execSync(
        `openclaw message send --channel ${channel} --target "${args.notify}" --message "${fallbackMsg.replace(/"/g, '\\"')}"`,
        { stdio: "inherit", timeout: 30_000 }
      );
    } catch {}
  }
}
