/**
 * Settings + first-run wizard page.
 *
 * OWNER: settings-ui agent. Vanilla TypeScript, no framework. Pages: wizard (stepper) and tabs:
 * character, voice (TTS), ears (STT), brain (LLM), look (avatar), permissions, hotkeys, behavior, about.
 */

async function main(): Promise<void> {
  const root = document.getElementById('app')
  if (!root) return
  const config = await window.flowy.invoke('config:get')
  root.textContent = `Flowy settings – ${config.character.name} (not implemented yet)`
}

void main()
