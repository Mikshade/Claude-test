# Flowy – Architecture

Flowy is an anime desktop companion for Windows 10/11: a 2D anime character (Live2D) that lives on
top of all windows, talks with a Fish Audio voice, listens via push-to-talk, sees the screen, and
can control the computer through Claude tool use – a "Jarvis" with a face.

This document is the contract between modules. **Interfaces live in code** (`src/shared/*`,
and the `export interface` blocks of each module); this file explains how they fit together.

## Stack

| Concern | Choice |
| --- | --- |
| Shell | Electron 44 (CommonJS main/preload), electron-vite 5 + Vite 7, TypeScript 5.9 strict |
| Renderer | Vanilla TypeScript, PixiJS 7 + `pixi-live2d-display-lipsyncpatch` (Cubism 2/4 models) |
| Brain | `@anthropic-ai/sdk` Messages API streaming + tool use (default model `claude-opus-5-5`) |
| Voice out | Fish Audio cloud (`api.fish.audio`) or local Fish Speech server – same client interface |
| Voice in | Fish Audio ASR or any OpenAI-compatible `/v1/audio/transcriptions` endpoint |
| System | PowerShell (persistent host process), Electron `desktopCapturer`, no native node modules |
| Config | zod-validated JSON in `userData/config.json`, secrets encrypted with `safeStorage` |
| Tests | vitest (node env, `electron` aliased to `tests/mocks/electron.ts`) |

Dev happens on Linux: `npm run typecheck`, `npm test`, `npm run build` must pass here.
The GUI only runs on Windows (`npm run dev` / `npm run dist`).

## Processes and windows

```
┌──────────────────────── main (Node) ─────────────────────────┐
│ index.ts (bootstrap)                                          │
│  ├ config/store.ts        ConfigStore (zod, safeStorage)      │
│  ├ windows/overlay.ts     transparent always-on-top overlay   │
│  ├ windows/settings.ts    settings / wizard window            │
│  ├ windows/modelProtocol  flowy-model:// serves Live2D files  │
│  ├ tray.ts, hotkeys.ts, windows/contextMenu.ts                │
│  ├ orchestrator.ts        turn state machine (see below)      │
│  ├ brain/agent.ts         Anthropic streaming tool loop       │
│  ├ brain/history.ts       persisted conversation              │
│  ├ brain/tools/*          tool registry + implementations     │
│  ├ tts/*                  Fish cloud/local clients, pipeline  │
│  ├ stt/*                  Fish ASR, OpenAI-compatible         │
│  ├ system/powershell.ts   persistent PowerShell host          │
│  ├ system/windows.ts      active window, volume, input, power │
│  ├ system/screenshot.ts   desktopCapturer → JPEG              │
│  └ memory/notes.ts        long-term notes (remember/recall)   │
└───────────────┬───────────────────────────────┬───────────────┘
                │ IPC (typed, see shared/ipc.ts) │
   ┌────────────┴────────────┐       ┌───────────┴────────────┐
   │ renderer/overlay        │       │ renderer/settings      │
   │ character/ (Live2D|fb)  │       │ wizard + tabs          │
   │ movement.ts (avoidance) │       │ voice/mic/LLM tests    │
   │ bubble.ts, chat         │       └────────────────────────┘
   │ audio/ recorder, player │
   └─────────────────────────┘
```

### Overlay window (src/main/windows/overlay.ts)

- One `BrowserWindow` sized to the chosen display's **work area** (never `fullscreen: true` – that
  breaks transparency on Windows). `transparent: true, frame: false, hasShadow: false,
  resizable: false, skipTaskbar: true, focusable: true` plus `setAlwaysOnTop(true, 'screen-saver')`
  and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. The window must be focusable
  because the chat input needs keyboard focus, but it never takes focus on its own: it is only shown
  with `showInactive()`, and `focus()` is called only from `overlay:setFocus(true)` (chat opened by
  the user); `setFocus(false)` blurs so the previous app gets focus back.
- `webPreferences`: `preload`, `contextIsolation: true`, `sandbox: true`,
  `additionalArguments: ['--flowy-page=overlay']`, `backgroundThrottling: false`.
