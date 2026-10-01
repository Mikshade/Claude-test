/**
 * Long-term memory: small JSON list of notes the brain stores with the `remember` tool and recalls
 * with `recall` (simple keyword scoring – no embeddings). A compact digest of recent notes is
 * injected into each turn's context.
 *
 * OWNER: tools agent.
 */

export interface Note {
  id: string
  text: string
  tags: string[]
  createdAt: number
}

export interface NotesStore {
  add(text: string, tags?: string[]): Note
  remove(id: string): boolean
  search(query: string, limit?: number): Note[]
  all(): Note[]
  /** Short text block (<= ~1500 chars) summarizing the most relevant/recent notes. */
  digest(): string
}

export function createNotesStore(_filePath: string): NotesStore {
  throw new Error('not implemented: createNotesStore (src/main/memory/notes.ts)')
}
