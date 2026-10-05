/**
 * Speech bubble / chat UI next to the character.
 *
 * OWNER: renderer-ui agent. The overlay's main.ts (renderer-core agent) wires this controller:
 * it forwards push events (turn:*, confirm:request, state:changed) and positions the bubble next to
 * the character via setAnchor(). The bubble is the ONLY interactive DOM in the overlay: while it is
 * interactive (chat input open, confirm pending, hovering a button) `onInteractiveChange(true)` must
 * be emitted so main disables click-through; emit false again when it closes.
 *
 * Layout (built into `options.root`, normally `#bubble`):
 *
 *   #bubble[data-visible][data-side][data-state][data-interactive][data-theme]  style: left/top/--tail-offset/--level/--bubble-font
 *     .bubble-card
 *       .bubble-head      state chip (● label + equalizer | bouncing dots), stop ■ and close ✕ buttons
 *       .bubble-body      › user text · assistant text (streaming, spoken sentence marked) · 🛠 tool line · error line
 *       .confirm          title / detail / monospace preview / Ja · Nein (Enter / Escape)
 *       .chat             auto-growing textarea (Enter sends, Shift+Enter newline, Escape closes) + send button
 *     svg.bubble-tail     points at her head (side) or her centre (top)
 *
 * Only the DOM-free helpers at the top (chip mapping, auto-hide rule, spoken-sentence search, input
 * height) are unit-tested (bubble.test.ts); the controller itself needs a browser.
 */
import type { Language } from '@shared/config'
import type { CompanionState, ConfirmRequest, Rect } from '@shared/state'
import { pickBubblePosition } from './bubblePosition'
import { type BubbleStringKey, t } from './strings'

export interface BubbleOptions {
  root: HTMLElement
  language: Language
  fontSize: number
  /** 'auto' follows prefers-color-scheme (default). */
  theme?: 'auto' | 'light' | 'dark'
  /**
   * Also request keyboard focus (onInputFocusChange(true)) while a confirm prompt is pending so
   * Enter / Escape reach it. Default true.
   */
  focusForConfirm?: boolean
  /** The user typed a message and pressed Enter. */
  onSubmitText(text: string): void
  /** The user clicked the stop button / pressed Escape while speaking. */
  onInterrupt(): void
  /** Bubble wants (or no longer needs) real mouse/keyboard input. */
  onInteractiveChange(interactive: boolean): void
  /** Chat input opened/closed – main must focus/blur the overlay window accordingly. */
  onInputFocusChange(focused: boolean): void
}

export interface BubbleController {
  /** Reposition next to the character (window coords). Picks the side with the most free space. */
  setAnchor(characterRect: Rect, workArea: Rect): void
  setState(state: CompanionState): void
  /** Show "listening…" with a level meter (0..1 via setInputLevel). */
  showListening(): void
  setInputLevel(level: number): void
  showUserText(text: string): void
  /** Start a streaming assistant message for a turn. */
  startAssistant(turnId: string): void
  appendAssistant(turnId: string, delta: string): void
  /** Replace the assistant text with the final (marker-stripped) text. */
  finishAssistant(turnId: string, finalText: string): void
  /** Subtitle sync: highlight/show the sentence currently being spoken. */
  showSpokenSentence(turnId: string, text: string): void
  showToolProgress(summary: string): void
  showError(message: string): void
  /** Ask the user; resolves with the answer (false on dismiss/timeout). */
  confirm(request: ConfirmRequest): Promise<boolean>
  /** Resolve a pending confirm from the outside (e.g. main timed out). */
  resolveConfirm(id: string): void
  openChatInput(prefill?: string): void
  closeChatInput(): void
  isChatInputOpen(): boolean
  /** True while the bubble needs real mouse input. */
  isInteractive(): boolean
  /** Hide after a delay (ms) unless new content arrives; 0 = now. */
  hide(delayMs?: number): void
  setFontSize(px: number): void
  setLanguage(language: Language): void
  /** Override the colour scheme ('auto' = prefers-color-scheme). */
  setTheme(theme: 'auto' | 'light' | 'dark'): void
  isConfirmPending(): boolean
  isVisible(): boolean
  dispose(): void
}

