// HTTP/2（TLS）前置代理：让浏览器像访问线上一样加载本地服务。
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import { PortInUseError } from '../errors.mjs'
import { tunnelUpgrade } from './static.mjs'

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'http2-settings', 'te'])

/**
 * @param {{target: string, port: number, cert: {key: string, cert: string}}} opts
 * @returns {Promise<{origin: string, close: () => Promise<void>}>}
 */
export async function startH2Proxy({ target, port, cert }) {
  const to = new URL(target)
  const lib = to.protocol === 'https:' ? https : http
  const server = http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: true })
  const sessions = new Set()
  const sockets = new Set()
  server.on('session', (s) => {
    sessions.add(s)
    s.on('close', () => sessions.delete(s))
  })
  server.on('secureConnection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('request', (req, res) => {
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(':') && !HOP.has(k)) headers[k] = v
    headers.host = to.host
    // 上游中途断开时结束这个响应，不让浏览器一直等。
    const fail = () => {
      if (res.headersSent) {
        if (res.stream) res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
        else res.destroy()
        return
      }
      try {
        res.writeHead(502)
        res.end()
      } catch {}
    }
    const up = lib.request({ protocol: to.protocol, hostname: to.hostname, port: to.port, method: req.method, path: `${to.pathname.replace(/\/+$/, '')}${req.url}`, headers }, (r) => {
      const h = {}
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) h[k] = v
      res.writeHead(r.statusCode ?? 502, h)
      r.on('aborted', fail)
      r.on('error', fail)
      r.pipe(res)
    })
    up.on('error', fail)
    req.pipe(up)
  })
  // WebSocket 走 HTTP/1.1 升级：原样转给目标服务。
  server.on('upgrade', (req, socket, head) => sockets.add(tunnelUpgrade(req, socket, head, to)))
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new PortInUseError(port) : e))
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    origin: `https://localhost:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sessions) s.destroy()
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}
