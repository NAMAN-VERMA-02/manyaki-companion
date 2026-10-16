# Manyaki 💗

A 3D desktop companion that lives on your Windows desktop: she walks along the taskbar, hops onto the window you're working in, talks with you by voice, reacts with cute expressions, and keeps you going with focus sessions, goals and gentle nudges.

Built with Electron, three.js, `@pixiv/three-vrm`, Gemini Live and Silero VAD. Her model is `assets/models/Manyaki.vrm`, a VRM 1.0 avatar.

## Install

To share her, use the installer: run `release/Manyaki Setup 0.1.0.exe` (build it with `npm run dist`).

From source:

```bash
npm install
npm run dev
```

On first launch the Settings window opens:

1. **Gemini key (free).** Go to https://aistudio.google.com/apikey, create a key and paste it in. It is encrypted with Windows (DPAPI) and stays on your PC.
2. **Microphone mode:**
   - Hands-free: she hears you whenever you speak.
   - Hotkey: press `Ctrl+Alt+Space`, then talk.
   - Off: double-click her to type.

## Using her

| Do this | She… |
|---|---|
| Talk (hands-free or `Ctrl+Alt+Space`) | answers out loud, with lip-sync and expressions. Interrupt her any time by speaking or clicking her |
| Double-click her | opens a chat box |
| Pat her head | gets a headpat: closes her eyes, blushes, ♥ |
| Poke her body | giggles and hops. Poke too much and she pouts 💢 |
| Drag her | dangles from your cursor. Throw her and she falls, bounces and lands |
| "Let's focus for 40 minutes" | starts a focus timer, watches quietly, cheers at the end and starts your break |
| "Add 'revise graphs' to my goals" / "I finished the graphs one" | manages today's goals and celebrates each one |
| Open YouTube during a focus session | teases you after a few minutes, then gets firmer |
| Work steadily for ~50 min | tells you she's proud of you and suggests water and a stretch |
| Step away | she naps 💤 and welcomes you back when you return |

The tray icon offers talk, type, mic mode, focus start/stop, do-not-disturb, "send her to the corner", size, settings, launch at login and quit.

## Animations (optional, recommended)

She ships with hand-made procedural motions. For smoother motion-capture movement, download free clips from [Mixamo](https://www.mixamo.com) and drop them in either location:

- `assets/anims/` (when running from source), or
- `%APPDATA%\manyaki-companion\anims\` (installed app).

Download settings: **FBX Binary, Without Skin, 30 fps**. Tick **In Place** for walking and running. Any character works; the clips are retargeted to her at load time. `.vrma` files are supported too.

The file name decides which motion a clip replaces:

| Slot | File-name keywords (examples) |
|---|---|
| idle | `Idle.fbx`, `Breathing Idle.fbx` |
| idleHappy | `Happy Idle.fbx` |
| walk / run | `Walking.fbx`, `Running.fbx` |
| jump / fall / land | `Jump.fbx`, `Falling Idle.fbx`, `Landing.fbx` |
| dangle | `Hanging Idle.fbx` |
| sit / sitToStand | `Sitting Idle.fbx`, `Sit To Stand.fbx` |
| wave / nod / shake | `Waving.fbx`, `Nodding.fbx`, `Shaking Head No.fbx` |
| think / talk / listen | `Thinking.fbx`, `Talking.fbx`, `Listening.fbx` |
| cheer / shy / pout | `Excited.fbx`, `Bashful.fbx`, `Angry.fbx` |
| stretch / sleep / clap / dance | `Stretching.fbx`, `Sleeping Idle.fbx`, `Clapping.fbx`, `Dancing.fbx` |

Restart her after adding clips. In debug mode, clips loaded from files are marked with `*`.

## How she works

```
electron/   main process: small transparent always-on-top window, tray, hotkey, encrypted key,
            store, active-window watcher (get-windows) + app classifier
src/stage.ts         render loop, click-through hit test, window-follows-her, pointer & drag
src/core/avatar.ts   VRM at real scale, orthographic camera mapped to screen pixels
src/core/anim/       procedural clips, Mixamo/VRMA retargeting, crossfades, look-at/breathing layers
src/core/behavior.ts walking, perching on windows, physics (drag/throw/fall), sleep, autonomy
src/core/expressions.ts  emotion blends, blinking, lip-sync visemes; fx.ts: blush + emotes
src/core/voice/      Silero VAD mic, audio playback/lip-sync level, fallback voices
src/core/brain/      Gemini Live session + tools, text fallback, persona, memory logic
src/core/motivation.ts   when to speak up (pure, unit-tested), focus timer
src/companion.ts     wires ears, voice, brain, memory and motivation to her body
```

### Voice

| Situation | What happens |
|---|---|
| Normal | Gemini Live: audio in, her voice out in about a second; she can be interrupted. Her expressions and gestures come from a `react` tool the model calls while talking. |
| Live unavailable | Gemini Flash replies; Gemini TTS speaks them in the same voice. |
| No key, or offline | Pre-written lines in Windows' voice. |

Kokoro (a local neural voice) can be turned on in Settings, but on integrated graphics it takes several seconds per sentence.

### Memory

Kept in `%APPDATA%\manyaki-companion\manyaki.json`:

- your name
- facts about you (extracted from conversations every ~8 turns)
- today's goals
- your streaks
- the last few turns of conversation

You can view, export or wipe all of it in Settings.

### Privacy

- Audio only leaves your PC after the on-device voice detector hears speech.
- By default only the app name ("VS Code", "YouTube") is shared, never full window titles. You can opt in to sharing titles.
- Conversations go to Google's Gemini API. On the free tier, Google may use them to improve its products.

## Development

```bash
npm run dev                         # hot reload
npx electron-vite dev -- --manyaki-debug   # full-screen overlay + debug panel: every clip/emotion/emote, fps, latency
npm test                            # unit tests (classifier, memory, motivation, tools, persona)
npm run typecheck
npm run dist                        # Windows installer in release/
```

## Performance notes

Measured on this laptop (Intel UHD iGPU, 8 threads):

- **Window size:** a transparent always-on-top window on Windows costs CPU per frame and per pixel. So she lives in a small window that follows her, not a full-screen overlay.
- **Frame rate follows activity:**
  - 60 fps walking or being dragged
  - 30 fps talking
  - 12 fps idle
  - 10 fps sitting
  - 6 fps asleep
- **Measured idle cost:**
  - Rendering: roughly 4% of one core per fps.
  - Hands-free mic: about 30% of one core more.
  - If you want her lighter, use hotkey mic mode; the mic is then only active while you're talking.

## Known limitations

- **Primary display only.**
- **Gemini free tier.** Limits apply. When Live is rate-limited she switches to the fallback path for a while.
- **Fullscreen apps.** She hides during fullscreen games and videos (detected by the window covering the whole display).
