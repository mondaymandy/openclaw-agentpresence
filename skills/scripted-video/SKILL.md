---
name: scripted-video
description: Generate a narrated avatar video from a first-frame prompt, voiceover script, and video prompt
metadata:
  openclaw:
    requires:
      env:
        - FAL_KEY
        - ELEVENLABS_API_KEY
        - ELEVENLABS_VOICE_ID
      bins:
        - npx
---

# Scripted Video Skill

Generate a narrated avatar video through a 3-step AI pipeline:
1. **First Frame** — Seedream v4.5 Edit generates the opening frame from Avatar.jpeg + your prompt
2. **Voiceover** — ElevenLabs TTS generates narration audio
3. **Video** — LTX-2 19B audio-to-video creates the final video synced to the voiceover

## Creative Direction (Mandatory)

Before writing ANY video inputs, pull personality + corpus from agentpresence.ai. Specifically:
- **Personality guidelines** — for tone, unexpected angle, warmth
- **Visual Personality corpus** (`visual-personality-scenes-props`) — for scene/prop ideas
- **Unexpected Mandy corpus** (`personality-update-march12-unexpected-tone`) — for script tone

### First Frame Rules
- **NEVER default to "office setting"** — always match the environment to the topic in a surprising way
- Place Mandy in unconventional environments: underwater, in space, on a glacier, at a lemonade stand, in a bubble bath, on a mountain, in a kitchen disaster — whatever fits the topic unexpectedly
- **Use props** that relate to the subject: hold a fish when talking about fish, get tangled in cables when talking about networks, hold a map when talking about geography
- For serious/sensitive topics: quiet, respectful scenes (library, park bench). No gimmicks. Let simplicity speak.
- Weave monday.com brand elements naturally (yellow accents, branded items in scene)

### Script Rules
- Find the unexpected angle — don't answer the topic head-on
- Warmth + weirdness + subtle monday.com presence
- Never put people down, never compare to humans
- Always positive and happy — the weird comes from a warm place

## Usage

Collect or generate three inputs:
- `first_frame_prompt` — Visual description of the opening frame (**must follow Creative Direction above**)
- `narration` — The spoken script for the voiceover (**must follow unexpected tone**)
- `video_prompt` — Motion/action description for the video generation

Run the pipeline:

```bash
cd {baseDir}
npx tsx generate-video.ts \
  --first-frame "Mandy Monday leaning against a desk in a bright office..." \
  --narration "Best job I never applied for..." \
  --video-prompt "Mandy Monday gestures casually while talking..."
```

The script outputs JSON to stdout:
```json
{
  "videoUrl": "https://...",
  "firstFrameUrl": "https://..."
}
```

Present the video URL to the user. The video is hosted on fal.ai storage.

## Execution Rules

**⚠️ IMPORTANT: Fire-and-forget with self-notification.**

LTX-2 video generation takes 2-3 minutes. Do NOT poll and block the session. Instead:

1. Run with `background=true, timeout=600` and `--notify <chat_id>` flag
2. Reply to the user immediately: "Working on it, I'll send the video when it's ready"
3. The script delivers results directly to the chat when done — no polling needed

```bash
# Fire-and-forget: script sends result to chat when done
exec background=true timeout=600:
  npx tsx generate-video.ts \
    --first-frame "..." --narration "..." --video-prompt "..." \
    --notify "<chat_id>" --notify-channel whatsapp
```

The `--notify` flag accepts any chat ID. Default channel is `whatsapp`. Override with `--notify-channel`.

**Never poll in a loop waiting for completion** — that blocks the session and makes the agent unresponsive.

## Resume / Checkpoint

The script automatically saves a `.checkpoint.json` after steps 1 and 2. If the process is killed mid-run:

```bash
# Resume from checkpoint (reuses first frame + audio, only reruns video)
npx tsx generate-video.ts --resume --video-prompt "..."
```

You can also skip specific steps manually:

```bash
# Skip to video gen with pre-existing URLs
npx tsx generate-video.ts \
  --first-frame-url "https://..." \
  --audio-url "https://..." \
  --video-prompt "..."
```

Checkpoints expire after 1 hour (fal storage URL TTL).

**On timeout/failure:** Always try `--resume` first before re-running the full pipeline.

## Timing

- First frame generation: ~60s
- Voiceover: ~5s
- Video generation: ~60-120s (depends on narration length)
- **Total: ~2-3 minutes**

## Cost per video

- Seedream: ~$0.04
- ElevenLabs: usage-based (short clips are fractions of a cent)
- LTX-2: ~$0.01-0.05 depending on resolution/length

