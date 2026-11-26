// 命令的编排：init、run、build、scan、analyze、preview、compare。返回退出码。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { analyzeRound, readAnalysis, writeAnalysis } from './analyze/index.mjs'
import { carryForwardAi, enrichWithAi } from './ai/index.mjs'
import { exportAiRequest, importAiReply, readAiJson } from './ai/exchange.mjs'
import { stageImportOutputs, withImportLock } from './ai/import-output.mjs'
import { runBuild } from './build.mjs'
import { compareRounds } from './compare.mjs'
import { findChrome } from './chrome.mjs'
import { ConfigError, checkPages, loadConfig } from './config.mjs'
import { writeDocs } from './docs/index.mjs'
import { BuildError, NotReadyError, PortInUseError } from './errors.mjs'
import { gitInfo } from './git.mjs'
import { appendHistory, comparableBaseline, historyEntryFromRound, readHistory, trend } from './history.mjs'
import { installHint, writeConfigTemplate } from './init.mjs'
import { createLogger, withFile } from './log.mjs'
import { openInBrowser } from './preview.mjs'
import { writeIndex } from './report/index-page.mjs'
import { createRound, pruneRounds, readRoundMeta, resolveRound, staleRoundsHint, writeRoundMeta } from './round.mjs'
import { scanRound } from './scan.mjs'
import { startTarget } from './serve/index.mjs'

/** 每个命令接受的参数；给了用不上的参数直接报错，而不是悄悄忽略。 */
const ALLOWED = {
  init: ['force', 'config'],
  build: ['config'],
  run: ['runs', 'name', 'url', 'ai-dry-run', 'config'],
  scan: ['runs', 'name', 'url', 'ai-dry-run', 'config'],
  analyze: ['ai-dry-run', 'config'],
  preview: ['config'],
  compare: ['config'],
  'ai-export': ['config'],
  'ai-import': ['config'],
}

const OPTIONS = {
  config: { type: 'string' },
  runs: { type: 'string' },
  name: { type: 'string' },
  url: { type: 'string' },
  'ai-dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
}

