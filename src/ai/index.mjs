// 可选模型分析：共用任务、严格校验、有限并发与内容缓存。
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { prepareTasks, sourceList } from './prompt.mjs'
import { createClient, isFatal, requestFor, resolveAiSettings } from './providers.mjs'
import { parseReply, validateAdvice } from './reply.mjs'
export { collectSources } from './sources.mjs'

const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')
const describe = (e) => `${e?.status ? `${e.status} ` : ''}${e?.message ?? e}`

async function readCache(file, sources) {
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'))
    if (cached.version === 1) return validateAdvice(cached.ai, sources, cached.ai.model)
  } catch {}
  return null
}

async function writeCache(file, ai) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify({ version: 1, ai }))
    await fs.rename(tmp, file)
  } catch {
    // 缓存是优化，磁盘无法缓存时仍返回本次已验证的建议。
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}) }
}

/** 重新分析未得到新建议时，保留旧建议并明确标记本次没有重新核验。 */
export function carryForwardAi(next, previous) {
  if (!previous?.findings) return next
  const before = new Map(previous.findings.filter((f) => f.ai).map((f) => [f.id, f.ai]))
  const carried = new Set()
  const findings = next.findings.map((f) => {
    if (f.ai || !before.has(f.id)) return f
    carried.add(f.id)
    return { ...f, ai: { ...before.get(f.id), carried: true } }
  })
  if (!carried.size) return next
  const sent = (previous.aiSent ?? []).filter((s) => carried.has(s.finding))
  return { ...next, findings, aiSent: [...(next.aiSent ?? []), ...sent] }
}

/**
 * @param {import('../types.mjs').Analysis} analysis
 * @param {import('../types.mjs').Config} config
 * @param {{dryRun?:boolean, client?:{create:(params:object)=>Promise<any>}, fetch?:typeof globalThis.fetch, warn?:(m:string)=>void, info?:(m:string)=>void}} [opts]
 */
export async function enrichWithAi(analysis, config, { dryRun = false, client, fetch, warn = () => {}, info = () => {} } = {}) {
  const out = structuredClone(analysis)
  out.aiSent = []
  delete out.aiPlanned
  if (!config.ai.enabled) return out
  const { system, tasks } = await prepareTasks(out, config)
  if (dryRun) {
    out.aiPlanned = tasks.flatMap(sourceList)
    return out
  }
  if (!tasks.length) return out
  const ai = resolveAiSettings(config.ai)
  const apiKey = process.env[ai.apiKeyEnv]
  let apiPromise = client ? Promise.resolve(client) : null
  let cursor = 0
  let stopped = false
  let fatal = null
  const sent = []
  const failures = []
  const stop = (message) => {
    stopped = true
    fatal ??= message
  }
  async function worker() {
    while (!stopped && cursor < tasks.length) {
      const i = cursor++
      const task = tasks[i]
      const params = requestFor(task, system, ai)
      const key = hash({ version: 1, provider: ai.provider, baseURL: ai.baseURL, params, sources: task.sources.map((s) => [s.file, s.hash]) })
      const cacheFile = path.join(config.outDir, 'ai-cache', `${key}.json`)
      if (ai.cache) {
        const cached = await readCache(cacheFile, task.sources)
        if (cached) {
          task.finding.ai = cached
          info(`AI 缓存 ${i + 1}/${tasks.length}：${task.finding.title}`)
          continue
        }
      }
      if (stopped) break
      if (!client && !apiKey) {
        stop(`环境变量 ${ai.apiKeyEnv} 里没有 Key`)
        break
      }
      if (!apiPromise) apiPromise = createClient(ai, apiKey, { fetch })
      let api
      try { api = await apiPromise } catch (error) {
        stop(`无法创建 ${ai.provider} 客户端：${describe(error)}`)
        break
      }
      if (stopped) break
      info(`AI 分析 ${i + 1}/${tasks.length}：${task.finding.title}`)
      let response
      try {
        response = await api.create(params)
        sent[i] = sourceList(task)
      } catch (error) {
        if (error?.status != null || error?.sent) sent[i] = sourceList(task)
        if (isFatal(error)) stop(describe(error))
        else failures.push(`${task.finding.id}：${describe(error)}`)
        continue
      }
      try {
        task.finding.ai = parseReply(response, ai, task.sources)
        if (ai.cache) await writeCache(cacheFile, task.finding.ai)
      } catch (error) { failures.push(`${task.finding.id}：${describe(error)}`) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ai.concurrency, tasks.length) }, worker))
  out.aiSent = sent.flat()
  if (fatal) warn(`AI 分析遇到 ${fatal}，已停止后续请求，未完成的问题使用规则建议`)
  else if (failures.length) warn(`AI 分析有 ${failures.length} 条失败，已改用规则建议（${failures[0]}）`)
  return out
}
