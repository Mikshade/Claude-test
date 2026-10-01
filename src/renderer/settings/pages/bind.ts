/**
 * Config-bound controls: read the current value from a dot-path, write changes through the store.
 * Text/sliders are debounced by the store, selects/toggles/radios are flushed immediately.
 *
 * OWNER: settings-ui agent.
 */
import { t } from '../i18n'
import { getPath } from '../store'
import {
  field,
  type FieldElement,
  radioGroup,
  type RadioOption,
  secretInput,
  select,
  type SelectOption,
  slider,
  type SliderElement,
  textarea,
  textInput,
  toggle,
} from '../ui'
import type { PageContext } from './context'

function str(ctx: PageContext, path: string): string {
  const v = getPath(ctx.config, path)
  return v === undefined || v === null ? '' : String(v)
}

function num(ctx: PageContext, path: string, fallback = 0): number {
  const v = getPath(ctx.config, path)
  return typeof v === 'number' ? v : fallback
}

function bool(ctx: PageContext, path: string): boolean {
  return getPath(ctx.config, path) === true
}

export interface BoundTextOptions {
  placeholder?: string
  type?: 'text' | 'url'
  /** Transform the typed value before it is stored (e.g. trim). */
  map?: (value: string) => string
  disabled?: boolean
}

export function boundText(ctx: PageContext, path: string, options: BoundTextOptions = {}): HTMLInputElement {
  const map = options.map ?? ((v: string) => v)
  return textInput({
    value: str(ctx, path),
    placeholder: options.placeholder,
    type: options.type,
    path,
    disabled: options.disabled,
    onInput: (v) => ctx.store.set(path, map(v)),
    onCommit: () => void ctx.store.flush(),
  })
}

/** Password input with show/hide; stored trimmed. */
export function boundSecret(ctx: PageContext, path: string, placeholder = ''): HTMLElement {
  return secretInput({
    value: str(ctx, path),
    placeholder,
    path,
    showLabel: t('common.show'),
    hideLabel: t('common.hide'),
    onInput: (v) => ctx.store.set(path, v.trim()),
    onCommit: () => void ctx.store.flush(),
  })
}

export function boundTextarea(ctx: PageContext, path: string, options: { placeholder?: string; rows?: number } = {}): HTMLTextAreaElement {
  return textarea({
    value: str(ctx, path),
    placeholder: options.placeholder,
    rows: options.rows,
    path,
    onInput: (v) => ctx.store.set(path, v),
    onCommit: () => void ctx.store.flush(),
  })
}

export interface BoundSliderOptions {
  min: number
  max: number
  step?: number
  format?: (value: number) => string
}

export function boundSlider(ctx: PageContext, path: string, options: BoundSliderOptions): SliderElement {
  return slider({
    value: num(ctx, path, options.min),
    min: options.min,
    max: options.max,
    step: options.step,
    format: options.format,
    path,
    onInput: (v) => ctx.store.set(path, v),
    onCommit: () => void ctx.store.flush(),
  })
}

export function boundSelect<T extends string>(
  ctx: PageContext,
  path: string,
  options: ReadonlyArray<SelectOption<T>>,
  extra: { rerender?: boolean; map?: (value: T) => unknown; disabled?: boolean } = {},
): HTMLSelectElement {
  return select<T>({
    value: str(ctx, path) as T,
    options,
    path,
    disabled: extra.disabled,
    onChange: (v) => {
      ctx.store.set(path, extra.map ? extra.map(v) : v, { immediate: true })
      if (extra.rerender) ctx.rerender()
    },
  })
}

export function boundToggle(ctx: PageContext, path: string, label: string, description?: string | null, extra: { rerender?: boolean } = {}): HTMLLabelElement {
  return toggle({
    checked: bool(ctx, path),
    label,
    description,
    path,
    onChange: (checked) => {
      ctx.store.set(path, checked, { immediate: true })
      if (extra.rerender) ctx.rerender()
    },
  })
}

export function boundRadio<T extends string>(ctx: PageContext, path: string, options: ReadonlyArray<RadioOption<T>>, extra: { rerender?: boolean } = {}): HTMLElement {
  return radioGroup<T>({
    name: path,
    value: str(ctx, path) as T,
    options,
    onChange: (v) => {
      ctx.store.set(path, v, { immediate: true })
      if (extra.rerender) ctx.rerender()
    },
  })
}

/** A field whose warning line follows a predicate over the live config. */
export function liveField(ctx: PageContext, label: string, control: HTMLElement, options: { hint?: string | null; warn?: (config: PageContext['config']) => string | null }): FieldElement {
  const f = field(label, control, { hint: options.hint, warning: options.warn ? options.warn(ctx.config) : null })
  if (options.warn) {
    const warn = options.warn
    ctx.onConfig((config) => f.setWarning(warn(config)))
  }
  return f
}
