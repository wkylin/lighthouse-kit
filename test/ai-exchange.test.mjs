import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { analyzeRound, readAnalysis, writeAnalysis } from '../src/analyze/index.mjs'
import { exportAiRequest, importAiReply } from '../src/ai/exchange.mjs'
import { runCli } from '../src/cli.mjs'
import { ConfigError, loadConfig } from '../src/config.mjs'
import { makeRound, project } from './helpers.mjs'

const BIN = fileURLToPath(new URL('../bin/lhkit.mjs', import.meta.url))

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-exchange-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.cp(project, root, { recursive: true })
  // 报告夹具的 source map 保留了此组件路径，原仓库夹具故意没有它；为会话测试补充可读的示例源码。
  await fs.mkdir(path.join(root, 'src/mobile/ui'), { recursive: true })
  await fs.writeFile(path.join(root, 'src/mobile/ui/MBoard.vue'), '<script setup>\nconst rows = Array.from({ length: 100 }, (_, i) => i)\n</script>\n<template><div v-for="row in rows">{{ row }}</div></template>\n')
  const round = await makeRound()
  const dir = path.join(root, 'reports/runs/r1')
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await fs.rename(round, dir)
  await fs.writeFile(path.join(root, 'lhkit.config.mjs'), `export default ${JSON.stringify({ serve: { url: 'https://localhost:4443' }, pages: ['/m/home'], outDir: 'reports',
    sourceMap: { manifest: 'build/.vite/manifest.json', maps: 'build' }, ai: { enabled: true, provider: 'openai', apiKeyEnv: 'LHKIT_UNUSED_KEY' } })}`)
  const config = await loadConfig(root)
  const analysis = await analyzeRound(dir, config)
  return { root, dir, config, analysis }
}

function replyFor(request) {
  return { version: 1, requestId: request.requestId, roundId: request.roundId, model: 'codex-session', findings: [{ id: request.tasks[0].id,
    cause: '报告存在脚本执行耗时，示例源码显示一次创建全部行；是否处于首屏仍需确认。', fix: '确认首屏调用后再评估分批渲染。', confidence: 'medium',
    evidence: [{ file: request.tasks[0].sources[0].file, quote: 'Array.from({ length: 100 }, (_, i) => i)' }], verification: ['检查调用路径后在相同配置下重测 Lighthouse。'] }] }
}

test('export and partial import reuse real findings, preserve earlier advice, and reject stale code', async (t) => {
  const f = await fixture(t)
  const { request } = await exportAiRequest(f.dir, f.analysis, f.config)
  assert.ok(request.tasks.length)
  assert.match(request.requestId, /^[a-f0-9]{64}$/)
  assert.ok(request.tasks[0].prompt.includes('起始行'))
  assert.deepEqual(f.analysis.aiSent, [])
  const prior = structuredClone(f.analysis)
  const untouched = prior.findings.find((item) => item.id !== request.tasks[0].id)
  untouched.ai = { cause: '此前原因', fix: '此前建议', model: 'old' }
  const reply = replyFor(request)
  const result = await importAiReply(f.dir, prior, f.config, reply)
  assert.equal(result.findings.find((item) => item.id === reply.findings[0].id).ai.model, 'codex-session')
  assert.deepEqual(result.findings.find((item) => item.id === untouched.id).ai, untouched.ai)
  const twice = await importAiReply(f.dir, result, f.config, reply)
  assert.deepEqual(twice.aiSent, result.aiSent)
  const source = request.tasks[0].sources[0].file
  await fs.appendFile(path.join(f.root, source), '\n// source changed after export\n')
  await assert.rejects(importAiReply(f.dir, prior, f.config, reply), (e) => e instanceof ConfigError && /重新导出|ai-export/.test(e.message))
})

test('invalid replies never mutate analysis or existing documents', async (t) => {
  const f = await fixture(t)
  const { request } = await exportAiRequest(f.dir, f.analysis, f.config)
  const good = replyFor(request)
  const original = await fs.readFile(path.join(f.dir, 'analysis.json'), 'utf8')
  await fs.mkdir(path.join(f.dir, 'docs'), { recursive: true })
  await fs.writeFile(path.join(f.dir, 'docs/dev.md'), 'existing document')
  const replyFile = path.join(f.root, 'invalid-reply.json')
  for (const mutate of [
    (r) => { r.version = 2 }, (r) => { r.roundId = 'other' }, (r) => { r.requestId = 'other' }, (r) => { r.model = '' },
    (r) => { r.findings.push(r.findings[0]) }, (r) => { r.findings[0].id = 'unknown' }, (r) => { r.findings[0].fix = '' },
    (r) => { r.findings[0].confidence = 'high'; r.findings[0].evidence = [] },
    (r) => { r.findings[0].evidence = [{ file: 'src/invented.js', quote: 'made up' }] },
    (r) => { r.findings[0].verification = [] },
  ]) {
    const reply = structuredClone(good)
    mutate(reply)
    await fs.writeFile(replyFile, JSON.stringify(reply))
    await assert.rejects(runCli(['ai-import', replyFile, '--config', f.root], { log: { info() {}, warn() {} } }), ConfigError)
    assert.equal(await fs.readFile(path.join(f.dir, 'analysis.json'), 'utf8'), original)
    assert.equal(await fs.readFile(path.join(f.dir, 'docs/dev.md'), 'utf8'), 'existing document')
  }
})

