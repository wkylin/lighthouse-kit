import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { carryForwardAi, collectSources, enrichWithAi } from '../src/ai/index.mjs'
import { normalizeConfig } from '../src/config.mjs'

const KEY_ENV = 'LHKIT_TEST_AI_KEY'

async function project(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-ai-'))
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await fs.writeFile(path.join(root, rel), text)
  }
  return root
}

function configFor(root, ai = {}) {
  return normalizeConfig({ serve: { url: 'https://x.test' }, pages: ['/'], ai: { enabled: true, apiKeyEnv: KEY_ENV, sourceRoot: 'src', ...ai } }, root, path.join(root, 'lhkit.config.mjs'))
}

const finding = (id, files) => ({
  id, category: 'main-thread', group: 'performance', title: `标题 ${id}`, advice: '规则建议', score: 0,
  savings: { lcp: 0, tbt: 500, fcp: 0, cls: 0, bytes: 0 }, impact: 150, impactTotal: 150, pages: ['/'],
  perPage: [], ai: null,
  evidence: files.map((f) => ({ url: `https://x.test/js/${path.basename(f)}.js`, ms: 100, source: { file: f, share: 1 } })),
})

const analysisWith = (findings) => ({ round: { id: 'r', origin: 'https://x.test' }, pages: [], findings, facts: {}, aiSent: [] })

function fakeClient(reply = () => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ cause: '原因', fix: '改法' }) }] })) {
  const calls = []
  return { calls, create: async (params) => (calls.push(params), reply(params)) }
}

test('disabled or missing key: no client call, findings unchanged, one warning when enabled without key', async () => {
  const root = await project({ 'src/a.vue': 'a' })
  const warnings = []
  const off = await enrichWithAi(analysisWith([finding('x', ['src/a.vue'])]), configFor(root, { enabled: false }), { dryRun: false, warn: (m) => warnings.push(m) })
  assert.equal(off.findings[0].ai, null)
  assert.deepEqual(warnings, [])
  delete process.env[KEY_ENV]
  const noKey = await enrichWithAi(analysisWith([finding('x', ['src/a.vue'])]), configFor(root), { dryRun: false, warn: (m) => warnings.push(m) })
  assert.equal(noKey.findings[0].ai, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], new RegExp(KEY_ENV))
})

test('dry run never calls the client, lists what it would send in aiPlanned and sends nothing', async () => {
  const root = await project({ 'src/a.vue': 'abc' })
  const client = fakeClient()
  const out = await enrichWithAi(analysisWith([finding('x', ['src/a.vue'])]), configFor(root), { dryRun: true, client, warn() {} })
  assert.equal(client.calls.length, 0)
  assert.equal(out.findings[0].ai, null)
  assert.deepEqual(out.aiSent, [], 'aiSent only ever lists what was actually sent')
  assert.deepEqual(out.aiPlanned, [{ finding: 'x', file: 'src/a.vue', chars: 3 }])
})

test('only the top maxFindings findings that have a source file are sent', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({ 'src/a.vue': 'a', 'src/b.vue': 'b', 'src/c.vue': 'c' })
  const client = fakeClient()
  const findings = [finding('nosrc', []), finding('a', ['src/a.vue']), finding('pkg', ['vue (node_modules)']), finding('b', ['src/b.vue']), finding('c', ['src/c.vue'])]
  const out = await enrichWithAi(analysisWith(findings), configFor(root, { maxFindings: 2 }), { dryRun: false, client, warn() {} })
  assert.equal(client.calls.length, 2)
  assert.deepEqual(out.findings.filter((f) => f.ai).map((f) => f.id), ['a', 'b'])
  const params = client.calls[0]
  assert.equal(params.model, 'claude-opus-5-5')
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01'])
  assert.equal(params.fallbacks, 'default')
  assert.equal(params.output_config.format.type, 'json_schema')
  assert.deepEqual(params.output_config.format.schema.required, ['cause', 'fix'])
  assert.ok(JSON.stringify(params.messages).includes('src/a.vue'))
})

