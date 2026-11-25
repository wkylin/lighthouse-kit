// 子进程组：起服务、等就绪、整组停止。
import { execSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { NotReadyError } from '../errors.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 本机 127.0.0.1 或 ::1 上该端口能连上即视为占用。 */
export async function isPortInUse(port) {
  const tryHost = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host })
      const done = (used) => {
        socket.destroy()
        resolve(used)
      }
      socket.setTimeout(500, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    })
  return (await tryHost('127.0.0.1')) || (await tryHost('::1'))
}

/**
 * 杀掉占用指定端口的进程（macOS/Linux）。
 * @param {number} port
 * @returns {Promise<boolean>} 返回是否成功杀掉了进程
 */
export async function killPortProcess(port) {
  try {
    const isUnix = process.platform !== 'win32'
    if (!isUnix) return false // Windows 下不支持自动 kill

    // macOS 和 Linux 都支持 lsof
    let pid = null
    try {
      const output = execSync(`lsof -i :${port} -t`, { encoding: 'utf8', stdio: 'pipe' }).trim()
      pid = parseInt(output.split('\n')[0], 10)
    } catch {
      // lsof 不可用，尝试 netstat (Linux)
      try {
        const output = execSync(`netstat -tlnp 2>/dev/null | grep :${port}`, { encoding: 'utf8', shell: true })
        const match = output.match(/\/(\d+)/)
        if (match) pid = parseInt(match[1], 10)
      } catch {
        return false
      }
    }

    if (!pid || isNaN(pid) || pid === process.pid) {
      // 不 kill 主进程（当前进程），只 kill 子进程
      return false
    }

    try {
      process.kill(pid, 'SIGTERM')
      await sleep(500)
      // 检查进程是否仍在运行
      try {
        process.kill(pid, 0)
        // 仍在运行，尝试 SIGKILL
        process.kill(pid, 'SIGKILL')
        await sleep(500)
      } catch {
        // 进程已死亡
      }
      return true
    } catch {
      return false
    }
  } catch {
    return false
  }
}

/**
 * 在独立进程组里运行 shell 命令，输出追加到 logFile。
 * @returns {import('node:child_process').ChildProcess & {exited: Promise<{code: number|null, signal: string|null}>}}
 */
export function spawnGroup(command, { cwd, env, logFile }) {
  const fd = fs.openSync(logFile, 'a')
  const child = spawn(command, { shell: true, detached: true, cwd, env, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  child.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', () => resolve({ code: -1, signal: null }))
  })
  return child
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/** 先 SIGTERM 整个进程组，graceMs 后仍在则 SIGKILL。 */
export async function stopGroup(child, graceMs = 3000) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    return
  }
  const end = Date.now() + graceMs
  while (groupAlive(child.pid) && Date.now() < end) await sleep(50)
  if (groupAlive(child.pid)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }
}

/**
 * 每 500ms 请求一次 url，状态码 < 500 即就绪；进程提前退出或超时抛 NotReadyError。
 */
export async function waitReady(url, { timeoutMs, child, logFile, signal }) {
  const started = Date.now()
  let exited = null
  child?.exited.then((r) => (exited = r))
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw Object.assign(new Error('已中断'), { name: 'AbortError' })
    if (exited) throw new NotReadyError(`服务进程在就绪前退出（退出码 ${exited.code ?? exited.signal}），日志：${logFile}`, logFile)
    try {
      const timeout = AbortSignal.timeout(2000)
      const res = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([timeout, signal]) : timeout })
      await res.body?.cancel()
      if (res.status < 500) return
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  throw new NotReadyError(`等了 ${Math.round(timeoutMs / 1000)} 秒，${url} 仍未就绪，日志：${logFile}`, logFile)
}
