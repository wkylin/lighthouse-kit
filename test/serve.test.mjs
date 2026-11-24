import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import tls from 'node:tls'
import { BuildError, runBuild } from '../src/build.mjs'
import { normalizeConfig } from '../src/config.mjs'
import { ensureCert } from '../src/serve/cert.mjs'
import { NotReadyError, PortInUseError, startTarget } from '../src/serve/index.mjs'

const tmp = (p = 'lhkit-serve-') => fs.mkdtemp(path.join(os.tmpdir(), p))
const silent = { info() {}, warn() {} }

async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => s.once('listening', r))
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid, ms = 4000) {
  const end = Date.now() + ms
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  return !alive(pid)
}

/** 后端：/api/* 回显路径；upgrade 回 101 后原样回显字节。 */
async function backend() {
  const server = http.createServer((req, res) => res.end(`api:${req.url}`))
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (d) => socket.write(d))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

/** 发 upgrade 请求、等 101、发 ping、收回显。 */
function tunnelEcho(socket, pathName) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let upgraded = false
    socket.on('data', (d) => {
      buf += d.toString()
      if (!upgraded && buf.includes('\r\n\r\n')) {
        upgraded = buf.startsWith('HTTP/1.1 101')
        if (!upgraded) return reject(new Error(buf))
        buf = ''
        socket.write('ping')
      } else if (upgraded && buf === 'ping') {
        socket.destroy()
        resolve(true)
      }
    })
    socket.on('error', reject)
    socket.write(`GET ${pathName} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)
  })
}

const cfg = (raw, root) => normalizeConfig({ pages: ['/'], ...raw }, root, path.join(root, 'lhkit.config.mjs'))

test('url mode starts nothing and returns the url origin', async () => {
  const t = await startTarget(cfg({ serve: { url: 'https://staging.example.com/' } }, '/p'), { log: silent, logDir: await tmp() })
  assert.equal(t.origin, 'https://staging.example.com')
  await t.stop()
})

test('static mode serves files, falls back to index.html for unknown paths, proxies HTTP and WebSocket under configured prefixes', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'dist/assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>app</h1>')
  await fs.writeFile(path.join(root, 'dist/assets/a.js'), 'console.log(1)')
  const api = await backend()
  const port = await freePort()
  const t = await startTarget(cfg({ serve: { static: 'dist', port, proxy: { '/api': api.url } } }, root), { log: silent, logDir: root })
  try {
    assert.equal(t.origin, `http://localhost:${port}`)
    const js = await fetch(`${t.origin}/assets/a.js`)
    assert.equal(await js.text(), 'console.log(1)')
    assert.match(js.headers.get('content-type'), /javascript/)
    assert.equal(await (await fetch(`${t.origin}/m/deep/route`)).text(), '<h1>app</h1>')
    assert.equal((await fetch(`${t.origin}/../../etc/passwd`)).status, 200, 'traversal falls back to index.html')
    assert.equal(await (await fetch(`${t.origin}/api/users?x=1`)).text(), 'api:/api/users?x=1')
    assert.ok(await tunnelEcho(net.connect(port, '127.0.0.1'), '/api/ws'))
  } finally {
    await t.stop()
    api.server.close()
  }
})

test('command mode waits for readyPath and stop() kills the whole process group', async () => {
  const root = await tmp()
  const port = await freePort()
  const script = `
    const { spawn } = require('node:child_process'); const http = require('node:http'); const fs = require('node:fs')
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    fs.writeFileSync('pids.json', JSON.stringify([process.pid, kid.pid]))
    setTimeout(() => http.createServer((q, s) => s.end(q.url === '/ready' ? 'ok' : 'x')).listen(${port}), 600)`
  await fs.writeFile(path.join(root, 'server.cjs'), script)
  const t = await startTarget(cfg({ serve: { command: 'node server.cjs', url: `http://localhost:${port}`, readyPath: '/ready' } }, root), { log: silent, logDir: root })
  const [parent, kid] = JSON.parse(await fs.readFile(path.join(root, 'pids.json'), 'utf8'))
  assert.equal(await (await fetch(`${t.origin}/ready`)).text(), 'ok')
  await t.stop()
  assert.ok(await waitGone(parent), 'server process stopped')
  assert.ok(await waitGone(kid), 'its child stopped too')
})

test('port in use fails fast', async () => {
  const root = await tmp()
  const busy = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => busy.once('listening', r))
  const { port } = busy.address()
  try {
    await assert.rejects(
      startTarget(cfg({ serve: { command: 'node -e "setInterval(()=>{},1000)"', url: `http://localhost:${port}` } }, root), { log: silent, logDir: root }),
      (e) => e instanceof PortInUseError && e.message.includes(String(port)),
    )
    await assert.rejects(startTarget(cfg({ serve: { static: '.', port } }, root), { log: silent, logDir: root }), PortInUseError)
  } finally {
    busy.close()
  }
})