test('excluded paths are never read or sent', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({ 'src/a.vue': 'GOOD', 'src/.env.local': 'SECRET_TOKEN', 'src/certs/a.pem': 'PRIVATE', 'outside.js': 'OUTSIDE', 'src/private/x.vue': 'HIDE' })
  const client = fakeClient()
  const out = await enrichWithAi(analysisWith([finding('x', ['src/a.vue', 'src/.env.local', 'src/certs/a.pem', 'outside.js', 'src/private/x.vue'])]),
    configFor(root, { exclude: ['**/private/**'] }), { dryRun: false, client, warn() {} })
  const sent = JSON.stringify(client.calls)
  assert.ok(sent.includes('GOOD'))
  for (const secret of ['SECRET_TOKEN', 'PRIVATE', 'OUTSIDE', 'HIDE']) assert.ok(!sent.includes(secret), secret)
  assert.deepEqual(out.aiSent.map((s) => s.file), ['src/a.vue'])
})

test('files are truncated to 8000 chars and 24000 chars per finding', async () => {
  const root = await project({ 'src/big.vue': 'x'.repeat(10000), 'src/1.vue': 'a'.repeat(9000), 'src/2.vue': 'b'.repeat(9000), 'src/3.vue': 'c'.repeat(9000), 'src/4.vue': 'd'.repeat(9000) })
  const cfg = configFor(root)
  assert.deepEqual((await collectSources(finding('big', ['src/big.vue']), cfg)).map((s) => s.text.length), [8000])
  const many = await collectSources(finding('many', ['src/1.vue', 'src/2.vue', 'src/3.vue', 'src/4.vue']), cfg)
  assert.equal(many.reduce((n, s) => n + s.text.length, 0), 24000)
  assert.deepEqual(many.map((s) => s.file), ['src/1.vue', 'src/2.vue', 'src/3.vue'])
})

test('a valid JSON reply fills ai {cause, fix, model}', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({ 'src/a.vue': 'a' })
  const out = await enrichWithAi(analysisWith([finding('x', ['src/a.vue'])]), configFor(root), { dryRun: false, client: fakeClient(), warn() {} })
  assert.deepEqual(out.findings[0].ai, { cause: '原因', fix: '改法', model: 'claude-opus-5-5' })
})

test('client errors fall back to rule advice', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({ 'src/a.vue': 'a', 'src/b.vue': 'b', 'src/c.vue': 'c', 'src/d.vue': 'd' })
  const replies = {
    a: () => { throw new Error('network down') },
    b: () => ({ stop_reason: 'end_turn', model: 'm', content: [{ type: 'text', text: 'not json' }] }),
    c: () => ({ stop_reason: 'end_turn', model: 'm', content: [{ type: 'text', text: '{"cause":"only"}' }] }),
    d: () => ({ stop_reason: 'refusal', model: 'm', content: [] }),
  }
  const client = fakeClient((p) => replies[JSON.stringify(p.messages).match(/src\/([a-d])\.vue/)[1]]())
  const warnings = []
  const out = await enrichWithAi(analysisWith(['a', 'b', 'c', 'd'].map((id) => finding(id, [`src/${id}.vue`]))), configFor(root), { dryRun: false, client, warn: (m) => warnings.push(m) })
  assert.ok(out.findings.every((f) => f.ai === null))
  assert.ok(out.findings.every((f) => f.advice === '规则建议'))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /4/)
})

test('an auth or connection error stops the remaining calls', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({ 'src/a.vue': 'a', 'src/b.vue': 'b', 'src/c.vue': 'c' })
  for (const error of [Object.assign(new Error('invalid x-api-key'), { status: 401 }), Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })]) {
    const client = fakeClient(() => { throw error })
    const warnings = []
    await enrichWithAi(analysisWith(['a', 'b', 'c'].map((id) => finding(id, [`src/${id}.vue`]))), configFor(root), { dryRun: false, client, warn: (m) => warnings.push(m) })
    assert.equal(client.calls.length, 1, error.message)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /停止/)
  }
})

