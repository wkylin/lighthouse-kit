// 找本机的 Chrome / Chromium。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from './config.mjs'

const MAC_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
]
const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

/**
 * 顺序：config.chromePath、CHROME_PATH、macOS 常见安装位置、Linux 上 which 到的第一个。
 * @param {{chromePath: string|null}} config
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function findChrome(config, env = process.env) {
  if (config.chromePath) {
    if (fs.existsSync(config.chromePath)) return config.chromePath
    throw new ConfigError(`配置错误：chromePath 指向的文件不存在：${config.chromePath}`)
  }
  if (env.CHROME_PATH && fs.existsSync(env.CHROME_PATH)) return env.CHROME_PATH
  if (process.platform === 'darwin') {
    const hit = MAC_PATHS.find((p) => fs.existsSync(p))
    if (hit) return hit
  } else {
    for (const name of LINUX_NAMES) {
      try {
        const p = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (p) return p
      } catch {}
    }
  }
  throw new ConfigError('配置错误：找不到 Chrome / Chromium，请安装，或用环境变量 CHROME_PATH、配置项 chromePath 指定路径')
}
