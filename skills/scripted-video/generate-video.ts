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
    } else if (arg === "--no-appearance") {
      args.noAppearance = "true";
    } else if (arg === "--no-validate") {
      args.noValidate = "true";
    } else if (arg === "--max-retries" && argv[i + 1]) {
      args.maxRetries = argv[++i];
    } else if (arg === "--scene" && argv[i + 1]) {
      args.scene = argv[++i];
    } else if (arg === "--logo-placement" && argv[i + 1]) {
      args.logoPlacement = argv[++i];
    } else if (arg === "--resume") {
      args.resume = "true";
    } else if (arg === "--dry-run") {
      args.dryRun = "true";
    }
  }
  return args;
}

const args = parseArgs(process.argv);

// ── Load appearance template ─────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

interface AppearanceConfig {
  locked_appearance: string;
  logo_placements: string[];
  video_motion: string;
  validation_checks: string[];
  style_notes: string;
}

const appearancePath = resolve(__dirname, "appearance.json");
let appearance: AppearanceConfig | null = null;
try {
  appearance = JSON.parse(readFileSync(appearancePath, "utf-8"));
} catch {
  console.error("[appearance] No appearance.json found, running without appearance template");
}

// ── Build prompts with appearance template ───────────────────────

function buildFirstFramePrompt(scenePrompt: string, logoPlacement?: string): string {
  if (args.noAppearance || !appearance) return scenePrompt;

  const logo = logoPlacement
    || appearance.logo_placements[Math.floor(Math.random() * appearance.logo_placements.length)];

  return `${appearance.locked_appearance}, ${scenePrompt}, ${logo}, Pixar style 3D animation`;
}

function buildVideoPrompt(motionPrompt: string): string {
  if (args.noAppearance || !appearance) return motionPrompt;

  return `3D animated young woman with dark brown braided hair and purple lavender jacket, ${appearance.video_motion}, ${motionPrompt}`;
}