test('each call reports its progress', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({ 'src/a.vue': 'a', 'src/b.vue': 'b' })
  const lines = []
  await enrichWithAi(analysisWith([finding('a', ['src/a.vue']), finding('b', ['src/b.vue'])]), configFor(root), { dryRun: false, client: fakeClient(), warn() {}, info: (m) => lines.push(m) })
  assert.deepEqual(lines.map((l) => l.match(/AI 分析 (\d\/\d)/)?.[1]), ['1/2', '2/2'])
})

test('carryForwardAi keeps earlier advice for findings that got none this time', () => {
  const previous = analysisWith([{ ...finding('a', []), ai: { cause: '旧原因', fix: '旧改法', model: 'm' } }, { ...finding('b', []), ai: { cause: 'b', fix: 'b', model: 'm' } }])
  previous.aiSent = [{ finding: 'a', file: 'src/a.vue', chars: 5 }, { finding: 'b', file: 'src/b.vue', chars: 6 }]
  const next = analysisWith([finding('a', []), { ...finding('b', []), ai: { cause: '新', fix: '新', model: 'm' } }, finding('c', [])])
  next.aiSent = [{ finding: 'b', file: 'src/b.vue', chars: 7 }]
  const out = carryForwardAi(next, previous)
  assert.deepEqual(out.findings.map((f) => f.ai?.cause ?? null), ['旧原因', '新', null])
  assert.deepEqual(out.aiSent, [{ finding: 'b', file: 'src/b.vue', chars: 7 }, { finding: 'a', file: 'src/a.vue', chars: 5 }])
  assert.equal(carryForwardAi(next, null), next)
})

test('dot-named keys and certificates, env files, ssh keys and build output are never sent', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({
    'src/ok.vue': 'GOOD', 'src/.secret.pem': 'PEM', 'src/.cfg/x/a.key': 'KEY', 'src/config/.env.production': 'ENV', 'src/deploy/id_rsa': 'SSH',
    'src/.npmrc': 'NPMRC', 'src/certs/site.p12': 'P12', 'dist/assets/app.js': 'BUILT',
  })
  const client = fakeClient()
  const files = ['src/ok.vue', 'src/.secret.pem', 'src/.cfg/x/a.key', 'src/config/.env.production', 'src/deploy/id_rsa', 'src/.npmrc', 'src/certs/site.p12', 'dist/assets/app.js']
  const config = normalizeConfig({ serve: { static: 'dist' }, pages: ['/'], sourceMap: { maps: 'dist' }, ai: { enabled: true, apiKeyEnv: KEY_ENV, sourceRoot: '.' } }, root, path.join(root, 'lhkit.config.mjs'))
  const out = await enrichWithAi(analysisWith([finding('x', files)]), config, { dryRun: false, client, warn() {} })
  const sent = JSON.stringify(client.calls)
  assert.ok(sent.includes('GOOD'))
  for (const secret of ['PEM', 'KEY', 'ENV', 'SSH', 'NPMRC', 'P12', 'BUILT']) assert.ok(!sent.includes(secret), secret)
  assert.deepEqual(out.aiSent.map((s) => s.file), ['src/ok.vue'])
})

test('a symlink inside sourceRoot that points outside it is not followed', async () => {
  process.env[KEY_ENV] = 'test-key'
  const root = await project({ 'src/ok.vue': 'GOOD', 'outside/secret.vue': 'OUTSIDE' })
  await fs.symlink(path.join(root, 'outside/secret.vue'), path.join(root, 'src/link.vue'))
  const client = fakeClient()
  await enrichWithAi(analysisWith([finding('x', ['src/ok.vue', 'src/link.vue'])]), configFor(root), { dryRun: false, client, warn() {} })
  assert.ok(!JSON.stringify(client.calls).includes('OUTSIDE'))
})
