// 托管构建目录：静态文件、单页应用回退到 index.html、按前缀转发 HTTP 与 WebSocket。
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { PortInUseError } from '../errors.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json|xml)|image\/svg\+xml)/
/** 带内容哈希的文件名（Vite / webpack 的 name-AbCd1234.js）：内容不会变，可以长缓存。 */
function isHashed(file) {
  const m = /[-.]([A-Za-z0-9_-]{8,12})\.[a-z0-9]+$/i.exec(path.basename(file))
  return !!m && /[A-Z0-9]/.test(m[1])
}
/** 目标地址的路径前缀（'/api': 'https://host/v2' → /v2/api/...，与 Vite 的 proxy 一致）。 */
const targetPath = (target, url) => `${target.pathname.replace(/\/+$/, '')}${url}`

function proxyTarget(proxy, url) {
  const prefixes = Object.keys(proxy).sort((a, b) => b.length - a.length)
  const hit = prefixes.find((p) => url === p || url.startsWith(p.endsWith('/') ? p : `${p}/`) || url.startsWith(`${p}?`))
  return hit ? new URL(proxy[hit]) : null
}

function forward(req, res, target) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v
  headers.host = target.host
  const lib = target.protocol === 'https:' ? https : http
  const up = lib.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: targetPath(target, req.url), headers }, (r) => {
    const h = {}
    for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v
    res.writeHead(r.statusCode ?? 502, h)
    r.pipe(res)
  })
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  })
  req.pipe(up)
}

/** WebSocket 升级：原样转发握手，之后双向管道。 */
export function tunnelUpgrade(req, socket, head, target) {
  const port = Number(target.port) || (target.protocol === 'https:' || target.protocol === 'wss:' ? 443 : 80)
  const secure = target.protocol === 'https:' || target.protocol === 'wss:'
  const up = secure ? tls.connect({ port, host: target.hostname, servername: target.hostname }) : net.connect(port, target.hostname)
  up.once(secure ? 'secureConnect' : 'connect', () => {
    let raw = `${req.method} ${targetPath(target, req.url)} HTTP/1.1\r\n`
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]
      raw += `${name}: ${name.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]}\r\n`
    }
    up.write(`${raw}\r\n`)
    if (head?.length) up.write(head)
    socket.pipe(up)
    up.pipe(socket)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
  return up
}

function serveFile(dir, req, res) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  } catch {
    pathname = '/'
  }
  const root = path.resolve(dir)
  const full = path.resolve(root, `.${path.posix.normalize(pathname)}`)
  let file = full.startsWith(root + path.sep) || full === root ? full : null
  if (file) {
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
      if (!fs.statSync(file).isFile()) file = null
    } catch {
      file = null
    }
  }
  if (!file) {
    const index = path.join(root, 'index.html')
    if (!fs.existsSync(index)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('Not found')
    }
    file = index
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const headers = { 'content-type': type, 'cache-control': isHashed(file) ? 'public, max-age=31536000, immutable' : 'no-cache' }
  // 像线上一样压缩：构建产出了 .br / .gz 就直接用，否则文本类内容现场 gzip。
  const accepts = String(req.headers['accept-encoding'] ?? '')
  const compressible = COMPRESSIBLE.test(type)
  let source = file
  let encode = null
  if (compressible) {
    headers.vary = 'Accept-Encoding'
    if (/\bbr\b/.test(accepts) && fs.existsSync(`${file}.br`)) [source, headers['content-encoding']] = [`${file}.br`, 'br']
    else if (/\bgzip\b/.test(accepts) && fs.existsSync(`${file}.gz`)) [source, headers['content-encoding']] = [`${file}.gz`, 'gzip']
    else if (/\bgzip\b/.test(accepts)) [encode, headers['content-encoding']] = [zlib.createGzip(), 'gzip']
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  const stream = fs.createReadStream(source)
  if (encode) stream.pipe(encode).pipe(res)
  else stream.pipe(res)
}

/**
 * @param {{dir: string, port: number, proxy: Record<string, string>}} opts
 * @returns {Promise<{close: () => Promise<void>}>}
 */
export async function startStaticServer({ dir, port, proxy }) {
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const target = proxyTarget(proxy, req.url ?? '/')
    if (target) forward(req, res, target)
    else serveFile(dir, req, res)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', (req, socket, head) => {
    const target = proxyTarget(proxy, req.url ?? '/')
    if (!target) return socket.destroy()
    sockets.add(tunnelUpgrade(req, socket, head, target))
  })
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new PortInUseError(port) : e))
    // 只在本机回环地址上监听：扫描期间构建产物和接口转发不暴露给局域网。
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