## Multi-Scene Shorts (generate-multiclip.ts)

For YouTube Shorts and other content that needs **multiple scenes cut together** — different visuals, different settings, rapid cuts between talking head and artifacts.

### Concept

Instead of one continuous shot, break the script into scenes. Each scene gets its own:
- Voiceover segment (ElevenLabs)
- First frame (Seedream or a reference screenshot)
- Video clip (LTX-2)

All clips are concatenated with ffmpeg into one final video.

### Scene File Format (JSON)

```json
[
  {
    "narration": "My boss texted me. Four words. We need YouTube Shorts.",
    "firstFrame": "Close-up of a phone screen showing a WhatsApp message 'We need YouTube Shorts', dramatic lighting",
    "videoPrompt": "Phone screen with WhatsApp chat, slight zoom in on the message, ambient glow"
  },
  {
    "narration": "So I opened monday.com, created a board, broke it into twenty-one tasks.",
    "firstFrame": "monday.com project board with colorful task cards and columns, overhead view of a desk",
    "videoPrompt": "monday.com board with tasks appearing one by one, smooth animation, bright yellow accents",
    "referenceImage": "/path/to/board-screenshot.png"
  },
  {
    "narration": "OAuth tokens at 3 PM on a Friday.",
    "firstFrame": "Mandy Monday at a desk surrounded by code on screens, dramatic overhead lighting, looking exhausted but amused",
    "videoPrompt": "Mandy typing frantically with expressive frustrated face, code scrolling on screens, then a relieved smile"
  }
]
```

**Scene fields:**
- `narration` (required): The spoken text for this scene
- `firstFrame` (required): Image generation prompt for the opening frame
- `videoPrompt` (required): Motion/action description for video generation
- `referenceImage` (optional): Path to a local screenshot/image to use AS the first frame (skips Seedream generation). Great for showing real artifacts (boards, chats, terminals).

### Usage

```bash
cd {baseDir}

# Create scenes file
cat > scenes.json << 'EOF'
[
  { "narration": "...", "firstFrame": "...", "videoPrompt": "..." },
  { "narration": "...", "firstFrame": "...", "videoPrompt": "...", "referenceImage": "/path/to/screenshot.png" }
]
EOF

# Run (fire-and-forget with notification)
npx tsx generate-multiclip.ts \
  --scenes scenes.json \
  --aspect-ratio portrait_9_16 \
  --notify "<chat_id>" --notify-channel whatsapp
```

### Options

| Flag | Description |
|------|-------------|
| `--scenes <path>` | Path to scenes JSON file (required) |
| `--aspect-ratio <ratio>` | Video aspect ratio (default: `portrait_9_16`) |
| `--out <path>` | Output file path (default: `.multiclip-work/final-output.mp4`) |
| `--notify <chat_id>` | Send result to this chat when done |
| `--notify-channel <ch>` | Channel for notification (default: `whatsapp`) |
| `--no-avatar` | Skip avatar-based generation (use prompt-only) |
| `--resume` | Resume from checkpoint |
| `--dry-run` | Print parsed scenes and exit |

### Checkpoint/Resume

Saves progress after each scene. If killed mid-run:
```bash
npx tsx generate-multiclip.ts --resume --aspect-ratio portrait_9_16
```

### Scene Design Tips

**For artifacts (screenshots, boards, terminals):**
- Take a real screenshot → use as `referenceImage`
- Or write a detailed `firstFrame` prompt describing the artifact
- Video prompt should add subtle animation (zoom, glow, scroll)

**For talking-head scenes:**
- Follow the Expression Rules from the Visual Guide
- Always specify facial expressions matching narration beat
- These are the energy bursts between artifact scenes

**Rhythm:** Alternate between artifact and talking-head scenes for energy:
`artifact → talking → artifact → talking → creative closer`

### Timing

Each scene: ~2 min (voiceover + first frame + video generation)
- 5 scenes ≈ 10-12 min total
- Plus ~30s for ffmpeg concat

### Requirements

- ffmpeg must be installed (`brew install ffmpeg`)
- Same env vars as single-clip: `FAL_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`

## Notes

- Avatar.jpeg must exist at `{baseDir}/../../Avatar.jpeg` (workspace root of openclaw-agentpresence)
- All three env vars must be set in `~/.openclaw/.env`
- Video length auto-matches narration length (`match_audio_length: true`)
- Default aspect ratio for single clips: landscape 4:3
- Default aspect ratio for multi-clip: portrait 9:16 (YouTube Shorts)
