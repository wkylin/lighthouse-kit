import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigError, loadConfig, normalizeConfig } from '../src/config.mjs'

const norm = (raw, overrides) => normalizeConfig(raw, '/p', '/p/lhkit.config.mjs', overrides)

test('AI providers supply defaults while advanced controls can be overridden', () => {
  const base = { serve: { url: 'https://x.test' }, pages: ['/'] }
  for (const [provider, model, apiKeyEnv, baseURL] of [
    ['anthropic', 'claude-opus-5-5', 'ANTHROPIC_API_KEY', null],
    ['openai', 'gpt-4.1-mini', 'OPENAI_API_KEY', 'https://api.openai.com/v1'],
    ['deepseek', 'deepseek-flash', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com'],
  ]) {
    const ai = norm({ ...base, ai: { provider } }).ai
    assert.equal(ai.provider, provider)
    assert.equal(ai.model, model)
    assert.equal(ai.apiKeyEnv, apiKeyEnv)
    assert.equal(ai.baseURL, baseURL)
    assert.equal(ai.concurrency, 2)
    assert.equal(ai.cache, true)
    assert.equal(ai.maxRetries, 1)
    assert.equal(ai.timeoutMs, 120000)
  }
  const ai = norm({ ...base, ai: { provider: 'openai-compatible', model: 'local-model', baseURL: 'http://localhost:8080/api/v1/', apiKeyEnv: 'MY_KEY',
    responseFormat: 'text', maxFileChars: 500, maxFindingChars: 1500, maxTokens: 2048, concurrency: 1, cache: false,
    timeoutMs: 5000, maxRetries: 0, language: 'en', instructions: 'Keep server-side rendering.' } }).ai
  assert.equal(ai.baseURL, 'http://localhost:8080/api/v1')
  assert.equal(ai.responseFormat, 'text')
  assert.equal(ai.maxFileChars, 500)
  assert.equal(ai.cache, false)
  assert.equal(ai.instructions, 'Keep server-side rendering.')
})

test('invalid AI controls are rejected before making a request', () => {
  for (const ai of [
    { provider: 'codex' }, { provider: 'openai-compatible' }, { provider: 'openai-compatible', model: 'm' },
    { baseURL: 'file:///tmp/model' }, { baseURL: 'https://user:pass@example.com' }, { baseURL: 'https://example.com?key=secret' },
    { baseURL: 'https://example.com#frag' }, { enabled: 'yes' }, { cache: 'false' }, { timeoutMs: 0 }, { maxTokens: 0 },
    { concurrency: 9 }, { concurrency: 1.5 }, { maxRetries: 4 }, { maxRetries: -1 }, { responseFormat: 'xml' },
    { maxFileChars: 0 }, { maxFileChars: 100, maxFindingChars: 50 }, { instructions: 42 }, { language: '' }, { model: '   ' },
  ]) assert.throws(() => norm({ serve: { url: 'https://x.test' }, pages: ['/'], ai }), ConfigError, JSON.stringify(ai))
})

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

test('omitting pages enables discovery from the complete URL or local service root', () => {
  const c = norm({ serve: { url: 'https://example.com/app/start?lang=zh#intro' } })
  assert.deepEqual(c.pages, ['/app/start?lang=zh#intro'])
  assert.equal(c.serve.url, 'https://example.com')
  assert.deepEqual(c.crawl, { enabled: true, maxPages: 50, maxDepth: 3, timeoutMs: 15000 })
  assert.deepEqual(norm({ serve: { static: 'dist' } }).pages, ['/'])
  assert.equal(norm({ serve: { static: 'dist' }, pages: ['/'] }).crawl.enabled, false)
})

test('crawl limits accept configuration and CLI overrides without changing explicit pages', () => {
  const c = norm({ serve: { url: 'https://example.com/app/' }, pages: ['/a'], crawl: { maxPages: 20, maxDepth: 2, timeoutMs: 7000 } }, { maxPages: 5, maxDepth: 0 })
  assert.deepEqual(c.crawl, { enabled: false, maxPages: 5, maxDepth: 0, timeoutMs: 7000 })
  assert.deepEqual(c.pages, ['/a'])
  assert.equal(c.serve.url, 'https://example.com/app/')
})

test('invalid crawl configuration and overrides are configuration errors', () => {
  for (const crawl of [true, [], { maxPages: 0 }, { maxPages: 1.5 }, { maxPages: '3' }, { maxDepth: -1 }, { maxDepth: 0.5 }, { timeoutMs: 0 }, { timeoutMs: 2147483648 }])
    assert.throws(() => norm({ serve: { url: 'https://example.com' }, crawl }), e => e instanceof ConfigError && /crawl/.test(e.message))
  for (const overrides of [{ maxPages: 0 }, { maxDepth: -1 }])
    assert.throws(() => norm({ serve: { url: 'https://example.com' } }, overrides), ConfigError)
})

test('rejects bad configs with ConfigError', () => {
  const ok = { serve: { url: 'https://x.test' }, pages: ['/'] }
  const bad = [
    { ...ok, pages: [] },
    { ...ok, pages: null },
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

test('loadConfig accepts --url without a file and creates no configuration or output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-url-config-'))
  try {
    const c = await loadConfig(dir, { url: 'https://example.com' })
    assert.equal(c.root, dir)
    assert.equal(c.configFile, null)
    assert.equal(c.serve.mode, 'url')
    assert.equal(c.serve.url, 'https://example.com')
    assert.deepEqual(c.pages, ['/'])
    assert.equal(c.runs, 1)
    assert.equal(c.build, null)
    assert.equal(c.ai.enabled, false)
    assert.equal(c.outDir, path.join(dir, '.lhkit'))
    assert.equal((await loadConfig(dir, { url: 'https://example.com', runs: 3 })).runs, 3)
    assert.deepEqual(await fs.readdir(dir), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('standalone --url preserves complete page paths, queries, fragments and ports', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-url-config-'))
  try {
    for (const [url, port] of [
      ['https://example.com/docs/start?lang=zh%2FCN#intro', 443],
      ['http://localhost:4321/app/', 4321],
      ['http://localhost/', 80],
      ['https://example.com/?x=1#top', 443],
      ['https://example.com/docs?', 443],
      ['https://example.com/docs#', 443],
    ]) {
      const c = await loadConfig(dir, { url })
      assert.equal(c.serve.url + c.pages[0], url)
      assert.equal(c.serve.port, port)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('--url and --runs override an existing config while preserving project settings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-url-config-'))
  const file = path.join(dir, 'lhkit.config.mjs')
  const text = `export default { build: { command: 'npm run build' }, serve: { static: 'dist' }, pages: ['/a', '/b'], runs: 2,
    outDir: 'reports', sourceMap: { maps: 'dist' }, beforePage: async () => {}, ai: { enabled: true } }\n`
  try {
    await fs.writeFile(file, text)
    const c = await loadConfig(dir, { url: 'https://staging.example.com/app/', runs: 3 })
    assert.equal(c.configFile, file)
    assert.equal(c.serve.url, 'https://staging.example.com/app/')
    assert.equal(c.serve.mode, 'url')
    assert.equal(c.build, null)
    assert.equal(c.runs, 3)
    assert.deepEqual(c.pages, ['/a', '/b'])
    assert.equal(c.outDir, path.join(dir, 'reports'))
    assert.equal(c.sourceMap.maps, path.join(dir, 'dist'))
    assert.equal(typeof c.beforePage, 'function')
    assert.equal(c.ai.enabled, true)
    assert.equal(await fs.readFile(file, 'utf8'), text)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('--url must be a valid HTTP/HTTPS URL with or without a config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-url-config-'))
  try {
    for (const configured of [false, true]) {
      if (configured) await fs.writeFile(path.join(dir, 'lhkit.config.mjs'), "export default { serve: { url: 'https://example.com' }, pages: ['/'] }\n")
      for (const url of ['', 'example.com', '//example.com', 'file:///tmp/index.html', 'ftp://example.com', 'javascript:alert(1)'])
        await assert.rejects(loadConfig(dir, { url }), e => e instanceof ConfigError && /--url/.test(e.message), url)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('--url never hides a broken existing configuration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-url-config-'))
  try {
    await fs.writeFile(path.join(dir, 'lhkit.config.mjs'), 'export default { pages: [] }\n')
    await assert.rejects(loadConfig(dir, { url: 'https://example.com' }), e => e instanceof ConfigError && /pages/.test(e.message))
    await fs.writeFile(path.join(dir, 'lhkit.config.js'), 'export default {\n')
    await fs.rm(path.join(dir, 'lhkit.config.mjs'))
    await assert.rejects(loadConfig(dir, { url: 'https://example.com' }), e => e instanceof ConfigError && /读取 lhkit\.config\.js 失败/.test(e.message))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('standalone --url requires an existing project directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-url-config-'))
  try {
    const file = path.join(dir, 'not-a-directory')
    await fs.writeFile(file, '')
    for (const root of [path.join(dir, 'missing'), file])
      await assert.rejects(loadConfig(root, { url: 'https://example.com' }), e => e instanceof ConfigError && /目录/.test(e.message))
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
  for (const pages of [['/', '/root'], ['/a?b', '/a_b'], ['/foo', '/foo/'], ['/m/home', '/m/home'], ['/a/b', '/a//b']])
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