test('server that never becomes ready is stopped', async () => {
  const root = await tmp()
  const port = await freePort()
  await fs.writeFile(path.join(root, 'idle.cjs'), "require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)")
  const config = cfg({ serve: { command: 'node idle.cjs', url: `http://localhost:${port}`, timeoutMs: 800 } }, root)
  await assert.rejects(startTarget(config, { log: silent, logDir: root }), (e) => e instanceof NotReadyError && e.message.includes(path.join(root, 'serve.log')))
  const pid = Number(await fs.readFile(path.join(root, 'pid'), 'utf8'))
  assert.ok(await waitGone(pid), 'the idle server was killed')
})

test('a server that exits before it is ready fails without waiting for the timeout', async () => {
  const root = await tmp()
  const port = await freePort()
  const started = Date.now()
  await assert.rejects(
    startTarget(cfg({ serve: { command: 'node -e "process.exit(3)"', url: `http://localhost:${port}`, timeoutMs: 20000 } }, root), { log: silent, logDir: root }),
    NotReadyError,
  )
  assert.ok(Date.now() - started < 5000)
})

test('https front proxy serves over HTTP/2 with a cached self-signed cert and tunnels WebSocket', async () => {
  const root = await tmp()
  const certDir = path.join(root, 'certs')
  const first = await ensureCert(certDir)
  assert.deepEqual(await ensureCert(certDir), first, 'second call reuses the cached cert')
  await fs.mkdir(path.join(root, 'dist'))
  await fs.writeFile(path.join(root, 'dist/index.html'), 'hello')
  const api = await backend()
  const [port, httpsPort] = [await freePort(), await freePort()]
  const t = await startTarget(cfg({ serve: { static: 'dist', port, proxy: { '/api': api.url } }, https: { enabled: true, port: httpsPort } }, root), { log: silent, logDir: root, certDir })
  try {
    assert.equal(t.origin, `https://localhost:${httpsPort}`)
    const client = http2.connect(t.origin, { rejectUnauthorized: false })
    const body = await new Promise((resolve, reject) => {
      const req = client.request({ ':path': '/' })
      let data = ''
      req.on('data', (d) => (data += d))
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
    client.close()
    assert.equal(body, 'hello')
    const socket = tls.connect({ port: httpsPort, host: '127.0.0.1', rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] })
    assert.ok(await tunnelEcho(socket, '/api/ws'))
  } finally {
    await t.stop()
    api.server.close()
  }
})

test('build writes its log and a failure throws BuildError with the log path', async () => {
  const root = await tmp()
  await runBuild(cfg({ build: { command: 'node -e "console.log(process.env.X)"', env: { X: 'built' } }, serve: { static: 'dist' } }, root), { log: silent, logDir: root })
  assert.match(await fs.readFile(path.join(root, 'build.log'), 'utf8'), /built/)
  await assert.rejects(
    runBuild(cfg({ build: { command: 'node -e "process.exit(2)"' }, serve: { static: 'dist' } }, root), { log: silent, logDir: root }),
    (e) => e instanceof BuildError && e.message.includes(path.join(root, 'build.log')),
  )
})

test('aborting while waiting for the server stops it at once', async () => {
  const root = await tmp()
  const port = await freePort()
  await fs.writeFile(path.join(root, 'idle.cjs'), "require('node:fs').writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000)")
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 700)
  const started = Date.now()
  await assert.rejects(startTarget(cfg({ serve: { command: 'node idle.cjs', url: `http://localhost:${port}`, timeoutMs: 30000 } }, root), { log: silent, logDir: root, signal: ac.signal }))
  assert.ok(Date.now() - started < 5000, 'did not wait for the timeout')
  assert.ok(await waitGone(Number(await fs.readFile(path.join(root, 'pid'), 'utf8'))))
})

test('static mode with a missing build folder is a ConfigError up front', async () => {
  const root = await tmp()
  await assert.rejects(startTarget(cfg({ serve: { static: 'dist', port: await freePort() } }, root), { log: silent, logDir: root }), (e) => e.name === 'ConfigError' && /lhkit build/.test(e.message))
})

test('a busy https port fails before the server is started', async () => {
  const root = await tmp()
  const busy = net.createServer().listen(0, '127.0.0.1')
  await new Promise((r) => busy.once('listening', r))
  await fs.writeFile(path.join(root, 'srv.cjs'), "require('node:fs').writeFileSync('started', '1'); setInterval(() => {}, 1000)")
  try {
    await assert.rejects(
      startTarget(cfg({ serve: { command: 'node srv.cjs', url: `http://localhost:${await freePort()}` }, https: { enabled: true, port: busy.address().port } }, root), { log: silent, logDir: root }),
      PortInUseError,
    )
    await assert.rejects(fs.access(path.join(root, 'started')), 'the server command never ran')
  } finally {
    busy.close()
  }
})

