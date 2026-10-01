/**
 * Flowy microphone tap – an AudioWorkletProcessor that batches the 128-sample render quanta of input
 * channel 0 into ~20 ms frames and posts them (transferred) to the recorder on the main thread.
 *
 * Plain JS on purpose: lib.dom has no AudioWorkletProcessor types and Vite cannot bundle worklets.
 * Lives in src/renderer/public so it is served at the renderer root (dev) / copied to out/renderer
 * (prod); the overlay loads it via new URL('../recorder-worklet.js', document.baseURI).
 *
 * Messages in:  'stop'  → flush the partial frame and go idle (process() returns false).
 * Messages out: Float32Array frames (frameSize samples, the last one may be shorter).
 *
 * OWNER: audio agent (src/renderer/overlay/audio/recorder.ts).
 */
class FlowyRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const custom = options && options.processorOptions ? options.processorOptions : {}
    const wanted = Number(custom.frameSize)
    // `sampleRate` is a global of the AudioWorkletGlobalScope (the context rate, 16000 when we got our wish).
    this.frameSize = wanted > 0 ? Math.round(wanted) : Math.max(128, Math.round(sampleRate * 0.02))
    this.buffer = new Float32Array(this.frameSize)
    this.fill = 0
    this.running = true
    this.port.onmessage = (event) => {
      if (event.data === 'stop') {
        this.flush()
        this.running = false
      }
    }
  }

  /** Post whatever is buffered (used on stop so the tail of the recording is not lost). */
  flush() {
    if (this.fill === 0) return
    const tail = this.buffer.subarray(0, this.fill).slice()
    this.port.postMessage(tail, [tail.buffer])
    this.fill = 0
  }

  process(inputs) {
    if (!this.running) return false
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel) return true
    let i = 0
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.frameSize - this.fill)
      this.buffer.set(channel.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === this.frameSize) {
        const frame = this.buffer
        this.port.postMessage(frame, [frame.buffer])
        this.buffer = new Float32Array(this.frameSize)
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('flowy-recorder', FlowyRecorderProcessor)
