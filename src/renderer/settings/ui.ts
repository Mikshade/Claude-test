/**
 * Tiny DOM helpers for the settings page (no framework). Everything is plain elements + classes
 * styled by styles.css. Controls take explicit callbacks; data binding lives in pages/bind.ts.
 *
 * OWNER: settings-ui agent.
 */

export type Child = Node | string | number | null | undefined | false | Child[]

/** Attribute map for `el`: `class`, `style`, `dataset`, `on<Event>` handlers, booleans (false = omitted). */
export type Attrs = Record<string, string | number | boolean | EventListener | Record<string, string> | undefined | null>

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c)
    return
  }
  parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class' || key === 'className') node.className = String(value)
      else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value)
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
      else if (value === true) node.setAttribute(key, '')
      else node.setAttribute(key, String(value))
    }
  }
  append(node, children)
  return node
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function replaceChildren(node: Node, ...children: Child[]): void {
  clear(node)
  append(node, children)
}

// ---- layout -------------------------------------------------------------------------------------

export function section(title: string, description: string | null, ...children: Child[]): HTMLElement {
  return el(
    'section',
    { class: 'card' },
    el('header', { class: 'card-header' }, el('h2', null, title), description ? el('p', { class: 'muted' }, description) : null),
    el('div', { class: 'card-body' }, ...children),
  )
}

export type NoteKind = 'info' | 'ok' | 'warn' | 'danger'

export function note(kind: NoteKind, ...children: Child[]): HTMLElement {
  return el('div', { class: `note note-${kind}`, role: kind === 'danger' || kind === 'warn' ? 'alert' : 'note' }, ...children)
}

export function row(...children: Child[]): HTMLElement {
  return el('div', { class: 'row' }, ...children)
}

export interface FieldElement extends HTMLElement {
  setWarning(text: string | null): void
  setHint(text: string | null): void
}

export interface FieldOptions {
  hint?: string | null
  warning?: string | null
  /** Label and control side by side (toggles use their own layout). */
  inline?: boolean
}

/** Label + control + optional hint/warning. `setWarning()` updates the warning line in place. */
export function field(label: string, control: Child, options: FieldOptions = {}): FieldElement {
  const hint = el('p', { class: 'field-hint' })
  const warning = el('p', { class: 'field-warning', role: 'alert' })
  const node = el(
    'div',
    { class: `field${options.inline ? ' field-inline' : ''}` },
    el('label', { class: 'field-label' }, label),
    el('div', { class: 'field-control' }, control),
    hint,
    warning,
  ) as FieldElement
  node.setHint = (text) => {
    hint.textContent = text ?? ''
    hint.hidden = !text
  }
  node.setWarning = (text) => {
    warning.textContent = text ?? ''
    warning.hidden = !text
    node.classList.toggle('has-warning', Boolean(text))
  }
  node.setHint(options.hint ?? null)
  node.setWarning(options.warning ?? null)
  return node
}

// ---- controls -----------------------------------------------------------------------------------

export interface TextInputOptions {
  value: string
  placeholder?: string
  type?: 'text' | 'password' | 'url' | 'number'
  /** Fired on every keystroke. */
  onInput?: (value: string) => void
  /** Fired on change/blur (commit). */
  onCommit?: (value: string) => void
  disabled?: boolean
  spellcheck?: boolean
  /** Used to restore focus after a re-render. */
  path?: string
  min?: number
  max?: number
  step?: number
}

export function textInput(options: TextInputOptions): HTMLInputElement {
  const input = el('input', {
    class: 'input',
    type: options.type ?? 'text',
    value: options.value,
    placeholder: options.placeholder,
    disabled: options.disabled,
    spellcheck: options.spellcheck === true ? 'true' : 'false',
    autocomplete: 'off',
    dataset: options.path ? { path: options.path } : undefined,
    min: options.min,
    max: options.max,
    step: options.step,
  })
  input.addEventListener('input', () => options.onInput?.(input.value))
  input.addEventListener('change', () => options.onCommit?.(input.value))
  return input
}

/** Password input with a show/hide toggle. */
export function secretInput(options: Omit<TextInputOptions, 'type'> & { showLabel: string; hideLabel: string }): HTMLElement {
  const input = textInput({ ...options, type: 'password' })
  const toggle = el('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-label': options.showLabel }, options.showLabel)
  toggle.addEventListener('click', () => {
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    toggle.textContent = show ? options.hideLabel : options.showLabel
  })
  return el('div', { class: 'input-group' }, input, toggle)
}

export interface TextareaOptions {
  value: string
  placeholder?: string
  rows?: number
  onInput?: (value: string) => void
  onCommit?: (value: string) => void
  path?: string
}

export function textarea(options: TextareaOptions): HTMLTextAreaElement {
  const area = el('textarea', {
    class: 'input textarea',
    rows: options.rows ?? 5,
    placeholder: options.placeholder,
    spellcheck: 'false',
    dataset: options.path ? { path: options.path } : undefined,
  })
  area.value = options.value
  area.addEventListener('input', () => options.onInput?.(area.value))
  area.addEventListener('change', () => options.onCommit?.(area.value))
  return area
}

export interface SliderOptions {
  value: number
  min: number
  max: number
  step?: number
  /** Formats the value shown next to the slider. */
  format?: (value: number) => string
  onInput?: (value: number) => void
  onCommit?: (value: number) => void
  path?: string
}

export interface SliderElement extends HTMLElement {
  setValue(value: number): void
}