function rawGet(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathName, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('static mode caches hashed assets for a year, keeps html fresh and compresses text', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'dist/assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>app</h1>'.repeat(50))
  await fs.writeFile(path.join(root, 'dist/assets/app-AbCdEf12.js'), 'console.log(1);'.repeat(200))
  await fs.writeFile(path.join(root, 'dist/assets/app-AbCdEf12.js.br'), 'BROTLI-BYTES')
  await fs.writeFile(path.join(root, 'dist/assets/style-Zz9_8-x7.css'), 'body{color:red}'.repeat(100))
  const port = await freePort()
  const t = await startTarget(cfg({ serve: { static: 'dist', port } }, root), { log: silent, logDir: root })
  try {
    const br = await rawGet(port, '/assets/app-AbCdEf12.js', { 'accept-encoding': 'gzip, br' })
    assert.match(br.headers['cache-control'], /max-age=31536000.*immutable/)
    assert.equal(br.headers['content-encoding'], 'br')
    assert.equal(br.body.toString(), 'BROTLI-BYTES', 'a precompressed file is sent as is')
    assert.match(br.headers.vary, /accept-encoding/i)
    const gz = await rawGet(port, '/assets/style-Zz9_8-x7.css', { 'accept-encoding': 'gzip' })
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.equal((await import('node:zlib')).gunzipSync(gz.body).toString(), 'body{color:red}'.repeat(100))
    const html = await rawGet(port, '/', { 'accept-encoding': 'gzip' })
    assert.equal(html.headers['cache-control'], 'no-cache')
    assert.equal(html.headers['content-encoding'], 'gzip')
    const plain = await rawGet(port, '/assets/style-Zz9_8-x7.css')
    assert.equal(plain.headers['content-encoding'], undefined, 'no compression unless asked')
  } finally {
    await t.stop()
  }
})

test('the static proxy keeps the path of its target', async () => {
  const root = await tmp()
  await fs.mkdir(path.join(root, 'dist'))
  await fs.writeFile(path.join(root, 'dist/index.html'), 'x')
  const api = await backend()
  const port = await freePort()
  const t = await startTarget(cfg({ serve: { static: 'dist', port, proxy: { '/api': `${api.url}/v2` } } }, root), { log: silent, logDir: root })
  try {
    assert.equal(await (await fetch(`${t.origin}/api/users?x=1`)).text(), 'api:/v2/api/users?x=1')
  } finally {
    await t.stop()
    api.server.close()
  }
})

test('the servers lhkit starts listen on loopback only', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)
  if (!lan) return t.skip('no LAN address on this machine')
  const root = await tmp()
  await fs.mkdir(path.join(root, 'dist'))
  await fs.writeFile(path.join(root, 'dist/index.html'), 'x')
  const [port, httpsPort] = [await freePort(), await freePort()]
  const target = await startTarget(cfg({ serve: { static: 'dist', port }, https: { enabled: true, port: httpsPort } }, root), { log: silent, logDir: root, certDir: path.join(root, 'certs') })
  try {
    for (const p of [port, httpsPort]) {
      const refused = await new Promise((resolve) => {
        const s = net.connect({ host: lan.address, port: p })
        s.once('connect', () => (s.destroy(), resolve(false)))
        s.once('error', () => resolve(true))
      })
      assert.ok(refused, `port ${p} is not reachable on ${lan.address}`)
    }
  } finally {
    await target.stop()
  }
})

test('the https front ends a response whose upstream dies mid-body', async () => {
  const root = await tmp()
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.write('partial')
    setTimeout(() => res.socket.destroy(), 100)
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const port = upstream.address().port
  const httpsPort = await freePort()
  const { startH2Proxy } = await import('../src/serve/h2proxy.mjs')
  const proxy = await startH2Proxy({ target: `http://127.0.0.1:${port}`, port: httpsPort, cert: await ensureCert(path.join(root, 'certs')) })
  const client = http2.connect(proxy.origin, { rejectUnauthorized: false })
  try {
    const ended = await new Promise((resolve) => {
      const req = client.request({ ':path': '/' })
      req.on('data', () => {})
      req.on('close', () => resolve(true))
      req.on('error', () => {})
      setTimeout(() => resolve(false), 3000)
    })
    assert.ok(ended, 'the stream closed instead of hanging')
  } finally {
    client.close()
    await proxy.close()
    upstream.close()
  }
})