/** The bubble disappears this long after the last content change once she is idle. */
export const AUTO_HIDE_MS = 8_000
/** A confirm prompt resolves to "no" after this (mirrors the orchestrator's timeout). */
export const CONFIRM_TIMEOUT_MS = 60_000
/** The chat input grows up to this many lines, then scrolls. */
export const MAX_INPUT_LINES = 4
export const MIN_FONT_PX = 10
export const MAX_FONT_PX = 32
/** A window blur within this time after opening the chat is ignored (focus churn while main focuses us). */
export const BLUR_CLOSE_GRACE_MS = 400

// ---- pure helpers (unit-tested) -----------------------------------------------------------------

export type ChipKind = 'listening' | 'thinking' | 'speaking'

/** Which chip animation a state gets (null = no chip). Transcribing shows the "thinking" dots. */
export function chipKindForState(state: CompanionState): ChipKind | null {
  switch (state) {
    case 'listening':
      return 'listening'
    case 'transcribing':
    case 'thinking':
      return 'thinking'
    case 'speaking':
      return 'speaking'
    default:
      return null
  }
}

/** The label shown in the chip for a state (null = no chip). */
export function chipLabelKey(state: CompanionState): BubbleStringKey | null {
  switch (state) {
    case 'listening':
    case 'transcribing':
    case 'thinking':
    case 'speaking':
      return state
    default:
      return null
  }
}

/** States during which the bubble must stay visible. */
export function isBusyState(state: CompanionState): boolean {
  return state === 'listening' || state === 'transcribing' || state === 'thinking' || state === 'speaking'
}

/** The stop ■ button is offered while a turn can be interrupted. */
export function canInterrupt(state: CompanionState): boolean {
  return state === 'thinking' || state === 'speaking'
}

export interface HideInputs {
  state: CompanionState
  confirmPending: boolean
  chatOpen: boolean
}

/** May the auto-hide timer hide the bubble right now? */
export function canAutoHide(i: HideInputs): boolean {
  return !isBusyState(i.state) && !i.confirmPending && !i.chatOpen
}

export interface TextRange {
  start: number
  end: number
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Locate `sentence` inside `text`, tolerating whitespace differences (the TTS chunker collapses
 * whitespace). The search starts at `from` (end of the previously spoken sentence, so a repeated
 * sentence highlights the next occurrence) and falls back to the beginning. Null when not found.
 */
export function findSpokenRange(text: string, sentence: string, from = 0): TextRange | null {
  const tokens = sentence.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || text.length === 0) return null
  const re = new RegExp(tokens.map(escapeRegExp).join('\\s+'), 'g')
  const start = Math.max(0, Math.min(Math.floor(from), text.length))
  re.lastIndex = start
  let m = re.exec(text)
  if (!m && start > 0) {
    re.lastIndex = 0
    m = re.exec(text)
  }
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

/**
 * Height for the auto-growing textarea: `contentHeight` (scrollHeight minus vertical padding) plus the
 * box chrome (vertical padding + borders), at least one line and at most `maxLines` lines.
 */
export function inputHeightFor(contentHeight: number, lineHeight: number, chrome: number, maxLines = MAX_INPUT_LINES): number {
  const min = lineHeight + chrome
  const max = Math.max(1, maxLines) * lineHeight + chrome
  return Math.round(Math.min(Math.max(contentHeight + chrome, min), max))
}

/** Smoothed, perceptually boosted 0..1 level for the equalizer (microphone RMS values are small). */
export function smoothLevel(previous: number, raw: number, alpha = 0.5): number {
  const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
  const boosted = Math.sqrt(clamped)
  const next = previous + (boosted - previous) * alpha
  return Math.round(next * 1000) / 1000
}

export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return 15
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.round(px)))
}

// ---- DOM controller ---------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, label: string, title: string): HTMLButtonElement {
  const b = el('button', className, label)
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}

function bars(className: string, count: number): HTMLSpanElement {
  const wrap = el('span', className)
  wrap.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < count; i++) wrap.appendChild(document.createElement('i'))
  return wrap
}

function tailSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'bubble-tail')
  svg.setAttribute('viewBox', '0 0 16 32')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '32')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  // Open path: the two outer edges are stroked, the fill closes along the card edge (x = 0).
  path.setAttribute('d', 'M0 1 L14.5 16 L0 31')
  svg.appendChild(path)
  return svg
}

