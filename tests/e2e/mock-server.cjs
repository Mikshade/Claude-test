// Mock Anthropic Messages API (SSE streaming, one tool round trip), Fish Speech local TTS and an
// OpenAI-compatible transcription endpoint – so the whole Flowy pipeline can run without real keys.
const http = require('node:http')

function wav(seconds = 0.6, rate = 16000, freq = 440, silenceSeconds = 0) {
  const tone = Math.floor(seconds * rate)
  const n = tone + Math.floor(silenceSeconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < tone; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), 44 + i * 2)
  return buf
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  let i = 0
  const tick = () => {
    if (i >= events.length) return res.end()
    const e = events[i++]
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    setTimeout(tick, Number(process.env.MOCK_TICK || 15))
  }
  tick()
}

function textEvents(id, text) {
  const words = text.split(/(?<= )/)
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...words.map((w) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]
}

function toolEvents(id, name, input) {
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Moment, ich schaue kurz nach. ' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_e2e_1', name, input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } },
    { type: 'message_stop' },
  ]
}

const requests = []

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const url = req.url || ''
    if (url === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(requests))
    }
    if (url.startsWith('/v1/messages')) {
      const json = JSON.parse(body.toString('utf8'))
      const last = json.messages[json.messages.length - 1]
      const summary = {
        path: url,
        beta: req.headers['anthropic-beta'] || null,
        model: json.model,
        tools: (json.tools || []).length,
        thinking: json.thinking,
        effort: json.output_config && json.output_config.effort,
        lastRole: last.role,
        lastTypes: Array.isArray(last.content) ? last.content.map((b) => b.type) : ['string'],
        hasImage: JSON.stringify(json.messages).includes('"type":"image"'),
        roles: json.messages.map((m) => m.role).join(','),
      }
      requests.push(summary)
      const fullText = Array.isArray(last.content) ? last.content.map((b) => b.text || '').join(' ') : String(last.content)
      const lastText = fullText.split('[Context]')[0]
      const isToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')
      if (isToolResult) return sse(res, textEvents('msg_2', '[[happy]] Ich habe nachgesehen und alles ist bereit. Schön, dass du mich fragst!'))
      if (/spät|time|uhr/i.test(lastText)) return sse(res, toolEvents('msg_1', 'get_time', {}))
      return sse(res, textEvents('msg_3', 'Hallo! Ich bin Flowy und höre dich laut und deutlich. Was kann ich für dich tun?'))
    }
    if (url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{"status":"ok"}')
    }
    if (url === '/v1/tts') {
      requests.push({ path: url, contentType: req.headers['content-type'], text: (() => { try { return JSON.parse(body.toString('utf8')).text } catch { return '(msgpack)' } })() })
      res.writeHead(200, { 'content-type': 'audio/wav' })
      return res.end(wav(0.5))
    }
    if (url === '/v1/audio/transcriptions') {
      requests.push({ path: url, bytes: body.length, contentType: req.headers['content-type'] })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: 'Hallo Flowy, hörst du mich?' }))
    }
    if (url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: 'claude-opus-5-5', type: 'model', display_name: 'Mock' }))
    }
    res.writeHead(404)
    res.end('not found')
  })
})

module.exports = { server, wav, requests }

if (require.main === module) {
  const port = Number(process.argv[2] || 18765)
  server.listen(port, '127.0.0.1', () => console.log(`mock listening on ${port}`))
}
