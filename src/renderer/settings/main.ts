/**
 * Settings + first-run wizard page.
 *
 * OWNER: settings-ui agent. Vanilla TypeScript, no framework. Two modes from the URL hash:
 * '#wizard[/step]' shows the stepper, anything else the sidebar with tabs. Both reuse pages/*.
 *
 * Persistence: every control writes through the SettingsStore (debounced 'config:patch'); pushes on
 * 'config:changed' from main (tray toggles, other windows) re-render the current page.
 */
import type { FlowyConfig, Language } from '@shared/config'
import type { AppInfo } from '@shared/ipc'
import { getLanguage, setLanguage, t } from './i18n'
import { PAGE_IDS, type PageId, parseHash, type Route, routeHash, type WizardStep } from './nav'
import { pageById } from './pages'
import type { Mode, PageContext } from './pages/context'
import { createSettingsStore, type SettingsStore } from './store'
import { button, el, type NoteKind, replaceChildren, rerenderInto } from './ui'
import { collectWarnings } from './validation'
import { renderWizard } from './wizard'

interface Shell {
  store: SettingsStore
  info: AppInfo | null
  root: HTMLElement
  route: Route
  /** Listeners of the currently mounted page. */
  listeners: Array<(config: FlowyConfig) => void>
  cleanups: Array<() => void>
  /** Re-renders only the current page in place (keeps scroll + focus); set by the mode renderers. */
  rerenderPage: (() => void) | null
  /** Language/theme the shell was rendered with – a change forces a full re-render. */
  renderedLang: Language
  renderedTheme: string
}