test('CLI exports and imports with --config, custom outDir, and a reply relative to cwd without any API calls', async (t) => {
  const f = await fixture(t)
  const log = { info() {}, warn() {} }
  const exported = execFileSync(process.execPath, [BIN, 'ai-export', '--config', f.root], { cwd: os.tmpdir(), encoding: 'utf8' })
  assert.ok(exported.includes(path.join(f.dir, 'ai/request.json')))
  const request = JSON.parse(await fs.readFile(path.join(f.dir, 'ai/request.json'), 'utf8'))
  const replyFile = path.join(f.root, 'reply.json')
  await fs.writeFile(replyFile, JSON.stringify(replyFor(request)))
  const imported = execFileSync(process.execPath, [BIN, 'ai-import', 'reply.json', '--config', '.'], { cwd: f.root, encoding: 'utf8' })
  assert.ok(imported.includes(path.join(f.dir, 'index.html')))
  const after = await readAnalysis(f.dir)
  assert.ok(after.findings.some((item) => item.ai?.model === 'codex-session'))
  for (const file of ['docs/dev.md', 'docs/dev.html', 'docs/lead.md', 'docs/lead.html', 'index.html']) {
    assert.ok((await fs.readFile(path.join(f.dir, file), 'utf8')).length)
  }
  const doc = await fs.readFile(path.join(f.dir, 'docs/dev.md'), 'utf8')
  assert.ok(doc.includes('codex-session') && doc.includes('验证步骤'))
  await assert.rejects(fs.access(path.join(f.root, 'reports/history')))
  const before = await fs.readFile(path.join(f.dir, 'analysis.json'), 'utf8')
  await fs.writeFile(replyFile, '{broken json')
  await assert.rejects(runCli(['ai-import', 'reply.json', '--config', '.'], { cwd: f.root, log }), ConfigError)
  assert.equal(await fs.readFile(path.join(f.dir, 'analysis.json'), 'utf8'), before)
})

test('concurrent partial imports preserve both users advice and matching reports', async (t) => {
  const f = await fixture(t)
  const mapped = f.analysis.findings.find((item) => item.evidence.some((e) => e.source?.file === 'src/mobile/ui/MBoard.vue'))
  f.analysis.findings.push({ ...structuredClone(mapped), id: 'second-test-finding', title: 'Second independent test finding' })
  await writeAnalysis(f.dir, f.analysis)
  const { request } = await exportAiRequest(f.dir, f.analysis, f.config)
  assert.ok(request.tasks.length >= 2)
  const a = replyFor(request)
  const b = replyFor(request)
  a.model = 'session-a'
  b.model = 'session-b'
  b.findings[0].id = request.tasks[1].id
  const files = [path.join(f.root, 'a.json'), path.join(f.root, 'b.json')]
  await fs.writeFile(files[0], JSON.stringify(a))
  await fs.writeFile(files[1], JSON.stringify(b))
  await Promise.all(files.map((file) => runCli(['ai-import', file, '--config', f.root], { log: { info() {}, warn() {} } })))
  const result = await readAnalysis(f.dir)
  assert.equal(result.findings.find((item) => item.id === a.findings[0].id).ai.model, 'session-a')
  assert.equal(result.findings.find((item) => item.id === b.findings[0].id).ai.model, 'session-b')
  const doc = await fs.readFile(path.join(f.dir, 'docs/dev.md'), 'utf8')
  assert.ok(doc.includes('session-a') && doc.includes('session-b'))
})

for (const failure of ['render', 'install']) test(`a ${failure} I/O failure leaves original analysis and documents intact`, async (t) => {
  const f = await fixture(t)
  const { request } = await exportAiRequest(f.dir, f.analysis, f.config)
  const replyFile = path.join(f.root, 'reply.json')
  await fs.writeFile(replyFile, JSON.stringify(replyFor(request)))
  await fs.mkdir(path.join(f.dir, 'docs'), { recursive: true })
  await fs.writeFile(path.join(f.dir, 'docs/dev.md'), 'original developer doc')
  await fs.writeFile(path.join(f.dir, 'index.html'), 'original index')
  const targets = ['analysis.json', 'docs/dev.md', 'index.html']
  const before = await Promise.all(targets.map((file) => fs.readFile(path.join(f.dir, file), 'utf8')))
  let failed = false
  const writeFile = fs.writeFile.bind(fs)
  const rename = fs.rename.bind(fs)
  if (failure === 'render') t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (path.basename(String(file)) === 'lead.html') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return writeFile(file, ...args)
  })
  else t.mock.method(fs, 'rename', async (from, to) => {
    if (!failed && to === path.join(f.dir, 'index.html')) { failed = true; throw Object.assign(new Error('install failed'), { code: 'EIO' }) }
    return rename(from, to)
  })
  await assert.rejects(runCli(['ai-import', replyFile, '--config', f.root], { log: { info() {}, warn() {} } }))
  assert.deepEqual(await Promise.all(targets.map((file) => fs.readFile(path.join(f.dir, file), 'utf8'))), before)
})
