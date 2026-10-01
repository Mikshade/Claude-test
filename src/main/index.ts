/**
 * Main-process bootstrap: wires config, windows, tray, hotkeys, brain, TTS/STT and the orchestrator.
 *
 * OWNER: integration agent (keep this file the only place that knows about every module).
 */
import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { redactConfig } from '@shared/config'
import { buildSystemPrompt } from '@shared/personality'
import { createAgent, type Agent } from './brain/agent'
import { createHistory } from './brain/history'
import { availableTools, type ToolServices } from './brain/tools/registry'
import { ConfigStore, identityCipher, type SecretCipher } from './config/store'
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
import { registerModelProtocol } from './windows/modelProtocol'

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
  const services: ToolServices = { powershell, screenshot, notes }
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
    captureScreen: screenshot.captureScreen,
  })
  // Tools ask the user through the orchestrator's confirm UI.
  const orchestratorConfirm: (req: Parameters<ToolContextConfirm>[0]) => Promise<boolean> = (req) =>
    confirmViaOrchestrator(orchestrator, overlay, req)

  let hotkeys: HotkeyRegistration | null = null
  let tray: TrayController | null = null
  let muted = false

  function createOverlay(): void {
    overlay?.dispose()
    overlay = createOverlayWindow({
      config: store.get(),
      preloadPath,
      onReady: () => {
        overlay?.send('config:changed', redactConfig(store.get()))
        overlay?.send('state:changed', orchestrator.state())
        if (store.get().behavior.greetOnStart && store.get().setupCompleted) {
          void orchestrator.proactive('greeting')
        }
      },
    })
  }

  const trayActions = {
    openSettings: (page?: string) => settings.open(page),
    toggleVisibility: () => overlay?.setVisible(!overlay.isVisible()),
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

  // ---- IPC handlers --------------------------------------------------------------------------
  handle('app:getInfo', async () => ({
    version: app.getVersion(),
    platform: process.platform,
    elevated: await system.isElevated(),
    userDataPath: app.getPath('userData'),
    defaultModelPath: path.join(bundledModelsDir(), DEFAULT_MODEL_DIRNAME),
    live2dCoreAvailable: registerModelProtocol.coreAvailable(),
  }))
  handle('app:quit', () => app.quit())
  handle('app:openSettings', (_e, page) => {
    settings.open(page)
  })
  handle('app:relaunchElevated', () => relaunchElevated())
  handle('app:openExternal', (_e, url) => shell.openExternal(url))

  handle('config:get', () => store.get())
  handle('config:patch', (_e, patch) => store.patch(patch))
  handle('config:completeSetup', () => store.patch({ setupCompleted: true }))
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

  handle('overlay:setInteractive', (_e, interactive) => overlay?.setInteractive(interactive))
  handle('overlay:setFocus', (_e, focused) => overlay?.setFocus(focused))
  handle('overlay:reportBounds', () => undefined)
  handle('overlay:showContextMenu', () => {
    void import('./windows/contextMenu').then((m) => m.showCharacterMenu(overlay?.window ?? null, trayActions))
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
    if (JSON.stringify(next.hotkeys) !== JSON.stringify(prev.hotkeys)) hotkeys?.apply(next.hotkeys)
    if (next.display !== prev.display) overlay?.refit(next)
    if (next.autostart !== prev.autostart) app.setLoginItemSettings({ openAtLogin: next.autostart })
    overlay?.send('config:changed', redactConfig(next))
    settings.send('config:changed', next)
    refreshTray()
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
    openChat: () => overlay?.send('ptt:start', { turnId: '' }),
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
    powershell.dispose()
    history.save()
  })

  async function relaunchElevated(): Promise<void> {
    if (process.platform !== 'win32') return
    const exe = process.execPath
    const args = process.argv.slice(1).map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')
    await powershell.runRaw(`Start-Process -FilePath "${exe}" -ArgumentList '${args}' -Verb RunAs`)
    app.quit()
  }
}

type ToolContextConfirm = import('./brain/tools/types').ToolContext['confirm']

function confirmViaOrchestrator(
  orchestrator: Orchestrator,
  _overlay: OverlayWindow | null,
  req: Parameters<ToolContextConfirm>[0],
): Promise<boolean> {
  return import('./confirm').then((m) => m.requestConfirmation(orchestrator, req))
}

function resolveModelDir(store: ConfigStore): string {
  const configured = store.get().avatar.modelPath
  if (configured) return path.dirname(configured)
  return path.join(bundledModelsDir(), DEFAULT_MODEL_DIRNAME)
}

function trayIconPath(): string {
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
  return path.join(base, process.platform === 'win32' ? 'tray.ico' : 'tray.png')
}
