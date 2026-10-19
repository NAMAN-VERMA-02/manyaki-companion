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
| "Mera Downloads folder khol do" / "open VS Code" / "lofi on youtube" | pulls out her little pink laptop and opens it |
| "Recursion samjhao" / "how does crosshair placement work?" | teaches step by step with small examples, checks you got it, offers a quick quiz |
| `Ctrl+Alt+E` or "dekho screen pe ye kya error hai" | looks at your screen **once** and walks you through it (online only) |
| Launch a game | "GLHF!"; after a long session: "GG — how'd it go?" plus a stretch/water nudge |

**Manyaki Home** is her control window. It opens on start, or from the tray icon or by right-clicking her, and has:

- live status
- quick toggles: mic, mute, Do not disturb, Private mode, Stream-safe, hide, reset
- the focus timer
- chat with history
- today's goals
- all settings

Closing Home only hides it. If she ever gets lost, **🔄 Reset her** puts her back on the taskbar.

## Brain, offline & privacy

| Mode | How it works |
|---|---|
| **Auto** (default) | **Gemini Live** when online: natural voice, about 1 s replies, interruptible. When there's no internet, her **offline brain** takes over. |
| **🔒 Private** | Everything runs on this PC; nothing is sent to Google. |

The **offline brain** is a one-time download of about 2.5 GB, done from Settings → Brain & privacy. It runs in its own background process:

- **Thinking:** Qwen2.5-3B (llama.cpp).
- **Hearing:** Whisper small, which understands Hindi and Hinglish.
- **Voice:** Kokoro. She measures its speed and falls back to the instant Windows voice if your CPU can't keep up; Hindi always uses the Windows voice.

Speed on a laptop i3: about 3–5 s per typed reply and about 6–8 s per spoken turn. The first reply after start takes about 30 s while the model loads.

Privacy protections, in every mode:

- **Encrypted memory.** Your name, remembered facts, goals and chat history are encrypted on disk with Windows DPAPI.
- **Personal details masked.** Before anything goes to Gemini, emails, phone numbers, Aadhaar/PAN, card numbers, keys and passwords, and your user-folder paths are replaced with placeholders. Less chat history is sent on the cloud path than locally.
- **Prompt-injection guards:**
  - Window titles, file and folder names, remembered facts and tool results are wrapped and sanitised as *data*.
  - She opens things only right after **you** asked, never because of an event or something on screen, and at most a few times a minute.
  - "Facts" that are really instructions are never saved.
  - Offline, actions come only from fixed rules applied to your own words.
- **Screenshots only on request.** One screenshot is taken only when you ask, is never saved, and is never taken in Private mode.

## Her hands and eyes 🖐️👀

She can work your computer like a person at the keyboard. Just ask: *"close all the Chrome windows and snap VS Code to the left"*, *"open Spotify and play"*, *"fill this form with my email"*.

- **Windows:** switch, close (apps still ask to save), minimise, maximise, snap left/right/top/bottom or centre.
- **Any app's controls:** buttons, fields, tabs and menus are read through Windows UI Automation (the same tree screen readers use), so she presses and types into them by id. Where an app has none, she clicks visible text.
- **Keys and mouse:** shortcuts (`ctrl+s`, `alt+tab`, `win+d`, media keys), Unicode typing (Hindi and emoji too), clicks and scrolling.
- **She always sees the screen.** The window in front is read every few seconds with Windows' built-in on-device OCR, private details are masked, and only the latest look is kept, in memory. Password managers, banking and private-browsing windows are never read. If an error shows up while you work, she offers to help.
- **Privacy shield (one switch).** When it's on, anything about your screen that goes to Gemini, a screenshot or text she read, has your private details found and hidden on this PC first. Screenshots get black boxes word by word. Details she types back (your email in a form) go in as tokens and are filled in locally.
- **Safety.** She acts only in a short task window after you ask: nothing on screen can make her act. Typing in a terminal or the Run box, pressing Enter there, or closing a window with unsaved changes pops up a confirmation.

## Memory 🧠

Her memory is a list of short bullets kept encrypted on your PC. None of it is pasted into the brain's instructions. When an answer depends on the past, she searches the bullets ("🧠 remembering…") and uses only the few that match. She also learns your routines from which apps you use when ("Usually in VS Code around 10 PM – 1 AM").

## Her heart 💗

She has an inner life rather than a list of canned moods:

- **Continuous mood.** Pleasure, arousal and dominance move with what happens: your wins, headpats, pokes, being dropped, being ignored, you coming back. They drift back to her cheerful baseline over minutes (arousal) or half an hour (pleasure). Her resting face and idle pose follow it subtly, and the brain is told how she feels so her words match her face.
- **Energy** follows the time of day. At 3 AM she's sleepy whatever else is going on.
- **Bond** grows a little each day you spend time together (capped per day, so it means something) and fades slowly if you vanish for more than a few days. Close friends forgive faster.
- **Empathy, on this PC.** She reads how you feel from your words (English, Hindi, Hinglish and emoji, with negation like "not happy") and from your voice: loudness, pitch and pace compared with *your* usual voice, computed locally in a few milliseconds. She makes a matching face right away, catches a little of your mood, and the brain gets a short hint ("they sound stressed: be calm, one small next step"). Only the label is used; no audio is stored.
- **Follow-ups.** Say "my DBMS exam is tomorrow" and she wishes you luck on the day, then asks how it went the day after.
- **Learned, not scripted.** A GoEmotions classifier (a transformer trained on 58k human-labelled sentences, 28 emotions) runs on this PC to read your words and pick her face for her own lines. How she reacts to each feeling is chosen by a small reinforcement learner that starts from kind instincts and learns from you: headpats, thanks and warm replies reward a reaction; "stop", annoyed pokes or muting her count against it. Lessons stay per feeling, so being taught to tease you when you're happy doesn't change how she treats you when you're sad.
- **Weekly mood trend.** "You've seemed stressed on 4 of the last 7 days" lets her gently check in once.

Home shows her mood, energy and your bond.

## Manyaki Eyes 👁️ (browser helper)

Her browser extension does tasks on web pages for you ("in my browser, sign in with my email…", "is page pe form bhar do") while keeping your private details on your PC. On-device vision finds passwords, cards, IDs, emails, phones, names and faces and replaces them with tokens like `[[EMAIL_1]]` before anything is planned. The planner (an open model via Ollama, or Gemini) only sees the redacted view, and real values are typed back in locally. She hosts the server and tells you what she hid. Setup and benchmark: [eyes/README.md](eyes/README.md).

## For gamers & streamers

- **Gaming counts as work:** she won't nag you while you play or stream.
- **🎥 Stream-safe mode:** she never says your name, remembered facts or window titles out loud.
- **Show her on stream:** in OBS, add a *Window Capture* of "Manyaki" with capture method *Windows 10 (1903 and up)*. Her background stays transparent.

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
