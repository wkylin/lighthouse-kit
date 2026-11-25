// 按配置准备被扫描的目标：直接用网址、托管构建目录，或运行项目自己的服务命令；可加 HTTPS 前置代理。
import fs from 'node:fs'
import path from 'node:path'
import { ConfigError } from '../config.mjs'
import { NotReadyError, PortInUseError } from '../errors.mjs'
import { DEFAULT_CERT_DIR, ensureCert } from './cert.mjs'
import { startH2Proxy } from './h2proxy.mjs'
import { isPortInUse, killPortProcess, spawnGroup, stopGroup, waitReady } from './process.mjs'
import { startStaticServer } from './static.mjs'

export { NotReadyError, PortInUseError }

const trimSlash = (u) => u.replace(/\/+$/, '')

/**
 * @param {import('../types.mjs').Config} config
 * @param {{log: {info: (m: string) => void}, logDir: string, certDir?: string, signal?: AbortSignal}} opts
 * @returns {Promise<{origin: string, stop: () => Promise<void>}>}
 */
export async function startTarget(config, { log, logDir, certDir = DEFAULT_CERT_DIR, signal }) {
  const { serve } = config
  if (serve.mode === 'url') return { origin: trimSlash(serve.url), stop: async () => {} }
  const stoppers = []
  const stop = async () => {
    for (const s of stoppers.reverse()) {
      try {
        await s()
      } catch {}
    }
    stoppers.length = 0
  }
  try {
    let origin = trimSlash(serve.url)
    // 起任何东西之前先检查：构建目录在不在、两个端口是否空闲。
    if (serve.mode === 'static' && !fs.existsSync(serve.static))
      throw new ConfigError(`配置错误：构建目录 ${serve.static} 不存在，先运行 lhkit build（或 lhkit run）`)

    // 检查端口占用，如果被占用则尝试自动 kill
    if (await isPortInUse(serve.port)) {
      log.info(`端口 ${serve.port} 被占用，尝试 kill 占用进程...`)
      const killed = await killPortProcess(serve.port)
      if (killed) {
        log.info(`✓ 已杀掉占用端口 ${serve.port} 的进程`)
        await new Promise((r) => setTimeout(r, 1000)) // 等待端口释放
      } else {
        // 仍然被占用，抛出错误
        if (await isPortInUse(serve.port)) {
          throw new PortInUseError(serve.port)
        }
      }
    }

    if (config.https.enabled && (await isPortInUse(config.https.port))) {
      log.info(`HTTPS 端口 ${config.https.port} 被占用，尝试 kill 占用进程...`)
      const killed = await killPortProcess(config.https.port)
      if (killed) {
        log.info(`✓ 已杀掉占用端口 ${config.https.port} 的进程`)
        await new Promise((r) => setTimeout(r, 1000))
      } else {
        if (await isPortInUse(config.https.port)) {
          throw new PortInUseError(config.https.port)
        }
      }
    }

    if (serve.mode === 'static') {
      const server = await startStaticServer({ dir: serve.static, port: serve.port, proxy: serve.proxy })
      stoppers.push(() => server.close())
      log.info(`托管 ${serve.static} → ${origin}`)
    } else {
      const logFile = path.join(logDir, 'serve.log')
      log.info(`启动服务：${serve.command}`)
      const child = spawnGroup(serve.command, { cwd: config.root, env: process.env, logFile })
      stoppers.push(() => stopGroup(child))
      await waitReady(`${origin}${serve.readyPath}`, { timeoutMs: serve.timeoutMs, child, logFile, signal })
      log.info(`服务已就绪：${origin}`)
    }
    if (config.https.enabled) {
      const cert = await ensureCert(certDir)
      const proxy = await startH2Proxy({ target: serve.url, port: config.https.port, cert })
      stoppers.push(() => proxy.close())
      origin = proxy.origin
      log.info(`HTTPS（HTTP/2）前置代理：${origin}`)
    }
    return { origin, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
