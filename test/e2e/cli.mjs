// 命令行端到端：以子进程运行 bin/lhkit.mjs，对本地小站做真实扫描（约 2 分钟）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../../bin/lhkit.mjs', import.meta.url))
const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>t</title></head><body><h1>Hello</h1><p>text</p></body></html>'

function cli(args, cwd, { onStdout } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, LHKIT_NO_OPEN: '1' } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += d
    onStdout?.(stdout, child)
  })
  child.stderr.on('data', (d) => (stderr += d))
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })))
}

async function site() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/missing')) {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end('<h1>no</h1>')
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, origin: `http://localhost:${server.address().port}` }
}

async function projectWith(config, files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-cli-'))
  await fs.writeFile(path.join(dir, 'lhkit.config.mjs'), `export default ${JSON.stringify(config, null, 2)}\n`)
  for (const [rel, text] of Object.entries(files)) await fs.writeFile(path.join(dir, rel), text)
  return dir
}

const runsOf = async (dir) => (await fs.readdir(path.join(dir, '.lhkit', 'runs'))).sort()
const roundMeta = async (dir, id) => JSON.parse(await fs.readFile(path.join(dir, '.lhkit', 'runs', id, 'round.json'), 'utf8'))

let s
test.before(async () => (s = await site()))
test.after(() => s.server.close())

test('init writes a template from package.json scripts and refuses to overwrite', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-init-'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview' } }))
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '')
  const first = await cli(['init'], dir)
  assert.equal(first.code, 0)
  assert.ok(first.stdout.includes('pnpm add -D lighthouse-kit'), 'suggests installing with the project’s package manager')
  const text = await fs.readFile(path.join(dir, 'lhkit.config.mjs'), 'utf8')
  assert.ok(text.includes("'pnpm run build'") && text.includes("'pnpm run preview'") && text.includes('http://localhost:4173'))
  assert.equal((await cli(['init'], dir)).code, 2)
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }))
  assert.equal((await cli(['init', '--force'], dir)).code, 0)
  assert.ok((await fs.readFile(path.join(dir, 'lhkit.config.mjs'), 'utf8')).includes("static: 'dist'"))
})

test('config errors exit 2 with the message', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-noconf-'))
  const r = await cli(['scan'], dir)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /lhkit\.config\.mjs/)
  const bad = await projectWith({ serve: { url: 'https://x.test' }, pages: ['nope'] })
  assert.equal((await cli(['scan'], bad)).code, 2)
})

test('port in use exits 3', async () => {
  const busy = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => busy.once('listening', r))
  try {
    const dir = await projectWith({ serve: { static: '.', port: busy.address().port }, pages: ['/'] })
    const r = await cli(['scan'], dir)
    assert.equal(r.code, 3)
    assert.match(r.stderr, new RegExp(String(busy.address().port)))
  } finally {
    busy.close()
  }
})

let scanned
test('scan in url mode against a local fixture server produces overview, docs and history, exit 0', async () => {
  scanned = await projectWith({ serve: { url: s.origin }, pages: ['/a', '/b'] }, { '.gitignore': 'node_modules\n' })
  const r = await cli(['scan'], scanned)
  assert.equal(r.code, 0, r.stderr)
  const [id] = await runsOf(scanned)
  const round = path.join(scanned, '.lhkit', 'runs', id)
  for (const f of ['index.html', 'analysis.json', 'docs/dev.md', 'docs/dev.html', 'docs/lead.md', 'docs/lead.html', 'pages/a/run-1/lighthouse.html', 'pages/b/summary.json'])
    await fs.access(path.join(round, f))
  await fs.access(path.join(scanned, '.lhkit', 'history', `${id}.json`))
  assert.equal((await roundMeta(scanned, id)).status, 'complete')
  assert.ok(r.stdout.includes(path.join(round, 'index.html')))
  assert.ok(/\/a\s+性能/.test(r.stdout), 'one line per page')
  const log = await fs.readFile(path.join(round, 'logs', 'scan.log'), 'utf8')
  assert.ok(/\/a\s+性能/.test(log) && log.includes('总览：'), 'the scan output is also kept in logs/scan.log')
})

test('a missing .gitignore entry prints a hint and does not touch .gitignore', async () => {
  const again = await cli(['scan', '/a', '--name', 'hint'], scanned)
  assert.equal(again.code, 0)
  assert.match(again.stdout, /\.lhkit\/.*\.gitignore/)
  assert.equal(await fs.readFile(path.join(scanned, '.gitignore'), 'utf8'), 'node_modules\n')
  assert.equal((await roundMeta(scanned, 'hint')).partial, true, 'pages on the command line make a partial round')
})

test('analyze reruns on an existing round without scanning', async () => {
  const before = await runsOf(scanned)
  const id = before.find((x) => x !== 'hint')
  await fs.rm(path.join(scanned, '.lhkit', 'runs', id, 'docs'), { recursive: true })
  const r = await cli(['analyze', id], scanned)
  assert.equal(r.code, 0, r.stderr)
  await fs.access(path.join(scanned, '.lhkit', 'runs', id, 'docs', 'dev.md'))
  assert.deepEqual(await runsOf(scanned), before)
})

