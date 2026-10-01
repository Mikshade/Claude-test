/**
 * Speech-to-text provider contract.
 */
import type { RecordedAudio, TestResult } from '@shared/ipc'

export interface SttClient {
  readonly name: string
  /** Returns the transcript (may be empty when nothing was understood). */
  transcribe(audio: RecordedAudio, languageHint?: string, signal?: AbortSignal): Promise<string>
  test(audio?: RecordedAudio): Promise<TestResult>
}
