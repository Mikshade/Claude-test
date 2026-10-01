/**
 * User-visible strings of the overlay bubble (German default, English alternative).
 *
 * OWNER: renderer-ui agent. Pure – unit-tested in strings.test.ts (both languages must define the same keys).
 */
import type { Language } from '@shared/config'

export const BUBBLE_STRINGS = {
  de: {
    listening: 'Hört zu',
    transcribing: 'Versteht',
    thinking: 'Denkt nach',
    speaking: 'Spricht',
    typeMessage: 'Nachricht eingeben …',
    send: 'Senden',
    yes: 'Ja',
    no: 'Nein',
    stop: 'Stopp',
    close: 'Schließen',
    confirmTitleDefault: 'Darf ich das machen?',
    confirmHint: 'Enter = Ja · Esc = Nein',
    error: 'Fehler',
    tool: 'Werkzeug',
    you: 'Du',
    danger: 'Achtung',
    inputHint: 'Enter = Senden · Shift+Enter = Zeilenumbruch · Esc = Schließen',
  },
  en: {
    listening: 'Listening',
    transcribing: 'Transcribing',
    thinking: 'Thinking',
    speaking: 'Speaking',
    typeMessage: 'Type a message …',
    send: 'Send',
    yes: 'Yes',
    no: 'No',
    stop: 'Stop',
    close: 'Close',
    confirmTitleDefault: 'May I do this?',
    confirmHint: 'Enter = Yes · Esc = No',
    error: 'Error',
    tool: 'Tool',
    you: 'You',
    danger: 'Caution',
    inputHint: 'Enter = send · Shift+Enter = new line · Esc = close',
  },
} as const satisfies Record<Language, Record<string, string>>

export type BubbleStringKey = keyof (typeof BUBBLE_STRINGS)['de']

/** Translate a bubble string; unknown languages fall back to German (the default UI language). */
export function t(key: BubbleStringKey, lang: Language): string {
  const table: Record<BubbleStringKey, string> = BUBBLE_STRINGS[lang] ?? BUBBLE_STRINGS.de
  return table[key]
}