export function slider(options: SliderOptions): SliderElement {
  const format = options.format ?? ((v: number) => String(v))
  const input = el('input', {
    class: 'range',
    type: 'range',
    min: options.min,
    max: options.max,
    step: options.step ?? 1,
    value: options.value,
    dataset: options.path ? { path: options.path } : undefined,
  })
  const output = el('output', { class: 'range-value' }, format(options.value))
  const parse = (): number => {
    const n = Number(input.value)
    const step = options.step ?? 1
    return Number.isInteger(step) ? Math.round(n) : n
  }
  input.addEventListener('input', () => {
    const v = parse()
    output.textContent = format(v)
    options.onInput?.(v)
  })
  input.addEventListener('change', () => options.onCommit?.(parse()))
  const node = el('div', { class: 'slider' }, input, output) as SliderElement
  node.setValue = (value) => {
    input.value = String(value)
    output.textContent = format(value)
  }
  return node
}

export interface SelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectOptions<T extends string> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onChange: (value: T) => void
  path?: string
  disabled?: boolean
}

export function select<T extends string>(options: SelectOptions<T>): HTMLSelectElement {
  const node = el('select', { class: 'input select', dataset: options.path ? { path: options.path } : undefined, disabled: options.disabled })
  for (const opt of options.options) {
    const o = el('option', { value: opt.value, disabled: opt.disabled }, opt.label)
    if (opt.value === options.value) o.selected = true
    node.appendChild(o)
  }
  node.addEventListener('change', () => options.onChange(node.value as T))
  return node
}

export interface ToggleOptions {
  checked: boolean
  label: string
  description?: string | null
  onChange: (checked: boolean) => void
  path?: string
  disabled?: boolean
}

/** A switch with label + description (its own row layout). */
export function toggle(options: ToggleOptions): HTMLLabelElement {
  const input = el('input', { type: 'checkbox', class: 'switch-input', dataset: options.path ? { path: options.path } : undefined, disabled: options.disabled })
  input.checked = options.checked
  input.addEventListener('change', () => options.onChange(input.checked))
  return el(
    'label',
    { class: 'switch' },
    input,
    el('span', { class: 'switch-track' }, el('span', { class: 'switch-thumb' })),
    el('span', { class: 'switch-text' }, el('span', { class: 'switch-label' }, options.label), options.description ? el('span', { class: 'switch-desc' }, options.description) : null),
  )
}

export interface RadioOption<T extends string> {
  value: T
  label: string
  description?: string
}

export interface RadioGroupOptions<T extends string> {
  name: string
  value: T
  options: ReadonlyArray<RadioOption<T>>
  onChange: (value: T) => void
}

/** Vertical radio cards with a description line each. */
export function radioGroup<T extends string>(options: RadioGroupOptions<T>): HTMLElement {
  const group = el('div', { class: 'radio-group', role: 'radiogroup' })
  for (const opt of options.options) {
    const input = el('input', { type: 'radio', name: options.name, value: opt.value, class: 'radio-input' })
    input.checked = opt.value === options.value
    input.addEventListener('change', () => {
      if (input.checked) options.onChange(opt.value)
    })
    group.appendChild(
      el(
        'label',
        { class: 'radio-card' },
        input,
        el('span', { class: 'radio-text' }, el('span', { class: 'radio-label' }, opt.label), opt.description ? el('span', { class: 'radio-desc' }, opt.description) : null),
      ),
    )
  }
  return group
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonOptions {
  variant?: ButtonVariant
  disabled?: boolean
  small?: boolean
  title?: string
}

export function button(label: Child, onClick: (event: MouseEvent) => void, options: ButtonOptions = {}): HTMLButtonElement {
  const node = el(
    'button',
    { class: `btn btn-${options.variant ?? 'secondary'}${options.small ? ' btn-small' : ''}`, type: 'button', disabled: options.disabled, title: options.title },
    label,
  )
  node.addEventListener('click', (e) => onClick(e))
  return node
}

/** Async button: disables itself and shows `busyLabel` while the handler runs. */
export function asyncButton(label: string, busyLabel: string, handler: () => Promise<void>, options: ButtonOptions = {}): HTMLButtonElement {
  const node = button(label, () => void run(), options)
  async function run(): Promise<void> {
    if (node.disabled) return
    node.disabled = true
    node.textContent = busyLabel
    try {
      await handler()
    } finally {
      node.disabled = options.disabled ?? false
      node.textContent = label
    }
  }
  return node
}

/** External link – opened by the main process (the sandboxed page cannot navigate). */
export function link(text: string, url: string): HTMLAnchorElement {
  const a = el('a', { href: url, class: 'link' }, text)
  a.addEventListener('click', (e) => {
    e.preventDefault()
    void window.flowy.invoke('app:openExternal', url)
  })
  return a
}

export interface StatusLine {
  element: HTMLElement
  set(kind: NoteKind | 'busy' | null, text?: string): void
}

/** A one-line status area for test results ("busy" shows a spinner). */
export function statusLine(): StatusLine {
  const element = el('div', { class: 'status', 'aria-live': 'polite' })
  element.hidden = true
  return {
    element,
    set(kind, text = '') {
      element.className = `status${kind ? ` status-${kind}` : ''}`
      element.textContent = text
      element.hidden = !kind
    },
  }
}

export function kbd(text: string): HTMLElement {
  return el('kbd', { class: 'kbd' }, text)
}

/** Replace the children of `node` with the result of `renderFn` while keeping scroll + focus where possible. */
export function rerenderInto(node: HTMLElement, renderFn: () => Child): void {
  const active = document.activeElement as HTMLElement | null
  const path = active?.dataset?.['path']
  const scrollTop = node.scrollTop
  replaceChildren(node, renderFn())
  node.scrollTop = scrollTop
  if (path) {
    const next = node.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)
    next?.focus({ preventScroll: true })
  }
}