function applyTheme(theme: FlowyConfig['appearance']['theme']): void {
  const root = document.documentElement
  if (theme === 'auto') delete root.dataset['theme']
  else root.dataset['theme'] = theme
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---- toasts ---------------------------------------------------------------------------------------

const toastHost = el('div', { class: 'toasts', 'aria-live': 'polite' })

function toast(message: string, kind: NoteKind = 'info'): void {
  const node = el('div', { class: `toast toast-${kind}` }, message)
  toastHost.appendChild(node)
  setTimeout(() => node.classList.add('is-leaving'), 3200)
  setTimeout(() => node.remove(), 3600)
}

// ---- page context ---------------------------------------------------------------------------------

function unmountPage(shell: Shell): void {
  for (const c of shell.cleanups) {
    try {
      c()
    } catch (err) {
      console.warn('[settings] cleanup failed', err)
    }
  }
  shell.cleanups = []
  shell.listeners = []
}

function makeContext(shell: Shell, mode: Mode, rerender: () => void): PageContext {
  const config = shell.store.get()
  return {
    config,
    store: shell.store,
    info: shell.info,
    lang: getLanguage(),
    mode,
    rerender,
    onConfig: (listener) => shell.listeners.push(listener),
    onUnmount: (cleanup) => shell.cleanups.push(cleanup),
    toast,
    navigate: (page) => {
      location.hash = routeHash({ mode: 'tabs', page })
    },
  }
}

// ---- tabs mode ------------------------------------------------------------------------------------

function sidebar(shell: Shell, current: PageId): HTMLElement {
  const warnings = collectWarnings(shell.store.get())
  const items = PAGE_IDS.map((id) => {
    const count = warnings.filter((w) => w.page === id && w.severity === 'error').length
    const a = el(
      'a',
      { class: `nav-item${id === current ? ' is-active' : ''}`, href: `#${id}`, dataset: { page: id } },
      el('span', { class: 'nav-label' }, t(`nav.${id}`)),
      count ? el('span', { class: 'nav-badge', title: String(count) }, '!') : null,
    )
    return el('li', null, a)
  })
  return el(
    'aside',
    { class: 'sidebar' },
    el('div', { class: 'brand-block' }, el('h1', { class: 'brand' }, 'Flowy'), el('p', { class: 'muted small' }, t('app.autosave'))),
    el('nav', null, el('ul', { class: 'nav-list' }, items)),
  )
}

function renderTabs(shell: Shell, pageId: PageId): void {
  unmountPage(shell)
  const page = pageById(pageId)
  const host = el('div', { class: 'page-host' })
  const render = (): HTMLElement => {
    unmountPage(shell)
    const ctx = makeContext(shell, 'tabs', () => rerenderInto(host, render))
    return el('div', null, el('header', { class: 'page-header' }, el('h1', null, t(page.titleKey)), el('p', { class: 'muted' }, t(page.descriptionKey))), page.render(ctx))
  }
  replaceChildren(host, render())
  shell.rerenderPage = () => rerenderInto(host, render)
  replaceChildren(shell.root, el('div', { class: 'layout' }, sidebar(shell, pageId), el('main', { class: 'content' }, host)), toastHost)
}

// ---- wizard mode ----------------------------------------------------------------------------------

function renderWizardMode(shell: Shell, step: WizardStep): void {
  unmountPage(shell)
  const host = el('div', { class: 'page-host wizard-host' })
  const render = (): HTMLElement => {
    unmountPage(shell)
    return renderWizard(
      {
        context: () => makeContext(shell, 'wizard', () => rerenderInto(host, render)),
        config: () => shell.store.get(),
        flush: () => shell.store.flush(),
        go: (next) => {
          location.hash = routeHash({ mode: 'wizard', step: next })
        },
        completed: () => {
          location.hash = routeHash({ mode: 'tabs', page: 'character' })
        },
      },
      step,
      getLanguage(),
    ).element
  }
  replaceChildren(host, render())
  shell.rerenderPage = () => rerenderInto(host, render)
  replaceChildren(shell.root, el('div', { class: 'layout layout-wizard' }, el('main', { class: 'content' }, host)), toastHost)
}

// ---- shell ----------------------------------------------------------------------------------------

function renderRoute(shell: Shell): void {
  const config = shell.store.get()
  setLanguage(config.character.language)
  applyTheme(config.appearance.theme)
  shell.renderedLang = config.character.language
  shell.renderedTheme = config.appearance.theme
  document.title = t('app.title')
  if (shell.route.mode === 'wizard') renderWizardMode(shell, shell.route.step)
  else renderTabs(shell, shell.route.page)
}

function refreshSidebar(shell: Shell): void {
  if (shell.route.mode !== 'tabs') return
  const aside = shell.root.querySelector('.sidebar')
  if (aside) aside.replaceWith(sidebar(shell, shell.route.page))
}

function onStoreChange(shell: Shell, config: FlowyConfig, source: 'local' | 'ack' | 'remote'): void {
  if (config.character.language !== shell.renderedLang) {
    // Every label changes – rebuild the whole shell.
    renderRoute(shell)
    return
  }
  if (config.appearance.theme !== shell.renderedTheme) {
    applyTheme(config.appearance.theme)
    shell.renderedTheme = config.appearance.theme
  }
  if (source === 'remote') {
    // Foreign change (tray toggle, another window): re-render the page in place, keep focus + scroll.
    shell.rerenderPage?.()
    refreshSidebar(shell)
    return
  }
  for (const l of shell.listeners) {
    try {
      l(config)
    } catch (err) {
      console.warn('[settings] page listener failed', err)
    }
  }
  // Keep the sidebar badges in sync without a full re-render.
  refreshSidebar(shell)
}

async function main(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) return
  let config: FlowyConfig
  let info: AppInfo | null = null
  try {
    ;[config, info] = await Promise.all([
      window.flowy.invoke('config:get'),
      window.flowy.invoke('app:getInfo').catch((err: unknown) => {
        console.warn('[settings] app:getInfo failed', err)
        return null
      }),
    ])
  } catch (err) {
    setLanguage('de')
    replaceChildren(root, el('div', { class: 'page' }, el('p', { class: 'note note-danger' }, t('app.loadFailed', { message: describeError(err) })), button(t('common.close'), () => window.close())))
    return
  }

  const store = createSettingsStore(config, {
    invoke: (patch) => window.flowy.invoke('config:patch', patch),
    onError: (err) => {
      toast(t('app.invalidValue'), 'danger')
      console.warn('[settings] patch rejected', describeError(err))
      // Resync with main so the UI shows what is really stored.
      void window.flowy.invoke('config:get').then((fresh) => store.reset(fresh))
    },
  })

  const shell: Shell = {
    store,
    info,
    root,
    route: parseHash(location.hash, config.setupCompleted),
    listeners: [],
    cleanups: [],
    rerenderPage: null,
    renderedLang: config.character.language,
    renderedTheme: config.appearance.theme,
  }

  store.subscribe((next, source) => onStoreChange(shell, next, source))
  window.flowy.on('config:changed', (next) => {
    store.applyRemote(next)
  })
  window.addEventListener('hashchange', () => {
    shell.route = parseHash(location.hash, store.get().setupCompleted)
    renderRoute(shell)
  })
  window.addEventListener('beforeunload', () => {
    void store.flush()
  })

  renderRoute(shell)
}

void main()