/** 错误 → 退出码：配置 2；端口/未就绪 3；其他 1。 */
export function exitCodeFor(error) {
  if (error instanceof ConfigError) return 2
  if (error instanceof PortInUseError || error instanceof NotReadyError) return 3
  return 1
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** Ctrl+C、kill、终端关闭都走同一条中止路径：停构建、停服务、关浏览器、标记轮次。返回解除函数。 */
function onStop(ac, log) {
  const handler = (sig) => {
    if (!ac.signal.aborted) log.info(`收到 ${sig}，正在停止……`)
    ac.abort()
  }
  for (const sig of STOP_SIGNALS) process.on(sig, handler)
  return () => {
    for (const sig of STOP_SIGNALS) process.off(sig, handler)
  }
}

function buildFingerprint(config) {
  const sha = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
  try {
    if (config.sourceMap.manifest && fs.existsSync(config.sourceMap.manifest)) return sha(fs.readFileSync(config.sourceMap.manifest))
    if (config.serve.mode === 'static' && fs.existsSync(config.serve.static))
      return sha(fs.readdirSync(config.serve.static, { recursive: true }).map(String).sort().join('\n'))
  } catch {}
  return null
}

function gitignoreHint(config, log) {
  const rel = path.relative(config.root, config.outDir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
  const posix = rel.split(path.sep).join('/')
  let lines = []
  try {
    lines = fs.readFileSync(path.join(config.root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim())
  } catch {}
  const ok = [posix, `${posix}/`, `/${posix}`, `/${posix}/`]
  if (!lines.some((l) => ok.includes(l))) log.info(`提示：建议把 ${posix}/ 加入 .gitignore，扫描结果不需要提交`)
}

function parsePages(positionals) {
  checkPages(positionals)
  return positionals
}

function parseRuns(value) {
  if (value == null) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new ConfigError('配置错误：--runs 必须是 ≥ 1 的整数')
  return n
}

async function docsContext(outDir, meta, pages) {
  const entry = historyEntryFromRound(meta, pages)
  const entries = await readHistory(outDir)
  return { entry, ctx: { baseline: comparableBaseline(entries, entry), trend: trend(entries, entry) } }
}

async function writeOutputs(roundDir, config, meta, log, { dryRun }) {
  // 重新分析同一轮时，先读出上一次的结果：本次没拿到 AI 建议的问题沿用之前的建议。
  const previous = await readAnalysis(roundDir).catch(() => null)
  let analysis = await analyzeRound(roundDir, config)
  analysis = await enrichWithAi(analysis, config, { dryRun, warn: log.warn, info: log.info })
  analysis = carryForwardAi(analysis, previous)
  if (dryRun && config.ai.enabled) {
    const planned = analysis.aiPlanned ?? []
    const chars = planned.reduce((n, s) => n + s.chars, 0)
    log.info(`AI 试运行：本会发送 ${planned.length} 个源文件片段，共 ${chars} 个字符（未发送）`)
    for (const s of planned) log.info(`  ${s.file}  ${s.chars} 字符（问题 ${s.finding}）`)
  }
  return renderOutputs(roundDir, analysis, config, meta)
}

async function renderOutputs(roundDir, analysis, config, meta) {
  await writeAnalysis(roundDir, analysis)
  const { entry, ctx } = await docsContext(config.outDir, meta, analysis.pages)
  const docs = await writeDocs(roundDir, analysis, config, ctx)
  const index = writeIndex(roundDir, analysis, config.docs.audiences)
  return { analysis, entry, docs, index }
}

async function runOrScan(command, values, positionals, ctx) {
  const { configDir } = ctx
  const config = await loadConfig(configDir, { url: values.url, runs: parseRuns(values.runs) })
  const requested = parsePages(positionals)
  const pages = requested.length ? requested : config.pages
  // 先找 Chrome：找不到就是一条配置错误，不用等构建和起服务。
  const chromePath = findChrome(config)
  gitignoreHint(config, ctx.log)
  const round = await createRound(config.outDir, {
    name: values.name ?? null,
    partial: requested.length > 0,
    pagesRequested: pages,
    meta: { git: gitInfo(config.root), visit: config.visit, formFactor: config.formFactor, runs: config.runs },
  })
  let meta = round.meta
  const logDir = path.join(round.dir, 'logs')
  // 这一轮命令行上的输出同时记进 logs/scan.log
  const log = withFile(ctx.log, path.join(logDir, 'scan.log'))
  log.info(`轮次：${round.dir}`)
  const ac = new AbortController()
  const offStop = onStop(ac, log)
  let target
  try {
    if (command === 'run') await runBuild(config, { log, logDir, signal: ac.signal })
    meta = { ...meta, buildFingerprint: buildFingerprint(config) }
    if (ac.signal.aborted) throw new BuildError('已中断', null)
    target = await startTarget(config, { log, logDir, signal: ac.signal })
    const scanned = await scanRound({ config, origin: target.origin, roundDir: round.dir, meta, pages, log, signal: ac.signal, chromePath })
    meta = scanned.meta
  } catch (error) {
    meta = { ...meta, status: 'aborted', finishedAt: new Date().toISOString() }
    await writeRoundMeta(round.dir, meta)
    if (ac.signal.aborted) {
      log.info('本轮已中断，结果未完成')
      return 1
    }
    log.fileOnly(`错误：${error?.message ?? error}`)
    throw error
  } finally {
    await target?.stop()
    offStop()
  }
  if (meta.status === 'aborted') {
    log.info('本轮已中断，结果未完成')
    return 1
  }
  const out = await writeOutputs(round.dir, config, meta, log, { dryRun: values['ai-dry-run'] === true })
  await appendHistory(config.outDir, out.entry)
  if (meta.status === 'complete') {
    const removed = await pruneRounds(config.outDir, config.keep, meta)
    if (removed.length) log.info(`已清理 ${removed.length} 个旧轮次`)
  }
  for (const f of out.docs.filter((d) => d.endsWith('.md'))) log.info(`文档：${f}`)
  log.info(`总览：${out.index}`)
  const stale = await staleRoundsHint(config.outDir, meta.id)
  if (stale) log.info(stale)
  if (command === 'run') openInBrowser(out.index, ctx.env)
  if (meta.status === 'failed-pages') {
    const allFailed = out.analysis.pages.every((p) => !p.ok)
    log.warn(`${meta.failedPages.length} 个页面扫描失败：${meta.failedPages.join('、')}`)
    return allFailed ? 1 : 4
  }
  return 0
}

/**
 * @param {string[]} argv
 * @param {{cwd?: string, env?: Record<string, string|undefined>, log?: ReturnType<typeof createLogger>}} [ctx]
 * @returns {Promise<number>} 退出码
 */
export async function runCli(argv, { cwd = process.cwd(), env = process.env, log = createLogger() } = {}) {
  const [command, ...rest] = argv
  const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true })
  if (command in ALLOWED) {
    const extra = Object.keys(values).filter((k) => !ALLOWED[command].includes(k))
    if (extra.length) throw new ConfigError(`配置错误：${command} 不支持参数 ${extra.map((k) => `--${k}`).join('、')}`)
  }

  // 确定配置目录：优先用 --config，否则用 cwd
  const configDir = values.config ? path.resolve(cwd, values.config) : cwd

  const ctx = { cwd, env, log }
  switch (command) {
    case 'init': {
      const root = path.resolve(configDir)
      const file = writeConfigTemplate(root, { force: values.force === true })
      log.info(`已生成 ${file}，按项目情况修改后运行 npx lhkit run`)
      const hint = installHint(root)
      if (hint) log.info(`建议把 lhkit 加进项目依赖（锁定版本，也让配置文件有类型提示）：${hint}`)
      return 0
    }
    case 'build': {
      const config = await loadConfig(configDir)
      if (!config.build) {
        log.info('配置里没有 build 命令（或 serve 为网址模式），无需构建')
        return 0
      }
      const logDir = path.join(config.outDir, 'logs')
      fs.mkdirSync(logDir, { recursive: true })
      const ac = new AbortController()
      const offStop = onStop(ac, log)
      try {
        await runBuild(config, { log, logDir, signal: ac.signal })
      } catch (error) {
        if (ac.signal.aborted) {
          log.info('构建已中断')
          return 1
        }
        throw error
      } finally {
        offStop()
      }
      log.info('构建完成')
      return 0
    }
    case 'run':
    case 'scan':
      return runOrScan(command, values, positionals, { ...ctx, configDir })
    case 'analyze': {
      const config = await loadConfig(configDir)
      const dir = await resolveRound(config.outDir, positionals[0])
      const meta = await readRoundMeta(dir)
      const out = await writeOutputs(dir, config, meta, log, { dryRun: values['ai-dry-run'] === true })
      for (const f of out.docs.filter((d) => d.endsWith('.md'))) log.info(`文档：${f}`)
      log.info(`总览：${out.index}`)
      return 0
    }
    case 'preview': {
      const config = await loadConfig(configDir)
      const index = path.join(await resolveRound(config.outDir, positionals[0]), 'index.html')
      if (!fs.existsSync(index)) throw new ConfigError(`配置错误：${index} 不存在，请先运行 lhkit analyze`)
      log.info(`总览：${index}`)
      openInBrowser(index, env)
      return 0
    }
    case 'ai-export': {
      if (positionals.length > 1) throw new ConfigError('配置错误：用法 lhkit ai-export [轮次]')
      const config = await loadConfig(configDir)
      const dir = await resolveRound(config.outDir, positionals[0])
      const analysis = await readAiJson(path.join(dir, 'analysis.json'))
      const { file, request } = await exportAiRequest(dir, analysis, config)
      log.info(`AI 任务：${file}（${request.tasks.length} 条，未调用模型 API）`)
      if (!request.tasks.length) log.warn('没有能关联到允许源码的问题，请检查 source map、ai.sourceRoot 和排除规则')
      return 0
    }
    case 'ai-import': {
      if (positionals.length < 1 || positionals.length > 2) throw new ConfigError('配置错误：用法 lhkit ai-import <回答文件> [轮次]')
      const config = await loadConfig(configDir)
      const dir = await resolveRound(config.outDir, positionals[1])
      const out = await withImportLock(dir, async () => {
        const previous = await readAiJson(path.join(dir, 'analysis.json'))
        const reply = await readAiJson(path.resolve(cwd, positionals[0]))
        const analysis = await importAiReply(dir, previous, config, reply)
        const meta = await readRoundMeta(dir)
        return stageImportOutputs(dir, config, (stage) => renderOutputs(stage, analysis, config, meta))
      })
      for (const f of out.docs.filter((d) => d.endsWith('.md'))) log.info(`文档：${f}`)
      log.info(`总览：${out.index}`)
      return 0
    }
    case 'compare': {
      if (positionals.length !== 2) throw new ConfigError('配置错误：用法 lhkit compare <A> <B>')
      const config = await loadConfig(configDir)
      const result = await compareRounds(config.outDir, positionals[0], positionals[1])
      log.info(`对比：${result.mdPath}`)
      openInBrowser(result.htmlPath, env)
      return 0
    }
    default:
      throw new ConfigError(`配置错误：未知命令 ${command}`)
  }
}