// ── Validation ───────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function validateFirstFrame(imageUrl: string): Promise<{ passed: boolean; failures: string[]; details: string }> {
  if (!appearance) return { passed: true, failures: [], details: "No appearance config" };

  // Use OpenAI GPT-4o vision for validation
  if (!OPENAI_API_KEY) {
    console.error("[validate] No OPENAI_API_KEY — skipping validation");
    return { passed: true, failures: [], details: "No API key for validation" };
  }

  const checks = appearance.validation_checks;
  const prompt = `You are a quality control checker for AI-generated images of a character called "Mandy Monday".

Check this image against EACH of these criteria and respond with a JSON object:

${checks.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Respond ONLY with valid JSON in this exact format:
{
  "results": [
    {"check": "description", "passed": true/false, "note": "brief explanation"}
  ],
  "all_passed": true/false,
  "summary": "one line summary"
}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
        max_tokens: 500,
      }),
    });

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || "";

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[validate] Could not parse validation response");
      return { passed: true, failures: [], details: content };
    }

    const validation = JSON.parse(jsonMatch[0]);
    const failures = (validation.results || [])
      .filter((r: any) => !r.passed)
      .map((r: any) => r.check + ": " + r.note);

    return {
      passed: validation.all_passed === true,
      failures,
      details: validation.summary || "",
    };
  } catch (err) {
    console.error(`[validate] Validation API error: ${err}`);
    return { passed: true, failures: [], details: "Validation error — proceeding" };
  }
}

// ── Input validation ─────────────────────────────────────────────

const hasResumeInputs = args.firstFrameUrl && args.audioUrl;
if (!hasResumeInputs && !args.resume) {
  // With --scene, we build the first-frame prompt from appearance + scene
  if (args.scene && !args.firstFrame) {
    args.firstFrame = args.scene; // Will be wrapped by buildFirstFramePrompt
  }
  if (!args.firstFrame || !args.narration || !args.videoPrompt) {
    console.error(
      "Usage: npx tsx generate-video.ts --first-frame <prompt> --narration <script> --video-prompt <prompt>\n" +
      "  Or:   --scene <scene description> --narration <script> --video-prompt <motion prompt>\n" +
      "  Resume: --resume (uses checkpoint file)\n" +
      "  Skip to video: --first-frame-url <url> --audio-url <url> --video-prompt <prompt>\n" +
      "  Options:\n" +
      "    --no-appearance    Skip appearance template injection\n" +
      "    --no-validate      Skip image validation loop\n" +
      "    --max-retries N    Max retries for validation (default: 3)\n" +
      "    --logo-placement   Specific logo placement (overrides random)\n" +
      "    --scene            Scene description (appearance auto-prepended)"
    );
    process.exit(1);
  }
}

if (args.dryRun) {
  const ffPrompt = buildFirstFramePrompt(args.firstFrame || args.scene || "", args.logoPlacement);
  const vpPrompt = buildVideoPrompt(args.videoPrompt || "");
  console.log(
    JSON.stringify({
      dryRun: true,
      firstFramePrompt: ffPrompt,
      narration: args.narration,
      videoPrompt: vpPrompt,
      aspectRatio: args.aspectRatio || "landscape_4_3",
      validate: args.noValidate !== "true",
      maxRetries: parseInt(args.maxRetries || "3"),
      appearance: !!appearance,
      resume: !!args.resume,
    }, null, 2)
  );
  process.exit(0);
}

// ── Environment ──────────────────────────────────────────────────

const FAL_KEY = process.env.FAL_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!FAL_KEY) { console.error("Missing FAL_KEY env var"); process.exit(1); }
if (!ELEVENLABS_API_KEY) { console.error("Missing ELEVENLABS_API_KEY env var"); process.exit(1); }
if (!ELEVENLABS_VOICE_ID) { console.error("Missing ELEVENLABS_VOICE_ID env var"); process.exit(1); }

fal.config({ credentials: FAL_KEY });
const eleven = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });

// ── Checkpoint ───────────────────────────────────────────────────

const checkpointPath = resolve(__dirname, ".checkpoint.json");

interface Checkpoint {
  firstFrameUrl?: string;
  audioUrl?: string;
  videoPrompt?: string;
  firstFrame?: string;
  narration?: string;
  validated?: boolean;
  timestamp: number;
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (existsSync(checkpointPath)) {
      const data = JSON.parse(readFileSync(checkpointPath, "utf-8"));
      if (Date.now() - data.timestamp < 3600_000) return data;
      console.error("[checkpoint] Expired (>1h old), starting fresh");
      unlinkSync(checkpointPath);
    }
  } catch { /* ignore */ }
  return null;
}

function saveCheckpoint(cp: Partial<Checkpoint>) {
  const existing = loadCheckpoint() ?? { timestamp: Date.now() };
  const merged = { ...existing, ...cp, timestamp: Date.now() };
  writeFileSync(checkpointPath, JSON.stringify(merged, null, 2));
  console.error(`[checkpoint] Saved: ${Object.keys(cp).join(", ")}`);
}

function clearCheckpoint() {
  try { if (existsSync(checkpointPath)) unlinkSync(checkpointPath); } catch { /* ignore */ }
}

// ── Resolve starting state ───────────────────────────────────────

let firstFrameUrl: string | undefined = args.firstFrameUrl;
let audioUrl: string | undefined = args.audioUrl;
let videoPrompt: string = args.videoPrompt ?? "";

if (args.resume) {
  const cp = loadCheckpoint();
  if (!cp) { console.error("[resume] No valid checkpoint found."); process.exit(1); }
  firstFrameUrl = firstFrameUrl ?? cp.firstFrameUrl;
  audioUrl = audioUrl ?? cp.audioUrl;
  videoPrompt = videoPrompt || cp.videoPrompt || "";
  if (!args.firstFrame && cp.firstFrame) args.firstFrame = cp.firstFrame;
  if (!args.narration && cp.narration) args.narration = cp.narration;
  console.error(`[resume] Loaded checkpoint — firstFrame: ${!!firstFrameUrl}, audio: ${!!audioUrl}, validated: ${cp.validated}`);
}

// ── Resolve Avatar path ──────────────────────────────────────────

const avatarPath = resolve(__dirname, "..", "..", "Avatar.jpeg");
let avatarBuffer: Buffer | null = null;
if (!firstFrameUrl) {
  try { avatarBuffer = readFileSync(avatarPath); }
  catch { console.error(`Avatar.jpeg not found at ${avatarPath}`); process.exit(1); }
}

// ── Step 1: First Frame (Seedream v4.5 Edit) + Validation Loop ──

const maxRetries = parseInt(args.maxRetries || "3");
const shouldValidate = args.noValidate !== "true" && !!OPENAI_API_KEY;

if (firstFrameUrl) {
  console.error(`[1/3] Skipping first frame (using provided URL)`);
} else {
  console.error("[1/3] Generating first frame with Seedream v4.5...");

  const avatarUrl = await fal.storage.upload(
    new Blob([avatarBuffer!], { type: "image/jpeg" })
  );

  let validated = false;
  let attempt = 0;
  let currentPrompt = buildFirstFramePrompt(args.firstFrame, args.logoPlacement);

  while (!validated && attempt < maxRetries + 1) {
    attempt++;
    if (attempt > 1) {
      console.error(`[1/3] Retry ${attempt - 1}/${maxRetries} — strengthening prompt...`);
    }

    console.error(`[1/3] Attempt ${attempt} — prompt: ${currentPrompt.substring(0, 120)}...`);

    const firstFrameResult = await fal.subscribe(
      "fal-ai/bytedance/seedream/v4.5/edit" as any,
      {
        input: {
          prompt: `Generate an image based on the character in Figure 1. ${currentPrompt}`,
          image_urls: [avatarUrl],
        } as any,
        logs: false,
      }
    );

    const firstFrameData = firstFrameResult.data as any;
    firstFrameUrl = firstFrameData?.images?.[0]?.url ?? firstFrameData?.image?.url;

    if (!firstFrameUrl) {
      console.error("Seedream returned no image URL");
      console.error(JSON.stringify(firstFrameData, null, 2));
      process.exit(1);
    }

    console.error(`[1/3] First frame generated: ${firstFrameUrl}`);

    // ── Validation ──
    if (shouldValidate) {
      console.error(`[validate] Checking image (attempt ${attempt})...`);
      const validation = await validateFirstFrame(firstFrameUrl);

      if (validation.passed) {
        console.error(`[validate] ✅ All checks passed: ${validation.details}`);
        validated = true;
      } else {
        console.error(`[validate] ❌ Failed checks:`);
        validation.failures.forEach((f) => console.error(`  - ${f}`));

        if (attempt <= maxRetries) {
          // Strengthen the prompt based on failures
          const failureHints = validation.failures.map((f) => {
            if (f.toLowerCase().includes("logo")) return "monday.com logo MUST be clearly visible";
            if (f.toLowerCase().includes("purple") || f.toLowerCase().includes("jacket")) return "character MUST wear purple lavender zip-up jacket";
            if (f.toLowerCase().includes("braid")) return "character MUST have dark brown braided hair";
            return "";
          }).filter(Boolean).join(", ");

          if (failureHints) {
            currentPrompt = `CRITICAL REQUIREMENTS: ${failureHints}. ${currentPrompt}`;
          }
        } else {
          console.error(`[validate] Max retries reached — proceeding with best attempt`);
          validated = true; // Proceed anyway
        }
      }
    } else {
      validated = true;
    }
  }

  console.error(`[1/3] First frame ready: ${firstFrameUrl}`);
  saveCheckpoint({
    firstFrameUrl,
    firstFrame: args.firstFrame,
    narration: args.narration,
    videoPrompt,
    validated: true,
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

  const audioChunks: Uint8Array[] = [];
  for await (const chunk of audioResponse as any) {
    audioChunks.push(new Uint8Array(chunk));
  }
  const audioBuffer = Buffer.concat(audioChunks);

  console.error(`[2/3] Voiceover generated (${audioBuffer.length} bytes)`);

  audioUrl = await fal.storage.upload(
    new Blob([audioBuffer], { type: "audio/mpeg" })
  );

  console.error(`[2/3] Audio uploaded: ${audioUrl}`);
  saveCheckpoint({
    firstFrameUrl,
    audioUrl,
    firstFrame: args.firstFrame,
    narration: args.narration,
    videoPrompt,
    validated: true,
  });
}

// ── Step 3: Video (LTX-2 19B Audio-to-Video) ────────────────────

console.error("[3/3] Generating video with LTX-2 19B...");

const finalVideoPrompt = buildVideoPrompt(videoPrompt);
console.error(`[3/3] Video prompt: ${finalVideoPrompt.substring(0, 120)}...`);

const videoResult = await fal.subscribe(
  "fal-ai/ltx-2-19b/audio-to-video" as any,
  {
    input: {
      image_url: firstFrameUrl,
      audio_url: audioUrl,
      prompt: finalVideoPrompt,
      match_audio_length: true,
      video_size: args.aspectRatio || "landscape_4_3",
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
  }
}