interface PendingConfirm {
  id: string
  resolve(approved: boolean): void
  timer: ReturnType<typeof setTimeout>
}

export function createBubble(options: BubbleOptions): BubbleController {
  const root = options.root
  let language = options.language
  let state: CompanionState = 'idle'
  let visible = false
  let hovering = false
  let chatOpen = false
  let chatOpenedAt = 0
  let interactive = false
  let disposed = false
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let anchor: { character: Rect; workArea: Rect } | null = null
  let repositionQueued = false
  let level = 0

  let assistantTurn: string | null = null
  let assistantText = ''
  let streaming = false
  let spokenSentence = ''
  let spokenRange: TextRange | null = null
  /** The user line was set after the last startAssistant → it belongs to the upcoming turn. */
  let userTextFresh = false
  let pending: PendingConfirm | null = null
  let lastConfirm: ConfirmRequest | null = null

  // ---- build the DOM -----------------------------------------------------------------------------
  root.classList.add('bubble')
  root.classList.remove('hidden')
  root.replaceChildren()
  root.dataset['visible'] = 'false'
  root.dataset['side'] = 'left'
  root.dataset['state'] = state
  root.dataset['interactive'] = 'false'
  root.style.setProperty('--level', '0')

  const card = el('div', 'bubble-card')

  const head = el('div', 'bubble-head')
  const chip = el('span', 'chip')
  const chipDot = el('span', 'chip-dot')
  const chipEq = bars('chip-eq', 4)
  const chipDots = bars('chip-dots', 3)
  const chipLabel = el('span', 'chip-label')
  chip.append(chipDot, chipEq, chipDots, chipLabel)
  const stopBtn = button('icon-btn stop', '■', '')
  const closeBtn = button('icon-btn close', '✕', '')
  head.append(chip, el('span', 'spacer'), stopBtn, closeBtn)

  const body = el('div', 'bubble-body')
  const userEl = el('div', 'msg msg-user')
  const assistantEl = el('div', 'msg msg-assistant')
  const toolEl = el('div', 'msg msg-tool')
  const toolIcon = el('span', 'msg-tool-icon', '🛠')
  toolIcon.setAttribute('aria-hidden', 'true')
  const toolText = el('span', 'msg-tool-text')
  toolEl.append(toolIcon, toolText)
  const errorEl = el('div', 'msg msg-error')
  errorEl.setAttribute('role', 'alert')
  body.append(userEl, assistantEl, toolEl, errorEl)

  const confirmEl = el('div', 'confirm')
  confirmEl.setAttribute('role', 'alertdialog')
  confirmEl.tabIndex = -1
  const confirmTitle = el('div', 'confirm-title')
  const confirmDetail = el('div', 'confirm-detail')
  const confirmPreview = el('pre', 'confirm-preview')
  const confirmButtons = el('div', 'confirm-buttons')
  const confirmHint = el('span', 'confirm-hint')
  const noBtn = button('btn btn-no', '', '')
  const yesBtn = button('btn btn-yes', '', '')
  confirmButtons.append(confirmHint, noBtn, yesBtn)
  confirmEl.append(confirmTitle, confirmDetail, confirmPreview, confirmButtons)

  const chatEl = el('div', 'chat')
  const textarea = el('textarea', 'chat-input')
  textarea.rows = 1
  textarea.spellcheck = false
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('enterkeyhint', 'send')
  const sendBtn = button('btn-send', '➤', '')
  chatEl.append(textarea, sendBtn)

  card.append(head, body, confirmEl, chatEl)
  root.append(card, tailSvg())

  for (const node of [userEl, assistantEl, toolEl, errorEl, confirmEl, chatEl]) node.hidden = true

  document.documentElement.lang = language
  applyLabels()
  setFontSize(options.fontSize)
  setTheme(options.theme ?? 'auto')
  renderHead()

  // ---- i18n ---------------------------------------------------------------------------------------
  function applyLabels(): void {
    stopBtn.title = t('stop', language)
    stopBtn.setAttribute('aria-label', stopBtn.title)
    closeBtn.title = t('close', language)
    closeBtn.setAttribute('aria-label', closeBtn.title)
    textarea.placeholder = t('typeMessage', language)
    textarea.title = t('inputHint', language)
    sendBtn.title = t('send', language)
    sendBtn.setAttribute('aria-label', sendBtn.title)
    yesBtn.textContent = t('yes', language)
    noBtn.textContent = t('no', language)
    confirmHint.textContent = t('confirmHint', language)
    toolIcon.title = t('tool', language)
    errorEl.setAttribute('aria-label', t('error', language))
    userEl.setAttribute('aria-label', t('you', language))
    if (lastConfirm) renderConfirm(lastConfirm)
    renderHead()
  }

  // ---- visibility / auto-hide ---------------------------------------------------------------------
  function clearHideTimer(): void {
    if (hideTimer !== null) clearTimeout(hideTimer)
    hideTimer = null
  }

  function show(): void {
    if (disposed || visible) return
    visible = true
    root.dataset['visible'] = 'true'
    scheduleReposition()
  }

  function doHide(): void {
    clearHideTimer()
    if (!visible) return
    visible = false
    root.dataset['visible'] = 'false'
    setHovering(false)
  }

  function hide(delayMs = AUTO_HIDE_MS): void {
    clearHideTimer()
    if (disposed) return
    if (delayMs <= 0) {
      // Explicit immediate hide (she was hidden / recording was empty): dismiss whatever is open.
      if (pending) settleConfirm(false)
      if (chatOpen) closeChatInput()
      doHide()
      return
    }
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (canAutoHide({ state, confirmPending: pending !== null, chatOpen })) doHide()
    }, delayMs)
  }

  /** Content changed: make sure the bubble is visible and restart the auto-hide countdown. */
  function touch(): void {
    show()
    hide(AUTO_HIDE_MS)
    scheduleReposition()
  }

  function clearContent(): void {
    userEl.textContent = ''
    userEl.hidden = true
    userTextFresh = false
    assistantTurn = null
    assistantText = ''
    streaming = false
    spokenSentence = ''
    spokenRange = null
    assistantEl.replaceChildren()
    assistantEl.hidden = true
    assistantEl.classList.remove('streaming')
    toolText.textContent = ''
    toolEl.hidden = true
    errorEl.textContent = ''
    errorEl.hidden = true
  }

  // ---- positioning --------------------------------------------------------------------------------
  function reposition(): void {
    repositionQueued = false
    if (disposed || !anchor) return
    const width = root.offsetWidth
    const height = root.offsetHeight
    if (width <= 0 || height <= 0) return
    const placement = pickBubblePosition(anchor.character, { width, height }, anchor.workArea)
    root.style.left = `${placement.x}px`
    root.style.top = `${placement.y}px`
    root.dataset['side'] = placement.side
    root.style.setProperty('--tail-offset', `${placement.tailOffset}px`)
  }

  function scheduleReposition(): void {
    if (repositionQueued || disposed || !anchor) return
    repositionQueued = true
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reposition)
    else reposition()
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleReposition()) : null
  resizeObserver?.observe(card)

  // ---- interactivity ------------------------------------------------------------------------------
  function updateInteractive(): void {
    const next = !disposed && (chatOpen || pending !== null || hovering)
    if (next === interactive) return
    interactive = next
    root.dataset['interactive'] = String(next)
    options.onInteractiveChange(next)
  }

  function setHovering(next: boolean): void {
    if (hovering === next) return
    hovering = next
    updateInteractive()
  }

  // ---- head: chip + buttons -------------------------------------------------------------------------
  function renderHead(): void {
    const kind = chipKindForState(state)
    const labelKey = chipLabelKey(state)
    if (kind && labelKey) {
      chip.dataset['kind'] = kind
      chipLabel.textContent = t(labelKey, language)
      chip.hidden = false
    } else {
      delete chip.dataset['kind']
      chip.hidden = true
    }
    stopBtn.hidden = !canInterrupt(state)
    closeBtn.hidden = !chatOpen
    head.hidden = chip.hidden && stopBtn.hidden && closeBtn.hidden
  }

  // ---- assistant text + spoken highlight ----------------------------------------------------------
  function renderAssistant(): void {
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 40
    const range = spokenRange && spokenRange.end <= assistantText.length ? spokenRange : null
    if (range) {
      const mark = el('mark', 'spoken', assistantText.slice(range.start, range.end))
      assistantEl.replaceChildren(
        document.createTextNode(assistantText.slice(0, range.start)),
        mark,
        document.createTextNode(assistantText.slice(range.end)),
      )
    } else {
      assistantEl.textContent = assistantText
    }
    assistantEl.classList.toggle('streaming', streaming)
    assistantEl.hidden = assistantText.length === 0 && !streaming
    if (stick) body.scrollTop = body.scrollHeight
  }

  function beginAssistant(turnId: string): void {
    assistantTurn = turnId
    assistantText = ''
    streaming = true
    spokenSentence = ''
    spokenRange = null
    if (!userTextFresh) {
      userEl.textContent = ''
      userEl.hidden = true
    }
    userTextFresh = false
    toolText.textContent = ''
    toolEl.hidden = true
    errorEl.textContent = ''
    errorEl.hidden = true
    renderAssistant()
  }

  // ---- confirm --------------------------------------------------------------------------------------
  function renderConfirm(request: ConfirmRequest): void {
    confirmTitle.textContent = request.title.trim() || t('confirmTitleDefault', language)
    confirmDetail.textContent = request.detail
    confirmDetail.hidden = !request.detail
    confirmPreview.textContent = request.preview ?? ''
    confirmPreview.hidden = !request.preview
    confirmEl.dataset['danger'] = String(request.danger)
    confirmEl.setAttribute('aria-label', `${request.danger ? `${t('danger', language)}: ` : ''}${confirmTitle.textContent}`)
  }

  function settleConfirm(approved: boolean): void {
    if (!pending) return
    const current = pending
    pending = null
    lastConfirm = null
    clearTimeout(current.timer)
    confirmEl.hidden = true
    updateInteractive()
    if (!disposed) {
      if (chatOpen) textarea.focus({ preventScroll: true })
      else if (options.focusForConfirm !== false) options.onInputFocusChange(false)
      hide(AUTO_HIDE_MS)
    }
    current.resolve(approved)
  }

  function confirm(request: ConfirmRequest): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    if (pending) settleConfirm(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settleConfirm(false), CONFIRM_TIMEOUT_MS)
      pending = { id: request.id, resolve, timer }
      lastConfirm = request
      renderConfirm(request)
      confirmEl.hidden = false
      show()
      clearHideTimer()
      updateInteractive()
      if (options.focusForConfirm !== false) options.onInputFocusChange(true)
      yesBtn.focus({ preventScroll: true })
      scheduleReposition()
    })
  }

  // ---- chat input -----------------------------------------------------------------------------------
  function autosize(): void {
    textarea.style.height = 'auto'
    const cs = getComputedStyle(textarea)
    const fontPx = parseFloat(cs.fontSize) || 15
    const lineHeight = parseFloat(cs.lineHeight) || fontPx * 1.4
    const paddingY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    const borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    const contentHeight = textarea.scrollHeight - paddingY
    textarea.style.height = `${inputHeightFor(contentHeight, lineHeight, paddingY + borderY)}px`
  }

  function focusInput(): void {
    textarea.focus({ preventScroll: true })
    const end = textarea.value.length
    try {
      textarea.setSelectionRange(end, end)
    } catch {
      // not focusable yet – harmless
    }
  }

  function openChatInput(prefill?: string): void {
    if (disposed) return
    if (!visible && !pending) clearContent() // fresh start when she was already hidden
    chatOpen = true
    chatOpenedAt = Date.now()
    chatEl.hidden = false
    if (prefill !== undefined) textarea.value = prefill
    autosize()
    renderHead()
    show()
    clearHideTimer()
    updateInteractive()
    // Always re-request focus: the hotkey may be pressed again after the window lost focus (Alt+Tab).
    options.onInputFocusChange(true)
    focusInput()
    scheduleReposition()
  }

  function closeChatInput(): void {
    if (!chatOpen) return
    chatOpen = false
    chatEl.hidden = true
    textarea.blur()
    renderHead()
    updateInteractive()
    if (!disposed) {
      if (!pending || options.focusForConfirm === false) options.onInputFocusChange(false)
      hide(AUTO_HIDE_MS)
      scheduleReposition()
    }
  }

  function submit(): void {
    const text = textarea.value.trim()
    if (!text) return
    textarea.value = ''
    autosize()
    closeChatInput()
    // Instant feedback: show the message as the new turn's user line (main echoes it via turn:userText).
    assistantTurn = null
    assistantText = ''
    streaming = false
    spokenSentence = ''
    spokenRange = null
    assistantEl.replaceChildren()
    assistantEl.hidden = true
    assistantEl.classList.remove('streaming')
    toolEl.hidden = true
    errorEl.hidden = true
    showUserText(text)
    options.onSubmitText(text)
  }

  // ---- events ---------------------------------------------------------------------------------------
  const onMouseEnter = (): void => setHovering(true)
  const onMouseLeave = (): void => setHovering(false)
  const onStopClick = (): void => options.onInterrupt()
  const onCloseClick = (): void => closeChatInput()
  const onYesClick = (): void => settleConfirm(true)
  const onNoClick = (): void => settleConfirm(false)
  const onSendClick = (): void => submit()
  const onInput = (): void => autosize()

  const onTextareaKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeChatInput()
      if (state === 'speaking') options.onInterrupt()
    }
  }

  /** Keyboard for the confirm panel (works wherever focus is inside the page) and Escape = stop. */
  const onDocumentKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing) return
    if (pending) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        settleConfirm(false)
      } else if (e.key === 'Enter' && e.target !== textarea) {
        e.preventDefault()
        e.stopPropagation()
        settleConfirm(true)
      }
      return
    }
    if (e.key === 'Escape' && !chatOpen && state === 'speaking') options.onInterrupt()
  }

  /** A click outside the bubble (only possible while the window is interactive) closes chat / dismisses a confirm. */
  const onDocumentMousedown = (e: MouseEvent): void => {
    const target = e.target
    if (target instanceof Node && root.contains(target)) return
    if (pending) settleConfirm(false)
    if (chatOpen) closeChatInput()
  }

  const onWindowFocus = (): void => {
    if (chatOpen && !pending) focusInput()
  }

  /**
   * The window lost focus (Alt+Tab, another app activated): close the chat so the overlay does not
   * stay interactive – an open input keeps the whole transparent window from being click-through.
   * A short grace period skips the focus churn right after opening.
   */
  const onWindowBlur = (): void => {
    if (chatOpen && !pending && Date.now() - chatOpenedAt > BLUR_CLOSE_GRACE_MS) closeChatInput()
  }

  root.addEventListener('mouseenter', onMouseEnter)
  root.addEventListener('mouseleave', onMouseLeave)
  stopBtn.addEventListener('click', onStopClick)
  closeBtn.addEventListener('click', onCloseClick)
  yesBtn.addEventListener('click', onYesClick)
  noBtn.addEventListener('click', onNoClick)
  sendBtn.addEventListener('click', onSendClick)
  textarea.addEventListener('input', onInput)
  textarea.addEventListener('keydown', onTextareaKeydown)
  document.addEventListener('keydown', onDocumentKeydown, true)
  document.addEventListener('mousedown', onDocumentMousedown, true)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('blur', onWindowBlur)

  // ---- public API ------------------------------------------------------------------------------------
  function setAnchor(characterRect: Rect, workArea: Rect): void {
    anchor = { character: { ...characterRect }, workArea: { ...workArea } }
    reposition()
  }

  function beginListening(): void {
    clearContent()
    show()
    clearHideTimer()
  }

  function setState(next: CompanionState): void {
    if (disposed) return
    const prev = state
    if (next === prev) return
    state = next
    root.dataset['state'] = next
    renderHead()
    if (next === 'listening') beginListening()
    else if (next === 'sleeping') hide(0)
    else if (isBusyState(next)) {
      show()
      clearHideTimer()
    } else if (isBusyState(prev)) {
      // Back to idle/error: give the user time to read, then fade out.
      hide(AUTO_HIDE_MS)
    }
    scheduleReposition()
  }

  function showListening(): void {
    if (disposed) return
    if (state !== 'listening') {
      state = 'listening'
      root.dataset['state'] = state
      renderHead()
    }
    beginListening()
    scheduleReposition()
  }

  function setInputLevel(raw: number): void {
    level = smoothLevel(level, raw)
    root.style.setProperty('--level', String(level))
  }

  function showUserText(text: string): void {
    if (disposed) return
    userEl.textContent = text
    userEl.hidden = text.length === 0
    userTextFresh = true
    touch()
  }

  function startAssistant(turnId: string): void {
    if (disposed) return
    beginAssistant(turnId)
    touch()
  }

  function appendAssistant(turnId: string, delta: string): void {
    if (disposed) return
    if (assistantTurn !== turnId) beginAssistant(turnId)
    if (!delta) return
    assistantText += delta
    renderAssistant()
    touch()
  }

  function finishAssistant(turnId: string, finalText: string): void {
    if (disposed) return
    if (assistantTurn !== null && assistantTurn !== turnId) return // a late finish for an old turn
    if (assistantTurn === null) beginAssistant(turnId)
    assistantText = finalText
    streaming = false
    spokenRange = spokenSentence ? findSpokenRange(assistantText, spokenSentence, spokenRange?.start ?? 0) : null
    renderAssistant()
    touch()
  }

  function showSpokenSentence(turnId: string, text: string): void {
    if (disposed || assistantTurn !== turnId) return
    const sentence = text.trim()
    if (!sentence) {
      spokenSentence = ''
      spokenRange = null
      renderAssistant()
      return
    }
    spokenSentence = sentence
    spokenRange = findSpokenRange(assistantText, sentence, spokenRange?.end ?? 0)
    renderAssistant()
    const mark = assistantEl.querySelector('mark.spoken')
    if (mark && typeof mark.scrollIntoView === 'function') mark.scrollIntoView({ block: 'nearest' })
    touch()
  }

  function showToolProgress(summary: string): void {
    if (disposed) return
    toolText.textContent = summary
    toolEl.hidden = summary.trim().length === 0
    touch()
  }

  function showError(message: string): void {
    if (disposed) return
    errorEl.textContent = message
    errorEl.hidden = message.trim().length === 0
    touch()
  }

  function resolveConfirm(id: string): void {
    if (pending && pending.id === id) settleConfirm(false)
  }

  function setFontSize(px: number): void {
    root.style.setProperty('--bubble-font', `${clampFontSize(px)}px`)
    scheduleReposition()
  }

  function setLanguage(next: Language): void {
    language = next
    document.documentElement.lang = next
    applyLabels()
  }

  function setTheme(theme: 'auto' | 'light' | 'dark'): void {
    if (theme === 'auto') delete root.dataset['theme']
    else root.dataset['theme'] = theme
  }

  function dispose(): void {
    if (disposed) return
    clearHideTimer()
    if (pending) {
      const current = pending
      pending = null
      lastConfirm = null
      clearTimeout(current.timer)
      current.resolve(false)
    }
    const wasInteractive = interactive
    const wasOpen = chatOpen
    chatOpen = false
    hovering = false
    interactive = false
    disposed = true
    resizeObserver?.disconnect()
    root.removeEventListener('mouseenter', onMouseEnter)
    root.removeEventListener('mouseleave', onMouseLeave)
    document.removeEventListener('keydown', onDocumentKeydown, true)
    document.removeEventListener('mousedown', onDocumentMousedown, true)
    window.removeEventListener('focus', onWindowFocus)
    window.removeEventListener('blur', onWindowBlur)
    root.replaceChildren()
    root.dataset['visible'] = 'false'
    root.dataset['interactive'] = 'false'
    visible = false
    if (wasOpen) options.onInputFocusChange(false)
    if (wasInteractive) options.onInteractiveChange(false)
  }

  return {
    setAnchor,
    setState,
    showListening,
    setInputLevel,
    showUserText,
    startAssistant,
    appendAssistant,
    finishAssistant,
    showSpokenSentence,
    showToolProgress,
    showError,
    confirm,
    resolveConfirm,
    openChatInput,
    closeChatInput,
    isChatInputOpen: () => chatOpen,
    isInteractive: () => interactive,
    hide,
    setFontSize,
    setLanguage,
    setTheme,
    isConfirmPending: () => pending !== null,
    isVisible: () => visible,
    dispose,
  }
}
