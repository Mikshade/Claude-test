/**
 * Minimal in-page microphone capture for the STT test: getUserMedia → ScriptProcessor → Float32 →
 * 16 kHz mono 16-bit WAV. Deliberately tiny (the overlay has the real recorder with VAD).
 *
 * OWNER: settings-ui agent. DOM/WebAudio only – not unit-tested.
 */
import type { RecordedAudio } from '@shared/ipc'
import { concatFloat32, floatToWav, rms, STT_SAMPLE_RATE } from './wav'

export interface MicCaptureOptions {
  deviceId: string
  durationMs: number
  /** Called ~20× per second with the current input level 0..1. */
  onLevel?: (level: number) => void
}

export function micConstraints(deviceId: string): MediaStreamConstraints {
  const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  if (deviceId) audio.deviceId = { exact: deviceId }
  return { audio, video: false }
}

/** Record `durationMs` of microphone audio and return it as RecordedAudio (WAV). */
export async function captureMicrophone(options: MicCaptureOptions): Promise<RecordedAudio> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(micConstraints(options.deviceId))
  } catch (err) {
    if (options.deviceId && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      // The configured device is gone – fall back to the default one.
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(''))
    } else {
      throw err
    }
  }

  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  // ScriptProcessorNode is deprecated but needs no worklet file and is fine for a 3 s test.
  const processor = context.createScriptProcessor(4096, 1, 1)
  const silent = context.createGain()
  silent.gain.value = 0
  const frames: Float32Array[] = []
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    frames.push(new Float32Array(input))
    options.onLevel?.(Math.min(1, rms(input) * 4))
  }
  source.connect(processor)
  processor.connect(silent)
  silent.connect(context.destination)
  if (context.state === 'suspended') await context.resume()

  await new Promise<void>((resolve) => setTimeout(resolve, options.durationMs))

  processor.disconnect()
  source.disconnect()
  silent.disconnect()
  for (const track of stream.getTracks()) track.stop()
  const captureRate = context.sampleRate
  await context.close().catch(() => undefined)

  const samples = concatFloat32(frames)
  const wav = floatToWav(samples, captureRate, STT_SAMPLE_RATE)
  return { data: wav, mimeType: 'audio/wav', durationMs: Math.round((samples.length / captureRate) * 1000) }
}

export interface AudioDevice {
  deviceId: string
  label: string
}

/** Enumerate input/output devices (labels are empty until the user granted microphone access once). */
export async function listAudioDevices(kind: 'audioinput' | 'audiooutput'): Promise<AudioDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Mic' : 'Out'} ${i + 1}` }))
  } catch (err) {
    console.warn('[settings] enumerateDevices failed', err)
    return []
  }
}

/** Describe a getUserMedia failure for the user. */
export function describeMicError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'permission denied'
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'no microphone found'
      case 'NotReadableError':
        return 'microphone busy'
      default:
        return err.message || err.name
    }
  }
  return err instanceof Error ? err.message : String(err)
}
