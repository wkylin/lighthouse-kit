// URL-only scans and configured URL overrides through the real CLI and Chrome.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const BIN = fileURLToPath(new URL('../../bin/lhkit.mjs', import.meta.url))
const exec = promisify(execFile)
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Direct URL scan</title></head><body><h1>Direct URL scan</h1><p>Local fixture.</p></body></html>'

const cli = (args, cwd) => exec(process.execPath, [BIN, ...args], {
  cwd, env: { ...process.env, LHKIT_NO_OPEN: '1' }, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
})
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-url-cli-'))
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { root, requests, origin: `http://localhost:${server.address().port}` }
}

async function reportFor(round) {
  const { pages: [{ slug }] } = await readJson(path.join(round, 'analysis.json'))
  return readJson(path.join(round, 'pages', slug, 'run-1', 'lighthouse.json'))
}

test('scan --url needs no config and writes the default reports and history', async t => {
  const { root, origin } = await fixture(t)
  const result = await cli(['scan', '--url', origin, '--name', 'direct'], root)
  const round = path.join(root, '.lhkit', 'runs', 'direct')
  const meta = await readJson(path.join(round, 'round.json'))
  assert.equal(meta.status, 'complete')
  assert.equal(meta.runs, 1)
  assert.deepEqual(meta.pagesRequested, ['/'])
  assert.equal((await reportFor(round)).requestedUrl, `${origin}/`)
  for (const file of ['index.html', 'analysis.json', 'docs/dev.md', 'docs/lead.html', 'pages/root/run-1/lighthouse.html'])
    await fs.access(path.join(round, file))
  await fs.access(path.join(root, '.lhkit', 'history', 'direct.json'))
  assert.ok(result.stdout.includes(path.join(round, 'index.html')))
  assert.deepEqual(await fs.readdir(root), ['.lhkit'], 'no configuration file is generated')
})

test('scan --url scans the complete path, query and fragment without appending a slash', async t => {
  const { root, origin, requests } = await fixture(t)
  const page = '/guide/start?lang=zh%2FCN&x=1#section'
  const url = origin + page
  await cli(['scan', '--url', url, '--name', 'full-url'], root)
  const round = path.join(root, '.lhkit', 'runs', 'full-url')
  const meta = await readJson(path.join(round, 'round.json'))
  assert.equal(meta.status, 'complete')
  assert.equal(meta.origin, origin)
  assert.deepEqual(meta.pagesRequested, [page])
  assert.equal((await reportFor(round)).requestedUrl, url)
  assert.ok(requests.includes('/guide/start?lang=zh%2FCN&x=1'), 'the server receives the exact query')
  assert.equal((await readJson(path.join(round, 'analysis.json'))).pages[0].page, page)
})

test('run --url honors --config, explicit pages and --runs without creating a config', async t => {
  const { root, origin } = await fixture(t)
  const project = path.join(root, 'project')
  await fs.mkdir(project)
  await cli(['run', '/chosen?x=1', '--url', `${origin}/unused?discard=1#old`, '--config', './project', '--runs', '2', '--name', 'repeated'], root)
  const round = path.join(project, '.lhkit', 'runs', 'repeated')
  const meta = await readJson(path.join(round, 'round.json'))
  assert.equal(meta.status, 'complete')
  assert.equal(meta.runs, 2)
  assert.equal(meta.partial, true)
  assert.deepEqual(meta.pagesRequested, ['/chosen?x=1'])
  assert.equal((await reportFor(round)).requestedUrl, `${origin}/chosen?x=1`)
  const [slug] = await fs.readdir(path.join(round, 'pages'))
  await fs.access(path.join(round, 'pages', slug, 'run-2', 'lighthouse.json'))
  assert.deepEqual(await fs.readdir(project), ['.lhkit'])
  await assert.rejects(fs.access(path.join(root, '.lhkit')), 'output stays under --config')
})

test('configured run --url retains hooks and custom output while CLI pages and runs win', async t => {
  const { root, origin, requests } = await fixture(t)
  const failCommand = 'node -e "process.exit(73)"'
  const raw = { build: { command: failCommand }, serve: { command: failCommand, url: 'http://localhost:1' }, pages: ['/configured'], runs: 3, outDir: 'reports' }
  const text = `import { appendFileSync } from 'node:fs'\nexport default { ...${JSON.stringify(raw)}, beforePage() { appendFileSync(new URL('./hook-ran', import.meta.url), 'hook\\n') } }\n`
  const file = path.join(root, 'lhkit.config.mjs')
  await fs.writeFile(file, text)
  await cli(['run', '/selected?x=1', '--url', `${origin}/prefix/`, '--runs', '1', '--name', 'configured'], root)
  const round = path.join(root, 'reports', 'runs', 'configured')
  const meta = await readJson(path.join(round, 'round.json'))
  assert.equal(meta.status, 'complete', 'the configured build and service commands are skipped')
  assert.equal(meta.runs, 1)
  assert.deepEqual(meta.pagesRequested, ['/selected?x=1'])
  assert.equal((await reportFor(round)).requestedUrl, `${origin}/prefix/selected?x=1`)
  assert.ok(requests.includes('/prefix/selected?x=1'))
  assert.equal(await fs.readFile(path.join(root, 'hook-ran'), 'utf8'), 'hook\n')
  assert.equal(await fs.readFile(file, 'utf8'), text)
  await assert.rejects(fs.access(path.join(root, '.lhkit')))
})
