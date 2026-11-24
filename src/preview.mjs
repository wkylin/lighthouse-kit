// 用系统默认浏览器打开文件。设置 LHKIT_NO_OPEN=1 时不打开（测试、CI）。
import { spawn } from 'node:child_process'

export function openInBrowser(file, env = process.env) {
  if (env.LHKIT_NO_OPEN) return false
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    spawn(cmd, [file], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}
