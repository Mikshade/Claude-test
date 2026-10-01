/**
 * Bridges tool confirmation requests to the orchestrator/overlay UI.
 */
import type { ConfirmRequest } from '@shared/state'
import type { Orchestrator } from './orchestrator'

export function requestConfirmation(orchestrator: Orchestrator, req: Omit<ConfirmRequest, 'id'>): Promise<boolean> {
  return orchestrator.confirm(req)
}
