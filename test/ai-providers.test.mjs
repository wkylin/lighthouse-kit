import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeConfig } from '../src/config.mjs'
import { createClient, isFatal, requestFor } from '../src/ai/providers.mjs'
import { parseReply, validateAdvice } from '../src/ai/reply.mjs'

const settings = (ai = {}) => normalizeConfig({ serve: { url: 'https://x.test' }, pages: ['/'], ai }, '/project', '/project/lhkit.config.mjs').ai
const sources = [{ file: 'src/a.js', text: 'const expensive = loadEverything()' }]
const advice = { cause: 'Measured script work; source suggests eager loading.', fix: 'Defer loadEverything after verifying its callers.', confidence: 'medium',
  evidence: [{ file: 'src/a.js', quote: 'loadEverything()' }], verification: ['Compare the same build and route with the same Lighthouse settings.'] }
const completion = (value = advice, overrides = {}) => ({ model: 'returned-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) }, ...overrides }] })

test('provider requests preserve protocol, output constraints, and configured limits', () => {
  const task = { prompt: 'Measured evidence and source' }
  for (const provider of ['anthropic', 'openai', 'deepseek', 'openai-compatible']) {
    const ai = settings({ provider, ...(provider === 'openai-compatible' ? { baseURL: 'https://gateway.test/prefix/v1', model: 'custom' } : {}), maxTokens: 1234 })
    const p = requestFor(task, 'system JSON guidance', ai)
    assert.equal(p.model, ai.model)
    if (provider === 'anthropic') {
      assert.equal(p.system, 'system JSON guidance')
      assert.equal(p.output_config.format.type, 'json_schema')
      assert.equal(p.max_tokens, 1234)
    } else {
      assert.equal(p.messages[0].role, 'system')
      assert.equal(p.response_format.type, provider === 'openai' ? 'json_schema' : 'json_object')
      assert.equal(p[provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'], 1234)
    }
    const text = requestFor(task, 'system', { ...ai, responseFormat: 'text' })
    assert.equal(text.response_format, undefined)
    assert.equal(text.output_config?.format, undefined)
  }
})

test('chat transport retains base path, authenticates, and returns parseable advice', async () => {
  const ai = settings({ provider: 'openai-compatible', baseURL: 'https://gateway.test/prefix/v1/', model: 'custom' })
  const calls = []
  const client = await createClient(ai, 'test-token', { fetch: async (url, options) => {
    calls.push({ url, options })
    return Response.json(completion())
  } })
  const result = await client.create(requestFor({ prompt: 'source' }, 'system', ai))
  assert.equal(calls[0].url, 'https://gateway.test/prefix/v1/chat/completions')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token')
  assert.deepEqual(parseReply(result, ai, sources), { ...advice, model: 'returned-model' })
})

test('only transient errors retry and retries are bounded', async () => {
  for (const [status, expected] of [[401, 1], [403, 1], [400, 1], [429, 2], [503, 2]]) {
    let calls = 0
    const client = await createClient(settings({ provider: 'deepseek', maxRetries: 1 }), 'key', {
      fetch: async () => { calls++; return Response.json({ error: { message: 'unavailable' } }, { status }) },
    })
    await assert.rejects(client.create({}), (e) => e.status === status)
    assert.equal(calls, expected)
  }
})

test('timeouts abort the request and connection failures have a fatal error name', async () => {
  let aborted = false
  const client = await createClient(settings({ provider: 'openai', timeoutMs: 15, maxRetries: 0 }), 'key', {
    fetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
      aborted = true
      reject(new Error('aborted'))
    }, { once: true })),
  })
  await assert.rejects(client.create({}), { name: 'APIConnectionTimeoutError' })
  assert.equal(aborted, true)
  const down = await createClient(settings({ provider: 'deepseek', maxRetries: 0 }), 'key', { fetch: async () => { throw new TypeError('fetch failed') } })
  await assert.rejects(down.create({}), { name: 'APIConnectionError' })
})

test('timeout while reading a response body is still a fatal timeout with a send record', async () => {
  const client = await createClient(settings({ provider: 'openai', timeoutMs: 15, maxRetries: 0 }), 'key', {
    fetch: async (_url, options) => ({ status: 200, ok: true, json: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true })
    }) }),
  })
  await assert.rejects(client.create({}), (e) => e.name === 'APIConnectionTimeoutError' && e.sent === true)
})

test('invalid, refused, truncated, unsupported, or ungrounded answers are rejected', () => {
  const ai = settings({ provider: 'openai' })
  for (const response of [
    completion(advice, { finish_reason: 'length' }), completion(advice, { finish_reason: 'content_filter' }),
    completion(advice, { message: { refusal: 'no', content: null } }),
    completion(advice, { message: { content: '   ' } }),
    completion({ ...advice, verification: [] }), completion({ ...advice, evidence: [] }),
    completion({ ...advice, evidence: [{ file: 'src/made-up.js', quote: 'loadEverything()' }] }),
    completion({ ...advice, evidence: [{ file: 'src/a.js', quote: 'inventedFunction()' }] }),
  ]) assert.throws(() => parseReply(response, ai, sources))
  assert.doesNotThrow(() => validateAdvice({ ...advice, confidence: 'low', evidence: [] }, sources, 'm'))
  const anthropic = { stop_reason: 'end_turn', model: 'claude', content: [{ type: 'text', text: JSON.stringify(advice) }] }
  assert.equal(parseReply(anthropic, settings(), sources).model, 'claude')
})

test('Anthropic uses the same full-body deadline and retry policy with injected transport', { timeout: 1500 }, async (t) => {
  let calls = 0
  // 同时隔离默认 fetch，确保旧实现的回归测试也绝不访问外部服务。
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected default fetch') })
  const client = await createClient(settings({ timeoutMs: 15, maxRetries: 0 }), 'test-key', {
    fetch: async (_url, options) => {
      calls++
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        options.signal.addEventListener('abort', () => controller.error(new Error('body aborted')), { once: true })
      } }), { headers: { 'content-type': 'application/json' } })
    },
  })
  await assert.rejects(client.create(requestFor({ prompt: 'source' }, 'JSON', settings())), (e) => e.name === 'APIConnectionTimeoutError' && e.sent)
  assert.equal(calls, 1)
  calls = 0
  const unauthorized = await createClient(settings({ maxRetries: 2 }), 'test-key', { fetch: async () => {
    calls++
    return Response.json({ error: { type: 'authentication_error', message: 'unauthorized' } }, { status: 401, headers: { 'x-should-retry': 'true' } })
  } })
  await assert.rejects(unauthorized.create(requestFor({ prompt: 'source' }, 'JSON', settings())), (e) => e.status === 401)
  assert.equal(calls, 1)
})

test('transmission accounting survives retries and exhausted gateway timeout is fatal', async () => {
  let calls = 0
  const client = await createClient(settings({ provider: 'openai', maxRetries: 1 }), 'test-key', { fetch: async () => {
    calls++
    if (calls === 1) return Response.json({ error: { message: 'retry' } }, { status: 503 })
    throw new TypeError('connection failed')
  } })
  await assert.rejects(client.create({}), (e) => e.name === 'APIConnectionError' && e.sent === true)
  assert.equal(calls, 2)
  assert.equal(isFatal({ status: 408 }), true)
})
