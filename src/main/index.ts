/**
 * Main-process bootstrap: wires config, windows, tray, hotkeys, brain, TTS/STT and the orchestrator.
 *
 * OWNER: integration agent (keep this file the only place that knows about every module).
 */
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, safeStorage, screen, shell } from 'electron'
import { type FlowyConfig, redactConfig } from '@shared/config'
import { buildSystemPrompt } from '@shared/personality'
import { createAgent, type Agent } from './brain/agent'
import { createHistory } from './brain/history'
import { showNotification } from './brain/tools/misc'
import { availableTools, disposeTools, type ToolServices } from './brain/tools/registry'
import { ConfigStore, identityCipher, type SecretCipher } from './config/store'
import { requestConfirmation } from './confirm'
import { registerHotkeys, type HotkeyRegistration } from './hotkeys'
import { handle } from './ipc'
import { createLogger, initFileLog } from './log'
import { createNotesStore } from './memory/notes'
import { createOrchestrator, type Orchestrator } from './orchestrator'
import { bundledModelsDir, configFile, DEFAULT_MODEL_DIRNAME, historyFile, logDir, notesFile } from './paths'
import { createPowerShellHost } from './system/powershell'
import * as screenshot from './system/screenshot'
import { createWindowsSystem } from './system/windows'
import { createTray, type TrayController } from './tray'
import { createSttClient } from './stt'
import { createTtsClient } from './tts'
import { createOverlayWindow, type OverlayWindow } from './windows/overlay'
import { createSettingsWindowManager } from './windows/settings'
import { findDefaultModelJson, registerModelProtocol } from './windows/modelProtocol'

const log = createLogger('main')

// Transparent overlays + audio without user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.platform === 'win32') app.setAppUserModelId('dev.flowy.companion')

registerModelProtocol.registerSchemes()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(bootstrap).catch((err) => {
    log.error('bootstrap failed', err)
    dialog.showErrorBox('Flowy konnte nicht starten', String(err instanceof Error ? err.stack ?? err.message : err))
    app.quit()
  })
}

