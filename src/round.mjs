// 轮次目录：<outDir>/runs/<id>，元数据 round.json；清理旧轮次。
import fs from 'node:fs/promises'
import path from 'node:path'
import { ConfigError } from './config.mjs'
import { pageSlug } from './slug.mjs'

export { pageSlug }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const pad = (n) => String(n).padStart(2, '0')
const runsDir = (outDir) => path.join(outDir, 'runs')

function timestampId(now) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 新建轮次目录并写入 round.json。
 * @param {string} outDir
 * @param {{name: string|null, partial: boolean, pagesRequested: string[], meta?: Partial<import('./types.mjs').RoundMeta>}} opts
 * @param {Date} now
 * @returns {Promise<{dir: string, meta: import('./types.mjs').RoundMeta}>}
 */
export async function createRound(outDir, { name, partial, pagesRequested, meta = {} }, now = new Date()) {
  await fs.mkdir(runsDir(outDir), { recursive: true })
  let id
  if (name != null) {
    if (!NAME_RE.test(name)) throw new ConfigError(`配置错误：轮次名称只能包含字母、数字、点、下划线和连字符，且不能以点开头：${JSON.stringify(name)}`)
    const existing = path.join(runsDir(outDir), name)
    if (await exists(existing)) {
      let status = null
      try {
        status = (await readRoundMeta(existing)).status
      } catch {}
      if (status === 'running') throw new ConfigError(`配置错误：名为 ${name} 的轮次正在运行（或上次异常退出）：确认没有在跑之后删除 ${existing} 再试`)
      if (status !== 'aborted') throw new ConfigError(`配置错误：已有名为 ${name} 的轮次，请换一个名称或先删除它`)
      // 上次中断的同名轮次没有完整结果：清掉重来。
      await fs.rm(existing, { recursive: true, force: true })
    }
    id = name
  } else {
    const base = timestampId(now)
    id = base
    for (let n = 2; await exists(path.join(runsDir(outDir), id)); n++) id = `${base}-${n}`
  }
  const dir = path.join(runsDir(outDir), id)
  await fs.mkdir(dir, { recursive: true })
  /** @type {import('./types.mjs').RoundMeta} */
  const full = {
    id,
    name: name ?? null,
    partial,
    pagesRequested: [...pagesRequested],
    origin: '',
    startedAt: now.toISOString(),
    finishedAt: null,
    status: 'running',
    failedPages: [],
    lighthouseVersion: '',
    visit: 'first',
    formFactor: 'mobile',
    runs: 1,
    git: null,
    buildFingerprint: null,
    ...meta,
  }
  await writeRoundMeta(dir, full)
  return { dir, meta: full }
}

export async function writeRoundMeta(dir, meta) {
  await fs.writeFile(path.join(dir, 'round.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

/** @returns {Promise<import('./types.mjs').RoundMeta>} */
export async function readRoundMeta(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, 'round.json'), 'utf8'))
}

/** 所有轮次，按开始时间升序。没有 round.json 的目录忽略。 */
export async function listRounds(outDir) {
  let names
  try {
    names = await fs.readdir(runsDir(outDir))
  } catch {
    return []
  }
  const rounds = []
  for (const n of names) {
    const dir = path.join(runsDir(outDir), n)
    try {
      rounds.push({ dir, meta: await readRoundMeta(dir) })
    } catch {
      // 不是轮次目录
    }
  }
  return rounds.sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt) || a.meta.id.localeCompare(b.meta.id))
}

/**
 * 轮次名称或目录 → 目录。缺省为最近一轮已结束（完整或部分页面失败）的轮次。
 * @returns {Promise<string>}
 */
export async function resolveRound(outDir, nameOrDir) {
  if (nameOrDir == null) {
    const done = (await listRounds(outDir)).filter((r) => r.meta.finishedAt && (r.meta.status === 'complete' || r.meta.status === 'failed-pages'))
    if (!done.length) throw new ConfigError(`配置错误：${runsDir(outDir)} 里还没有已完成的轮次`)
    return done.at(-1).dir
  }
  for (const candidate of [path.resolve(nameOrDir), path.join(runsDir(outDir), nameOrDir)]) {
    if (await exists(path.join(candidate, 'round.json'))) return candidate
  }
  throw new ConfigError(`配置错误：找不到轮次 ${nameOrDir}`)
}

/**
 * 清理旧轮次：只删未命名、非部分、状态为 complete 的轮次，且只在当前轮次也是这样一轮（未命名、非部分、complete）时进行——
 * 命名轮次和只扫部分页面的轮次不替代全站轮次；扫的目标地址不同（本地与测试环境）的轮次互不清理。
 * @param {string} outDir
 * @param {'latest'|number} keep
 * @param {import('./types.mjs').RoundMeta} current
 * @returns {Promise<string[]>} 删除的目录
 */
export async function pruneRounds(outDir, keep, current) {
  if (current.status !== 'complete' || current.name != null || current.partial) return []
  const keepOthers = keep === 'latest' ? 0 : keep - 1
  const candidates = (await listRounds(outDir)).filter(
    (r) => r.meta.id !== current.id && r.meta.name == null && !r.meta.partial && r.meta.status === 'complete' && r.meta.origin === current.origin,
  )
  const remove = candidates.slice(0, Math.max(0, candidates.length - keepOthers))
  for (const r of remove) await fs.rm(r.dir, { recursive: true, force: true })
  return remove.map((r) => r.dir)
}

/**
 * 中断或没有正常结束的其他轮次（这些轮次不会被自动清理）。没有时为 null。
 * @param {string} outDir
 * @param {string} currentId 本轮，不算在内
 * @returns {Promise<string|null>}
 */
export async function staleRoundsHint(outDir, currentId) {
  const stale = (await listRounds(outDir)).filter((r) => r.meta.id !== currentId && (r.meta.status === 'aborted' || r.meta.status === 'running'))
  if (!stale.length) return null
  const list = stale.map((r) => `${r.meta.id}（${r.meta.status === 'aborted' ? '已中断' : '未结束'}）`).join('、')
  return `${runsDir(outDir)} 里有 ${stale.length} 个没有完整结果的轮次：${list}。这些轮次不会自动清理；“未结束”的如果不是正在别处运行，就是上次异常退出。确认不需要后可以删除对应目录。`
}