- Click-through: `setIgnoreMouseEvents(true, { forward: true })` by default. With `forward: true`
  the page still receives `mousemove`; the renderer hit-tests the character and calls
  `overlay:setInteractive(true)` → `setIgnoreMouseEvents(false)`. Interactive only while the
  user holds `avatar.avoidance.holdKeyToInteract` (default Ctrl) over her, or while the bubble/chat
  UI is open (those elements have `pointer-events: auto`).
- Cursor: main polls `screen.getCursorScreenPoint()` at 60 Hz (`setInterval` 16 ms, only while the
  window is visible) and pushes `cursor:position` in window-relative CSS px
  (`point - window.getBounds()` – DIP coordinates on Windows).
- Renderer file paths: prod `file://…/out/renderer/overlay/index.html`,
  dev `${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`.

### Settings window

Normal window (900×680, resizable, `--flowy-page=settings`). Opened on first run with the wizard,
later from the tray/context menu. Only this page ever receives clear-text API keys
(`config:get`); the overlay gets `redactConfig()`.

### Live2D asset serving (`flowy-model://`)

The renderer cannot `fetch()` arbitrary `file://` paths. `windows/modelProtocol.ts` registers the
privileged scheme `flowy-model` (`standard, secure, supportFetchAPI, stream, corsEnabled`) before
`app.whenReady()` and a `protocol.handle` after it. `flowy-model://model/<relative>` serves files
from the directory of `avatar.modelPath` (or the bundled default model). Path traversal is rejected.
The renderer loads `flowy-model://model/<basename of modelPath>`.

Cubism Core (`live2dcubismcore.min.js`, proprietary) is loaded by a classic `<script>` tag from
`../vendor/` (public dir, fetched by `npm run setup:live2d`). If absent, the renderer injects a
`<script>` for the official CDN; if that fails too, it uses the procedural fallback character.

## The turn pipeline (src/main/orchestrator.ts)

```
state: idle → listening → transcribing → thinking → speaking → idle
```

1. Hotkey (`hotkeys.pushToTalk`, toggle semantics) → `orchestrator.pushToTalk()`:
   - idle → `ptt:start` → renderer starts recording (`audio/recorder.ts`) → state `listening`
   - listening → `ptt:stop` (renderer also auto-stops after `stt.silenceTimeoutMs` of silence)
   - speaking/thinking → `interrupt()` then start listening
2. Renderer sends `turn:submitAudio(RecordedAudio)` → STT (`stt/*`) → `turn:userText`.
   Text from the chat input goes through `turn:submitText`.
3. Context: if `screenAwareness.mode === 'always'` (or the text looks like a screen question in
   `on-demand`), main captures a downscaled JPEG and the active window title and passes them to
   `agent.run()` as `screenshot` / `context` (they go into the **user** message, never the system
   prompt – the system prompt must stay byte-stable for prompt caching).
4. `brain/agent.ts` streams text. The orchestrator feeds deltas into `SentenceChunker`
   (`shared/text.ts`), forwards `turn:assistantDelta` for subtitles, and pushes each sentence into a
   `SpeechPipeline` (`tts/pipeline.ts`) which synthesizes with bounded concurrency but emits
   `speech:chunk` strictly in order. Emotions come from `[[marker]]`s in the text.
5. Renderer `audio/player.ts` queues chunks gaplessly, drives `setMouthOpen()` from an
   `AnalyserNode`, and calls `turn:playbackFinished(turnId)` when the `last` chunk ended → `idle`.
6. Interrupt (`turn:interrupt`, hotkey, or new PTT): abort the agent's `AbortController`, abort the
   pipeline, push `speech:stop`, state → idle. The partial assistant text that was already spoken
   is kept in history (the agent appends what it has on abort).
7. Tool confirmations: a destructive tool under `permissions.level === 'confirm-destructive'`
   calls `ctx.confirm()` → `confirm:request` to the overlay → the bubble shows Yes/No →
   `confirm:answer`. Timeout 60 s = denied.
