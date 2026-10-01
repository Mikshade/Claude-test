/**
 * Long-term memory tools on top of memory/notes.ts: remember, recall, forget.
 */
import { z } from 'zod'
import { DEFAULT_SEARCH_LIMIT, type Note } from '../../memory/notes'
import { type AnyFlowyTool, defineTool, fail, ok, shorten } from './gating'
import type { ToolServices } from './registry'

export function formatNote(note: Note): string {
  const when = new Date(note.createdAt)
  const date = Number.isFinite(note.createdAt) && note.createdAt > 0 ? when.toISOString().slice(0, 10) : '?'
  const tags = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : ''
  return `${note.id} (${date})${tags}: ${note.text}`
}

export function memoryTools(services: ToolServices): AnyFlowyTool[] {
  const remember = defineTool({
    name: 'remember',
    category: 'memory',
    destructive: false,
    readOnly: false,
    description:
      'Store a fact for the long term (preferences, names, projects, habits, decisions) – one short, self-contained ' +
      'sentence per note. Remembering the same text again refreshes the existing note. Recent notes are shown to you ' +
      'automatically; use recall to search older ones.',
    inputSchema: z.object({
      text: z.string().trim().min(1).max(2000).describe('The fact to remember, as one self-contained sentence.'),
      tags: z.array(z.string().min(1)).max(10).optional().describe('Optional short tags, e.g. ["work", "preferences"].'),
    }),
    summarize: (input) => `Merke: ${shorten(input.text, 50)}`,
    async execute(input) {
      const note = services.notes.add(input.text, input.tags)
      return ok(`Gemerkt (${note.id}): ${note.text}`)
    },
  })

  const recall = defineTool({
    name: 'recall',
    category: 'memory',
    destructive: false,
    readOnly: true,
    description: 'Search the long-term notes by keywords. Returns the best matches with their ids (for forget).',
    inputSchema: z.object({
      query: z.string().trim().min(1).describe('Keywords to look for (German or English, substring matching).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(DEFAULT_SEARCH_LIMIT)
        .describe(`Maximum notes to return (default ${DEFAULT_SEARCH_LIMIT}).`),
    }),
    summarize: (input) => `Erinnere: ${shorten(input.query, 50)}`,
    async execute(input) {
      const notes = services.notes.search(input.query, input.limit)
      if (notes.length === 0) return ok(`Keine Notizen zu "${input.query}".`)
      return ok([`${notes.length} Notiz(en):`, ...notes.map(formatNote)].join('\n'))
    },
  })

  const forget = defineTool({
    name: 'forget',
    category: 'memory',
    destructive: false,
    readOnly: false,
    description:
      'Delete a long-term note by its id (from recall or the memory digest). Use when a fact is outdated or the user ' +
      'asks you to forget it.',
    inputSchema: z.object({ id: z.string().trim().min(1).describe('Note id, e.g. "n1abc…".') }),
    summarize: (input) => `Vergesse Notiz: ${input.id}`,
    async execute(input) {
      return services.notes.remove(input.id) ? ok(`Notiz ${input.id} gelöscht.`) : fail(`Keine Notiz mit der id ${input.id}.`)
    },
  })

  return [remember, recall, forget]
}