test('a new complete round prunes the previous unnamed complete round but keeps named ones', async () => {
  const before = await runsOf(scanned)
  const r = await cli(['scan'], scanned)
  assert.equal(r.code, 0)
  const after = await runsOf(scanned)
  assert.ok(after.includes('hint'))
  assert.equal(after.length, before.length, 'one round removed, one added')
  assert.ok(!after.includes(before.find((x) => x !== 'hint')))
})

test('some pages failing exits 4 and still writes docs', async () => {
  const dir = await projectWith({ serve: { url: s.origin }, pages: ['/a', '/missing'] })
  const r = await cli(['scan'], dir)
  assert.equal(r.code, 4)
  const [id] = await runsOf(dir)
  await fs.access(path.join(dir, '.lhkit', 'runs', id, 'docs', 'dev.md'))
  assert.equal((await roundMeta(dir, id)).status, 'failed-pages')
})

test('SIGINT marks the round aborted and keeps the previous round', async () => {
  const dir = await projectWith({ serve: { url: s.origin }, pages: ['/a', '/b', '/c'] })
  assert.equal((await cli(['scan'], dir)).code, 0, 'a full, unnamed previous round: exactly the kind a complete round would prune')
  const [previous] = await runsOf(dir)
  let sent = false
  const r = await cli(['scan'], dir, {
    onStdout: (out, child) => {
      if (!sent && /\/a\s+性能/.test(out)) {
        sent = true
        child.kill('SIGINT')
      }
    },
  })
  assert.equal(r.code, 1)
  const runs = await runsOf(dir)
  assert.ok(runs.includes(previous))
  const current = runs.find((x) => x !== previous)
  assert.equal((await roundMeta(dir, current)).status, 'aborted')
  await assert.rejects(fs.access(path.join(dir, '.lhkit', 'history', `${current}.json`)), 'an aborted round writes no history')
  const next = await cli(['scan', '/a', '--name', 'later'], dir)
  assert.equal(next.code, 0)
  assert.ok(next.stdout.includes(current) && next.stdout.includes('没有完整结果'), 'the next scan points at the aborted round')
})

function waitFor(file, ms = 15000) {
  const end = Date.now() + ms
  return (async () => {
    while (Date.now() < end) {
      try {
        return Number(await fs.readFile(file, 'utf8'))
      } catch {}
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`timed out waiting for ${file}`)
  })()
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function gone(pid, ms = 5000) {
  const end = Date.now() + ms
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
  return !alive(pid)
}

test('Ctrl+C during lhkit build stops the build', async () => {
  const dir = await projectWith({ build: { command: 'node build.cjs' }, serve: { static: 'dist' }, pages: ['/'] },
    { 'build.cjs': "require('node:fs').writeFileSync('build.pid', String(process.pid)); setInterval(() => {}, 1000)" })
  const child = spawn(process.execPath, [BIN, 'build'], { cwd: dir, env: { ...process.env, LHKIT_NO_OPEN: '1' } })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  const pid = await waitFor(path.join(dir, 'build.pid'))
  const started = Date.now()
  child.kill('SIGINT')
  assert.equal(await exited, 1)
  assert.ok(Date.now() - started < 6000)
  assert.ok(await gone(pid), 'the build process was stopped')
})

test('SIGTERM while waiting for the server stops it and marks the round aborted', async () => {
  const port = await new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
  const dir = await projectWith({ serve: { command: 'node serve.cjs', url: `http://localhost:${port}`, timeoutMs: 60000 }, pages: ['/'] },
    { 'serve.cjs': "require('node:fs').writeFileSync('serve.pid', String(process.pid)); setInterval(() => {}, 1000)" })
  const child = spawn(process.execPath, [BIN, 'scan'], { cwd: dir, env: { ...process.env, LHKIT_NO_OPEN: '1' } })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  const pid = await waitFor(path.join(dir, 'serve.pid'))
  const started = Date.now()
  child.kill('SIGTERM')
  assert.equal(await exited, 1)
  assert.ok(Date.now() - started < 6000, 'did not wait for the 60 s timeout')
  assert.ok(await gone(pid), 'the server was stopped')
  const [id] = await runsOf(dir)
  assert.equal((await roundMeta(dir, id)).status, 'aborted')
})

test('an option the command does not take exits 2', async () => {
  const dir = await projectWith({ serve: { url: 'https://x.test' }, pages: ['/'] })
  const r = await cli(['analyze', '--runs', '3'], dir)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /analyze.*--runs/)
})

test('a missing Chrome is one config error before anything starts', async () => {
  const dir = await projectWith({ serve: { url: s.origin }, pages: ['/a'], chromePath: '/nope/chrome' })
  const r = await cli(['scan'], dir)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /chromePath/)
  await assert.rejects(fs.access(path.join(dir, '.lhkit', 'runs')), 'no round was created')
})