8. Proactive: `orchestrator.proactive('greeting' | instruction)` runs a turn without user text
   (used for the start-up greeting and the optional periodic screen comment).

## Brain (src/main/brain)

Follow the `claude-api` skill's TypeScript "Streaming Manual Loop":

- `client.messages.stream({ model, max_tokens: 8192, system: [{type:'text', text, cache_control}],
  tools (with cache_control on the last tool), messages, thinking: {type:'adaptive'},
  output_config: { effort } })`, `stream.on('text')` for deltas, `await stream.finalMessage()`.
- Loop while `stop_reason === 'tool_use'`: execute **all** tool_use blocks (in parallel), answer
  with **one** user message containing all `tool_result` blocks (`is_error: true` on failure,
  image blocks allowed for screenshots). Stop on `end_turn`, `refusal`, `max_tokens`.
- Append `message.content` verbatim to history (keeps thinking blocks). History is append-only
  within a turn; trimming happens between turns and never splits tool_use/tool_result pairs.
- Tool inputs are validated with the tool's zod schema before execution; invalid → `is_error`.
- Refusal fallback (`llm.refusalFallback`): use `client.beta.messages.stream` with
  `betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default'` **only if** the installed SDK
  types accept it; otherwise handle `stop_reason === 'refusal'` by speaking a short in-character
  "I can't help with that" line.
- Errors: map `Anthropic.AuthenticationError` → "API key invalid", `RateLimitError`,
  `APIConnectionError`; never string-match messages.

Tools (`brain/tools/*.ts`), all zod-typed, categories map to `permissions.*` flags:

| name | category | destructive | notes |
| --- | --- | --- | --- |
| run_powershell | shell | yes | timeout, output cap, runs on the shared host |
| read_file, list_directory, search_files, file_info | files | no | size caps, binary detection |
| write_file, append_file, move_path, delete_path, create_directory | files | yes | delete goes to Recycle Bin via `shell.trashItem` |
| open_path, open_url | apps | no | `shell.openPath/openExternal` |
| launch_app, list_installed_apps, list_windows, focus_window, close_window | apps | close=yes | via `system/windows.ts` |
| get_active_window | system | no | |
| take_screenshot | screen | no | returns an image block |
| get_clipboard, set_clipboard | system | set=yes | Electron clipboard |
| type_text, press_keys, click_at | input | yes | SendKeys / user32 |
| set_volume, media_control, set_brightness | system | no | |
| notify | misc | no | Electron Notification |
| web_fetch, web_search | web | no | readable text extraction; DuckDuckGo HTML |
| remember, recall, forget | memory | no | `memory/notes.ts` |
| set_reminder | misc | no | in-process timer → proactive turn |
| system_info, lock_screen, power_action | system/power | power=yes | |

## Renderer: character and movement

- `character/types.ts` is the contract. `character/live2d.ts` implements it with
  `pixi-live2d-display-lipsyncpatch` (`window.PIXI = PIXI` before importing the library;
  `Live2DModel.from(url, { autoInteract: false })`; manual `ParamMouthOpenY` override each frame
  via the model's `beforeModelUpdate`/`afterMotionUpdate` hook; `model.focus(x, y)` for look-at;
  expressions by name with a mapping table from `Emotion` → expression/motion group, tolerant of
  models that lack them). `character/fallback.ts` draws a simple anime-style character on a 2D
  canvas (blink, breathing, mouth, hair sway) so the app works without any model.
- `movement.ts` is pure (unit-tested): position/velocity, work-area clamping, idle bobbing, and
  `fleeFrom(cursor)` which picks a destination maximizing distance from the cursor (candidates:
  corners/edges + random jitter, never off-screen, prefers staying on the same half if possible)
  and animates with an ease-out/spring over `avatar.avoidance.durationMs`, with a cooldown so she
  does not ping-pong. No flight while `pinned`, while the hold-key is pressed, while the bubble is
  open for interaction, or while `listening`.
- The whole character canvas is positioned with `transform: translate3d()` (GPU) – the Pixi app
  is only as large as the character, not the whole screen.
