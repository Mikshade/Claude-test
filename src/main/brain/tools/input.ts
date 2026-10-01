/**
 * Input injection tools: type text, press key combinations, click. They act on whatever app has focus,
 * so they are destructive (confirmation at 'confirm-destructive').
 */
import { z } from 'zod'
import { requireSystem } from './apps'
import { type AnyFlowyTool, defineTool, ok, shorten } from './gating'
import type { ToolServices } from './registry'

export const MAX_TYPE_CHARS = 10_000
const CLICK_LABELS = { left: 'Klick', right: 'Rechtsklick', double: 'Doppelklick' } as const

export function inputTools(services: ToolServices): AnyFlowyTool[] {
  const typeText = defineTool({
    name: 'type_text',
    category: 'input',
    destructive: true,
    readOnly: false,
    description:
      'Type text into the currently focused window as keyboard input (unicode-safe; "\\n" presses Enter). Focus the ' +
      'right window first (focus_window) and prefer set_clipboard + Ctrl+V for long texts.',
    inputSchema: z.object({ text: z.string().min(1).max(MAX_TYPE_CHARS).describe(`Text to type (max ${MAX_TYPE_CHARS} characters).`) }),
    summarize: (input) => `Tippe Text: ${shorten(input.text, 40)}`,
    confirmation: (input) => ({ title: 'Text eintippen?', detail: 'In das aktive Fenster', preview: shorten(input.text, 300) }),
    async execute(input) {
      await requireSystem(services).typeText(input.text)
      return ok(`Getippt: ${input.text.length} Zeichen.`)
    },
  })

  const pressKeys = defineTool({
    name: 'press_keys',
    category: 'input',
    destructive: true,
    readOnly: false,
    description:
      'Press a key or key combination in the focused window, e.g. "Ctrl+S", "Alt+F4", "Win+D", "Enter", "Ctrl+Shift+Esc", "F5". ' +
      'Modifiers: Ctrl, Alt, Shift, Win; keys: letters, digits, F1–F24, Enter, Tab, Esc, Space, Backspace, Delete, Home, End, ' +
      'PageUp, PageDown, Up, Down, Left, Right. One combination per call.',
    inputSchema: z.object({ combo: z.string().min(1).max(60).describe('Keys joined with "+", e.g. "Ctrl+Shift+T".') }),
    summarize: (input) => `Tastenkombination: ${input.combo}`,
    confirmation: (input) => ({ title: 'Tasten drücken?', detail: input.combo }),
    async execute(input) {
      await requireSystem(services).pressKeys(input.combo.trim())
      return ok(`Gedrückt: ${input.combo}`)
    },
  })

  const click = defineTool({
    name: 'click_at',
    category: 'input',
    destructive: true,
    readOnly: false,
    description:
      'Move the mouse to screen coordinates and click (left, right or double). Coordinates are physical screen pixels with ' +
      'the origin at the top-left of the primary display – when you derived them from a downscaled take_screenshot, scale ' +
      'them back to the real screen size first.',
    inputSchema: z.object({
      x: z.number().int().describe('Horizontal screen position in pixels.'),
      y: z.number().int().describe('Vertical screen position in pixels.'),
      button: z.enum(['left', 'right', 'double']).default('left').describe('left (default), right or double (double-click).'),
    }),
    summarize: (input) => `${CLICK_LABELS[input.button]} bei (${input.x}, ${input.y})`,
    confirmation: (input) => ({ title: 'Mausklick ausführen?', detail: `${input.button} bei (${input.x}, ${input.y})` }),
    async execute(input) {
      await requireSystem(services).clickAt(input.x, input.y, input.button)
      return ok(`Geklickt (${input.button}) bei (${input.x}, ${input.y}).`)
    },
  })

  return [typeText, pressKeys, click]
}
