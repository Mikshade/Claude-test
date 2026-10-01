/**
 * Overlay renderer entry: character (Live2D or fallback), movement/avoidance, bubble UI, audio.
 *
 * OWNER: renderer-core agent (character + movement), renderer-ui agent (bubble/chat/confirm),
 * audio agent (recorder/player). This file wires them together – keep it thin.
 */
import type { CompanionState } from '@shared/state'

async function main(): Promise<void> {
  const api = window.flowy
  const config = await api.invoke('config:get')
  const info = await api.invoke('app:getInfo')
  console.info('[overlay] boot', { version: info.version, model: config.avatar.modelPath || info.defaultModelPath })

  api.on('state:changed', (state: CompanionState) => {
    document.body.dataset['state'] = state
  })
}

void main()
