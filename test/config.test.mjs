import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigError, loadConfig, normalizeConfig } from '../src/config.mjs'

const norm = (raw, overrides) => normalizeConfig(raw, '/p', '/p/lhkit.config.mjs', overrides)

test('defaults', () => {
  const c = norm({ serve: { url: 'https://example.com' }, pages: ['/'] })
  assert.equal(c.serve.mode, 'url')
  assert.equal(c.build, null)
  assert.equal(c.runs, 1)
  assert.equal(c.visit, 'first')
  assert.equal(c.formFactor, 'mobile')
  assert.deepEqual(c.categories, ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'])
  assert.deepEqual(c.docs, { audiences: ['dev', 'lead'], lang: 'zh-CN' })
  assert.equal(c.ai.enabled, false)
  assert.equal(c.ai.model, 'claude-opus-5-5')
  assert.equal(c.ai.apiKeyEnv, 'ANTHROPIC_API_KEY')
  assert.equal(c.ai.maxFindings, 10)
  assert.equal(c.ai.sourceRoot, '/p')
  assert.equal(c.outDir, '/p/.lhkit')
  assert.equal(c.keep, 'latest')
  assert.deepEqual(c.https, { enabled: false, port: 4443 })
  assert.equal(c.serve.timeoutMs, 60000)
  assert.equal(c.serve.readyPath, '/')
  assert.equal(c.beforePage, null)
  assert.equal(c.chromePath, null)
})

test('mode is command when command is set, static when static is set', () => {
  const cmd = norm({ serve: { command: 'npm run preview', url: 'http://localhost:4173', readyPath: '/home' }, pages: ['/'] })
  assert.equal(cmd.serve.mode, 'command')
  assert.equal(cmd.serve.url, 'http://localhost:4173')
  assert.equal(cmd.serve.port, 4173)
  assert.equal(cmd.serve.readyPath, '/home')
  const st = norm({ serve: { static: 'dist' }, pages: ['/'] })
  assert.equal(st.serve.mode, 'static')
  assert.equal(st.serve.static, '/p/dist')
  assert.equal(st.serve.port, 4173)
  assert.equal(st.serve.url, 'http://localhost:4173')
  assert.deepEqual(st.serve.proxy, {})
})

test('build keeps its command and env; https is forced off in url mode', () => {
  const c = norm({ build: { command: 'pnpm build', env: { A: '1' } }, serve: { static: 'dist' }, https: { enabled: true }, pages: ['/'] })
  assert.deepEqual(c.build, { command: 'pnpm build', env: { A: '1' } })
  assert.deepEqual(c.https, { enabled: true, port: 4443 })
  const u = norm({ build: { command: 'pnpm build' }, serve: { url: 'https://x.test' }, https: { enabled: true }, pages: ['/'] })
  assert.equal(u.build, null)
  assert.equal(u.https.enabled, false)
})

test('url override switches to url mode and drops build', () => {
  const c = norm({ build: { command: 'pnpm build' }, serve: { command: 'pnpm preview', url: 'http://localhost:4173' }, pages: ['/'] }, { url: 'https://staging.x' })
  assert.equal(c.serve.mode, 'url')
  assert.equal(c.serve.url, 'https://staging.x')
  assert.equal(c.build, null)
  assert.equal(c.serve.command, undefined)
})

test('runs override', () => {
  assert.equal(norm({ serve: { url: 'https://x.test' }, pages: ['/'] }, { runs: 3 }).runs, 3)
})

test('rejects bad configs with ConfigError', () => {
  const ok = { serve: { url: 'https://x.test' }, pages: ['/'] }
  const bad = [
    { ...ok, pages: [] },
    { ...ok, pages: undefined },
    { ...ok, pages: ['m/home'] },
    { serve: { command: 'pnpm preview' }, pages: ['/'] },
    { serve: { command: 'a', static: 'dist', url: 'http://localhost:1' }, pages: ['/'] },
    { serve: {}, pages: ['/'] },
    { ...ok, runs: 0 },
    { ...ok, keep: 'all' },
    { ...ok, keep: 0 },
    { ...ok, beforePage: 'x' },
    { ...ok, visit: 'second' },
    { ...ok, docs: { audiences: ['boss'] } },
  ]
  for (const raw of bad) assert.throws(() => norm(raw), ConfigError, JSON.stringify(raw))
})

test('ai.exclude always contains the built-in list', () => {
  const c = norm({ serve: { url: 'https://x.test' }, pages: ['/'], ai: { exclude: ['**/secret/**'] } })
  for (const p of ['**/.env*', '**/*.pem', '**/*.key', '**/node_modules/**', '**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock', '**/secret/**'])
    assert.ok(c.ai.exclude.includes(p), p)
})

test('loadConfig finds lhkit.config.mjs, else lhkit.config.js, else throws ConfigError naming both', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-config-'))
  try {
    await assert.rejects(loadConfig(dir), (e) => e instanceof ConfigError && /lhkit\.config\.mjs/.test(e.message) && /lhkit\.config\.js/.test(e.message))
    await fs.writeFile(path.join(dir, 'lhkit.config.js'), "export default { serve: { url: 'https://js.test' }, pages: ['/'] }\n")
    assert.equal((await loadConfig(dir)).serve.url, 'https://js.test')
    await fs.writeFile(path.join(dir, 'lhkit.config.mjs'), "export default { serve: { url: 'https://mjs.test' }, pages: ['/'] }\n")
    const c = await loadConfig(dir)
    assert.equal(c.serve.url, 'https://mjs.test')
    assert.equal(c.configFile, path.join(dir, 'lhkit.config.mjs'))
    assert.equal(c.root, dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('wrong types are ConfigError, not silently mangled', () => {
  const ok = { serve: { url: 'https://x.test' }, pages: ['/'] }
  const bad = [
    { ...ok, ai: { exclude: '**/secret/**' } },
    { ...ok, ai: { exclude: [1] } },
    { ...ok, ai: { maxFindings: 0 } },
    { ...ok, ai: { maxFindings: '3' } },
    { ...ok, ai: { model: '' } },
    { serve: { static: 'dist' }, https: { enabled: true, port: 'x' }, pages: ['/'] },
    { serve: { url: 'https://x.test', timeoutMs: -1 }, pages: ['/'] },
    { serve: { static: 'dist', port: 70000 }, pages: ['/'] },
    { ...ok, chromePath: 1 },
    { ...ok, categories: ['performance', 'speed'] },
    { ...ok, outDir: 3 },
  ]
  for (const raw of bad) assert.throws(() => norm(raw), ConfigError, JSON.stringify(raw))
})

test('pages that would share a result folder are rejected', () => {
  for (const pages of [['/', '/root'], ['/a?b', '/a_b'], ['/foo', '/foo/'], ['/m/home', '/m/home']])
    assert.throws(() => norm({ serve: { url: 'https://x.test' }, pages }), (e) => e instanceof ConfigError && /同一个/.test(e.message), JSON.stringify(pages))
})

test('ai.sourceRoot defaults to src/ when the project has one, else the project root', async () => {
  const withSrc = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-src-'))
  await fs.mkdir(path.join(withSrc, 'src'))
  const raw = { serve: { url: 'https://x.test' }, pages: ['/'] }
  assert.equal(normalizeConfig(raw, withSrc, path.join(withSrc, 'lhkit.config.mjs')).ai.sourceRoot, path.join(withSrc, 'src'))
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-src-'))
  assert.equal(normalizeConfig(raw, bare, path.join(bare, 'lhkit.config.mjs')).ai.sourceRoot, bare)
})
