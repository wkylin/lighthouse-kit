// 实际 HTTP 协议闭环，所有请求均发往本机临时服务，不使用真实模型账号。
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { enrichWithAi } from '../src/ai/index.mjs'
import { normalizeConfig } from '../src/config.mjs'

test('Anthropic SDK, OpenAI, DeepSeek, and a custom gateway work over real loopback HTTP', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-ai-http-'))
  const keyEnv = 'LHKIT_HTTP_TEST_KEY'
  const before = process.env[keyEnv]
  process.env[keyEnv] = 'local-test-key'
  const requests = []
  const reply = { cause: '脚本审计耗时与源码里的同步加载相关，调用时机仍需确认。', fix: '确认首屏调用路径后评估延迟加载。', confidence: 'medium',
    evidence: [{ file: 'src/a.js', quote: 'loadAll()' }], verification: ['使用相同构建和页面复测并检查交互回归。'] }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: new URL(req.url, 'http://local').pathname, headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    const content = JSON.stringify(reply)
    res.end(JSON.stringify(req.url.startsWith('/anthropic/')
      ? { id: 'msg_local', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      : { id: 'local', model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }))
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
    if (before == null) delete process.env[keyEnv]
    else process.env[keyEnv] = before
  })
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src/a.js'), 'const slow = loadAll()')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const analysis = { round: { id: 'r', origin: 'https://site.test' }, pages: [], facts: {}, aiSent: [], findings: [{
    id: 'bootup-time', title: 'Script work', category: 'main-thread', pages: ['/'], advice: '检查同步脚本', savings: { tbt: 100 }, ai: null,
    evidence: [{ url: 'https://site.test/app.js', ms: 100, source: { file: 'src/a.js', share: 1 } }],
  }] }
  for (const [provider, prefix] of [['anthropic', '/anthropic'], ['openai', '/openai/v1'], ['deepseek', '/deepseek'], ['openai-compatible', '/gateway/v1']]) {
    const config = normalizeConfig({ serve: { url: 'https://site.test' }, pages: ['/'], ai: { enabled: true, provider, model: provider === 'anthropic' ? 'claude-opus-5-5' : 'test-model',
      baseURL: origin + prefix, apiKeyEnv: keyEnv, cache: false, maxRetries: 0 } }, root, path.join(root, 'lhkit.config.mjs'))
    const warnings = []
    const result = await enrichWithAi(analysis, config, { warn: (m) => warnings.push(m) })
    assert.deepEqual(warnings, [])
    assert.equal(result.findings[0].ai?.confidence, 'medium')
    assert.equal(result.aiSent[0].file, 'src/a.js')
    const last = requests.at(-1)
    assert.equal(last.path, prefix + (provider === 'anthropic' ? '/v1/messages' : '/chat/completions'))
    // SDK 版本可使用 Bearer 或 x-api-key；验证使用的是本次指定的测试凭据。
    if (provider === 'anthropic') assert.ok(last.headers['x-api-key'] === 'local-test-key' || last.headers.authorization === 'Bearer local-test-key')
    else assert.equal(last.headers.authorization, 'Bearer local-test-key')
    assert.ok(JSON.stringify(last.body).includes('loadAll()'))
  }
  assert.equal(requests.length, 4)
})
