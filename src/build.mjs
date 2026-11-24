// 运行项目的构建命令，输出写到 build.log。
import path from 'node:path'
import { BuildError } from './errors.mjs'
import { spawnGroup, stopGroup } from './serve/process.mjs'

export { BuildError }

/**
 * @param {import('./types.mjs').Config} config
 * @param {{log: {info: (m: string) => void}, logDir: string, signal?: AbortSignal}} opts
 */
export async function runBuild(config, { log, logDir, signal }) {
  if (!config.build) return
  const logFile = path.join(logDir, 'build.log')
  log.info(`构建：${config.build.command}`)
  const child = spawnGroup(config.build.command, { cwd: config.root, env: { ...process.env, ...config.build.env }, logFile })
  const onAbort = () => void stopGroup(child)
  signal?.addEventListener('abort', onAbort, { once: true })
  const { code, signal: sig } = await child.exited
  signal?.removeEventListener('abort', onAbort)
  if (signal?.aborted) throw new BuildError(`构建被中断，日志：${logFile}`, logFile)
  if (code !== 0) throw new BuildError(`构建失败（退出码 ${code ?? sig}），日志：${logFile}`, logFile)
}
