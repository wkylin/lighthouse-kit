// 命令行输出。构建、服务、扫描的详细日志写在轮次的 logs/ 目录。
import fs from 'node:fs'
import path from 'node:path'

const pad = (n) => String(n).padStart(2, '0')
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`

/**
 * 同时写进文件的日志：照常输出，每行再追加到 file（带时间）。quiet 时文件里仍有完整记录。
 * @template {{info: (m: string) => void, warn: (m: string) => void, error?: (m: string) => void}} L
 * @param {L} log
 * @param {string} file
 * @returns {L & {file: string, fileOnly: (line: string) => void}}
 */
export function withFile(log, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const write = (line) => {
    try {
      fs.appendFileSync(file, `${clock()} ${line}\n`)
    } catch {
      // 日志文件写不进去不影响扫描
    }
  }
  return {
    ...log,
    file,
    /** 只记进文件（例如交给上层打印的错误） */
    fileOnly: write,
    info: (msg) => {
      log.info(msg)
      write(msg)
    },
    warn: (msg) => {
      log.warn(msg)
      write(`警告：${msg}`)
    },
    error: (msg) => {
      log.error?.(msg)
      write(`错误：${msg}`)
    },
  }
}

/**
 * @param {{quiet?: boolean, out?: NodeJS.WritableStream, err?: NodeJS.WritableStream}} [opts]
 */
export function createLogger({ quiet = false, out = process.stdout, err = process.stderr } = {}) {
  const log = {
    info: (msg) => {
      if (!quiet) out.write(`${msg}\n`)
    },
    warn: (msg) => err.write(`警告：${msg}\n`),
    error: (msg) => err.write(`错误：${msg}\n`),
    /** @param {string} file */
    withFile: (file) => withFile(log, file),
  }
  return log
}