- Target: 60 fps idle. Use Pixi's ticker, `antialias: true`, `resolution: devicePixelRatio`,
  `backgroundAlpha: 0`, `autoDensity: true`.

## Renderer: bubble / chat UI (`bubble.ts`)

A speech bubble near the character shows: listening indicator, the transcribed user text,
streaming assistant subtitles (markers stripped), tool progress lines, errors, confirm prompts
(Yes/No), and a text input (opened by `hotkeys.openChat`, or clicking her while holding the
hold-key). It must be positioned on the side of the character with the most free space and never
leave the work area.

## Audio (renderer/overlay/audio)

- `recorder.ts`: `getUserMedia({ audio: { deviceId, echoCancellation, noiseSuppression } })` →
  AudioWorklet (fallback ScriptProcessor) → Float32 → resample to 16 kHz → 16-bit PCM WAV `Blob`.
  Energy VAD: stop after `silenceTimeoutMs` below threshold once speech was detected; hard cap
  `maxRecordingMs`.
- `player.ts`: `AudioContext` + per-chunk `decodeAudioData` (mp3/wav) or direct `AudioBuffer`
  for pcm; schedule `AudioBufferSourceNode.start(nextStartTime)` for gapless playback;
  `AnalyserNode` RMS → smoothed mouth value; `stop()` cancels everything; `setSinkId` for the
  output device; gain from `tts.volume`.

## Config and secrets

`src/shared/config.ts` is the schema. `ConfigStore.patch()` deep-merges, validates, saves
atomically, encrypts `SECRET_PATHS` with safeStorage (`enc:` prefix), and notifies listeners.
The main bootstrap rebuilds the agent/TTS/STT clients when their config sections change.

## Coding conventions

- TypeScript strict, no `any` unless interfacing with untyped libs (then isolate in one place).
- Named exports; factory functions (`createX`) returning interfaces, no class inheritance.
- Every module degrades gracefully on non-Windows (return empty/false, log a warning) so unit
  tests and `npm run build` run on Linux.
- Tests: pure logic gets vitest tests next to the file (`*.test.ts`). Mock `electron` through the
  alias; mock `fetch` with `vi.fn()`.
- Logging through `createLogger(scope)`; never `console.log` in main.
- German is the default UI language; strings in the settings UI go through a tiny `t()` helper
  with `de`/`en` tables (`src/renderer/settings/i18n.ts`).
- No new npm dependencies without a strong reason (the review stage checks this).

## Ownership map (parallel implementation)

| Agent | Files |
| --- | --- |
| overlay | `src/main/windows/overlay.ts`, `src/main/windows/modelProtocol.ts` |
| core-logic (done) | `src/renderer/overlay/movement.ts`, `src/main/memory/notes.ts`, `src/main/hotkeys.ts` |
| renderer-core | `src/renderer/overlay/character/*`, `src/renderer/overlay/movement.ts`, `src/renderer/overlay/main.ts` |
| renderer-ui | `src/renderer/overlay/bubble.ts`, `src/renderer/overlay/styles.css`, `src/renderer/overlay/index.html` |
| audio | `src/renderer/overlay/audio/*` |
| tts | `src/main/tts/*`, `src/main/net/fishAudio.ts` |
| stt | `src/main/stt/*` |
| brain | `src/main/brain/agent.ts`, `src/main/brain/history.ts` |
| tools | `src/main/brain/tools/*` (except types.ts), `src/main/memory/notes.ts` |
| system | `src/main/system/*` |
| settings-ui | `src/renderer/settings/*`, `src/main/windows/settings.ts`, `src/main/tray.ts`, `src/main/windows/contextMenu.ts` |
| assets | `scripts/setup-live2d.mjs`, `resources/*` (icons), `README.md` |
| integration | `src/main/index.ts`, `src/main/orchestrator.ts`, `src/main/confirm.ts` (after the others) |

Shared contracts (`src/shared/*`, `*/types.ts`) are owned by the integrator; an agent that needs a
contract change reports it in its result instead of editing the contract.