async function bootstrap(): Promise<void> {
  initFileLog(logDir())
  log.info(`Flowy ${app.getVersion()} starting on ${process.platform}`)

  const cipher: SecretCipher = safeStorage.isEncryptionAvailable()
    ? {
        encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
        decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
      }
    : identityCipher
  const store = new ConfigStore(configFile(), cipher)

  const preloadPath = path.join(__dirname, '../preload/index.js')
  registerModelProtocol.registerHandler(() => resolveModelDir(store))

  const powershell = createPowerShellHost()
  const system = createWindowsSystem(powershell)
  const notes = createNotesStore(notesFile())
  const services: ToolServices = {
    powershell,
    screenshot,
    notes,
    system,
    // A due reminder becomes a proactive turn (the orchestrator is created below; this only runs later).
    // While she is busy (or the overlay is gone) the turn is skipped – then a desktop toast carries it.
    onReminder: (message) => {
      const de = store.get().character.language === 'de'
      const instruction = de
        ? `Eine Erinnerung ist fällig: "${message}". Sag dem Nutzer jetzt kurz Bescheid.`
        : `A reminder is due: "${message}". Tell the user now, briefly.`
      void orchestrator
        .proactive(instruction)
        .then((turnId) => {
          if (!turnId) showNotification(de ? 'Erinnerung' : 'Reminder', message)
        })
        .catch((err) => {
          log.warn('reminder turn failed', err)
          showNotification(de ? 'Erinnerung' : 'Reminder', message)
        })
    },
  }
  const history = createHistory(historyFile())

  let agent: Agent = buildAgent()
  function buildAgent(): Agent {
    const config = store.get()
    const tools = availableTools(services, config)
    return createAgent({
      config,
      history,
      tools,
      systemPrompt: buildSystemPrompt({
        character: config.character,
        permissions: config.permissions,
        toolNames: tools.map((t) => t.name),
        platform: process.platform === 'win32' ? 'Windows' : process.platform,
      }),
      toolContextFactory: (signal, callbacks) => ({
        config: store.get(),
        signal,
        confirm: (req) => orchestratorConfirm(req),
        progress: (summary) => callbacks.onToolCall('', summary),
      }),
    })
  }

  let tts = createTtsClient(store.get().tts)
  let stt = createSttClient(store.get().stt, store.get().tts)

  let overlay: OverlayWindow | null = null
  const settings = createSettingsWindowManager({ preloadPath, title: 'Flowy – Einstellungen' })

  const orchestrator: Orchestrator = createOrchestrator({
    store,
    overlay: () => overlay,
    agent: () => agent,
    tts: () => tts,
    stt: () => stt,
    system,
    notes,
    captureScreen: screenshot.captureScreen,
  })
  // Tools ask the user through the orchestrator's confirm UI.
  const orchestratorConfirm: (req: Parameters<ToolContextConfirm>[0]) => Promise<boolean> = (req) =>
    requestConfirmation(orchestrator, req)

  let hotkeys: HotkeyRegistration | null = null
  let tray: TrayController | null = null
  let muted = false
  /** The start-up greeting runs once per app run (onReady/overlay:ready fire again on dev-server reloads). */
  let greeted = false
  /** Set once the renderer reported `overlay:ready` – before that nothing could show or play a greeting. */
  let overlayReady = false

  function createOverlay(): void {
    overlay?.dispose()
    overlay = createOverlayWindow({
      config: store.get(),
      preloadPath,
      onReady: () => {
        // Fires on every did-finish-load; the renderer queues these until its character is loaded.
        overlay?.send('config:changed', redactConfig(store.get()))
        overlay?.send('state:changed', orchestrator.state())
      },
    })
  }

  /**
   * Greet once: when the renderer runtime is up (character, bubble, player exist) and setup is complete –
   * on a normal start right after `overlay:ready`, on the first run right after the wizard finished.
   */
  function maybeGreet(): void {
    if (greeted || !overlayReady || !store.get().behavior.greetOnStart || !store.get().setupCompleted) return
    greeted = true
    void orchestrator.proactive('greeting').catch((err) => log.warn('greeting failed', err))
  }

  const trayActions = {
    openSettings: (page?: string) => settings.open(page),
    toggleVisibility: () => {
      overlay?.setVisible(!overlay.isVisible())
      refreshTray()
    },
    togglePinned: () => store.patch({ avatar: { pinned: !store.get().avatar.pinned } }),
    toggleMuted: () => {
      muted = !muted
      orchestrator.setMuted(muted)
      refreshTray()
    },
    relaunchElevated: () => relaunchElevated(),
    clearHistory: () => history.clear(),
    quit: () => app.quit(),
  }
  function refreshTray(): void {
    tray?.update(store.get(), orchestrator.state(), { visible: overlay?.isVisible() ?? false, muted })
  }

  /**
   * Only the settings window (opened by the user) may see clear-text API keys. The overlay – and any
   * sender we cannot attribute to a window – gets the redacted copy.
   */
  function configForSender(e: IpcMainInvokeEvent, config: FlowyConfig): FlowyConfig {
    const sender = BrowserWindow.fromWebContents(e.sender)
    const isOverlay = sender !== null && overlay !== null && sender === overlay.window
    const isSettings = sender !== null && sender === settings.current()
    return !isOverlay && isSettings ? config : redactConfig(config)
  }

  // ---- IPC handlers --------------------------------------------------------------------------
  handle('app:getInfo', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    elevated: await system.isElevated(),
    userDataPath: app.getPath('userData'),
    defaultModelPath: defaultModelJson() ?? '',
    live2dCoreAvailable: registerModelProtocol.coreAvailable(),
  }))
  handle('app:quit', () => app.quit())
  handle('app:openSettings', (_e, page) => {
    settings.open(page)
  })
  handle('app:relaunchElevated', () => relaunchElevated())
  handle('app:openExternal', (_e, url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Nur http(s)-Links können geöffnet werden.')
    return shell.openExternal(url)
  })
  handle('app:getDisplays', () => {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})`,
      bounds: d.bounds,
      primary: d.id === primary.id,
    }))
  })
  handle('app:closeSettings', () => settings.close())

  handle('config:get', (e) => configForSender(e, store.get()))
  handle('config:patch', (e, patch) => configForSender(e, store.patch(patch)))
  handle('config:completeSetup', (e) => configForSender(e, store.patch({ setupCompleted: true })))
  handle('config:testLlm', () => buildAgent().test())
  handle('config:testTts', async (_e, text) => {
    const client = createTtsClient(store.get().tts)
    if (!client) return { ok: false, message: 'TTS ist deaktiviert.' }
    return client.test(text ?? (store.get().character.language === 'de' ? 'Hallo! Ich bin bereit.' : 'Hello! I am ready.'))
  })
  handle('config:testStt', async (_e, audio) => {
    const client = createSttClient(store.get().stt, store.get().tts)
    if (!client) return { ok: false, message: 'STT ist deaktiviert.' }
    return client.test(audio)
  })
  handle('config:searchVoices', async (_e, query) => {
    const client = createTtsClient(store.get().tts)
    return client?.searchVoices ? client.searchVoices(query) : []
  })
  handle('config:pickModelFile', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Live2D Modell auswählen',
      filters: [{ name: 'Live2D model', extensions: ['json'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('config:pickFile', async (e, filters) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Datei auswählen',
      filters: filters && filters.length ? filters : [{ name: 'Alle Dateien', extensions: ['*'] }],
      properties: ['openFile'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle('overlay:setInteractive', (_e, interactive) => overlay?.setInteractive(interactive))
  handle('overlay:setFocus', (_e, focused) => overlay?.setFocus(focused))
  handle('overlay:reportBounds', () => undefined)
  handle('overlay:ready', () => {
    overlayReady = true
    maybeGreet()
  })
  handle('overlay:showContextMenu', () => {
    void import('./windows/contextMenu').then((m) =>
      m.showCharacterMenu(overlay?.window ?? null, trayActions, {
        config: store.get(),
        flags: { visible: overlay?.isVisible() ?? false, muted },
        state: orchestrator.state(),
      }),
    )
  })

  handle('turn:submitAudio', (_e, audio) => orchestrator.submitAudio(audio))
  handle('turn:submitText', (_e, text) => orchestrator.submitText(text))
  handle('turn:interrupt', () => orchestrator.interrupt())
  handle('turn:playbackFinished', (_e, turnId) => orchestrator.playbackFinished(turnId))
  handle('confirm:answer', (_e, id, approved) => orchestrator.answerConfirm(id, approved))
  handle('chat:getHistory', (_e, limit) => history.view(limit))
  handle('chat:clearHistory', () => history.clear())

  // ---- React to config changes ---------------------------------------------------------------
  store.onChange((next, prev) => {
    if (JSON.stringify(next.llm) !== JSON.stringify(prev.llm) || JSON.stringify(next.character) !== JSON.stringify(prev.character) || JSON.stringify(next.permissions) !== JSON.stringify(prev.permissions)) {
      agent = buildAgent()
    }
    if (JSON.stringify(next.tts) !== JSON.stringify(prev.tts)) tts = createTtsClient(next.tts)
    if (JSON.stringify(next.stt) !== JSON.stringify(prev.stt) || next.tts.fishCloud.apiKey !== prev.tts.fishCloud.apiKey) {
      stt = createSttClient(next.stt, next.tts)
    }
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) {
      const failed = hotkeys?.apply(next.hotkeys) ?? []
      if (failed.length > 0) log.warn(`hotkeys not registered (invalid, duplicate or taken by another app): ${failed.join(', ')}`)
    }
    // refit() also stores the config; every other change is remembered so a later monitor hot-plug refits with it.
    if (next.display !== prev.display) overlay?.refit(next)
    else overlay?.setConfig(next)
    if (next.autostart !== prev.autostart) app.setLoginItemSettings({ openAtLogin: next.autostart })
    overlay?.send('config:changed', redactConfig(next))
    settings.send('config:changed', next)
    refreshTray()
    if (next.setupCompleted && !prev.setupCompleted) maybeGreet()
  })
  orchestrator.onState((state) => {
    overlay?.send('state:changed', state)
    refreshTray()
  })

  // ---- Windows, tray, hotkeys ----------------------------------------------------------------
  createOverlay()
  tray = createTray(trayIconPath(), trayActions)
  refreshTray()
  hotkeys = registerHotkeys(store.get().hotkeys, {
    pushToTalk: () => orchestrator.pushToTalk(),
    toggleVisibility: trayActions.toggleVisibility,
    openChat: () => {
      if (!overlay) return
      // A chat input on a hidden character would be invisible – bring her back first.
      if (!overlay.isVisible()) {
        overlay.setVisible(true)
        refreshTray()
      }
      overlay.send('chat:open', {})
    },
    interrupt: () => orchestrator.interrupt(),
  })

  if (!store.get().setupCompleted) settings.open('wizard')

  app.on('second-instance', () => settings.open())
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })
  app.on('before-quit', () => {
    hotkeys?.dispose()
    tray?.dispose()
    orchestrator.dispose()
    disposeTools(services)
    powershell.dispose()
    history.save()
    overlay?.dispose()
    overlay = null
  })

  // Pre-compile the Win32/CoreAudio interop in the PowerShell host so the first tool call is fast.
  if (process.platform === 'win32') void system.warmup().catch((err) => log.warn('interop warmup failed', err))

  async function relaunchElevated(): Promise<void> {
    if (process.platform !== 'win32') return
    const exe = process.execPath
    const args = process.argv.slice(1).map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')
    await powershell.runRaw(`Start-Process -FilePath "${exe}" -ArgumentList '${args}' -Verb RunAs`)
    app.quit()
  }
}

type ToolContextConfirm = import('./brain/tools/types').ToolContext['confirm']

/** The bundled default `*.model3.json` (may sit one level below resources/models/default), or null. */
function defaultModelJson(): string | null {
  return findDefaultModelJson(path.join(bundledModelsDir(), DEFAULT_MODEL_DIRNAME))
}

/**
 * Directory served as `flowy-model://model/`: the folder of the configured model, or – when none is
 * configured or the file vanished – the folder of the bundled default model.
 */
function resolveModelDir(store: ConfigStore): string {
  const configured = store.get().avatar.modelPath.trim()
  if (configured) {
    if (fs.existsSync(configured)) return path.dirname(configured)
    log.warn(`configured Live2D model not found: ${configured} – serving the bundled model`)
  }
  const bundled = defaultModelJson()
  return bundled ? path.dirname(bundled) : path.join(bundledModelsDir(), DEFAULT_MODEL_DIRNAME)
}

function trayIconPath(): string {
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
  return path.join(base, process.platform === 'win32' ? 'tray.ico' : 'tray.png')
}
