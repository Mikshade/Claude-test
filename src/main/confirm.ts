/**
 * Bridges tool confirmation requests to the orchestrator/overlay UI.
 *
 * OWNER: integration agent.
 */
import type { ConfirmRequest } from '@shared/state'
import type { Orchestrator } from './orchestrator'

export function requestConfirmation(_orchestrator: Orchestrator, _req: Omit<ConfirmRequest, 'id'>): Promise<boolean> {
  throw new Error('not implemented: requestConfirmation (src/main/confirm.ts)')
}
