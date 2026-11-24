// 轮次记录的 git 信息：当前提交，以及已跟踪的文件有没有未提交的改动（未跟踪的新文件不算，例如 lhkit.config.mjs）。
import { execFileSync } from 'node:child_process'

/**
 * @param {string} root
 * @returns {{commit: string, dirty: boolean}|null} 不是 git 仓库（或没有 git）时为 null
 */
export function gitInfo(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' }
  } catch {
    return null
  }
}
