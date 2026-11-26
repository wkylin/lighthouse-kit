// 让任意具备文件/终端能力的助手分析同一批任务，并在完整校验后回写。
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ConfigError } from '../config.mjs'
import { prepareTasks, sourceList } from './prompt.mjs'
import { REPLY_SCHEMA, validateAdvice } from './reply.mjs'

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message) => { throw new ConfigError(`配置错误：${message}`) }

export async function readAiJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch {
    fail(`无法读取有效 JSON：${file}，请检查文件是否已生成`)
  }
}

async function buildRequest(analysis, config) {
  const prepared = await prepareTasks(analysis, config)
  const { aiSent: _sent, aiPlanned: _planned, findings, ...rest } = analysis
  const analysisHash = digest({ ...rest, findings: findings.map(({ ai: _ai, ...finding }) => finding) })
  const payload = {
    version: 1, roundId: analysis.round.id, analysisHash, system: prepared.system, adviceSchema: REPLY_SCHEMA,
    tasks: prepared.tasks.map((task) => ({ id: task.finding.id, title: task.finding.title, prompt: task.prompt,
      sources: task.sources.map((s) => ({ file: s.file, chars: s.text.length, hash: s.hash })) })),
  }
  return { request: { ...payload, requestId: digest(payload) }, prepared }
}

export async function exportAiRequest(roundDir, analysis, config) {
  const { request } = await buildRequest(analysis, config)
  const file = path.join(roundDir, 'ai', 'request.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(request, null, 2)}\n`)
  return { file, request }
}

/** 仅返回已完整校验的新数据；校验失败不写入任何文件。 */
export async function importAiReply(roundDir, analysis, config, reply) {
  if (reply?.version !== 1 || !Array.isArray(reply?.findings) || !reply.findings.length || typeof reply.model !== 'string' || !reply.model.trim())
    fail('AI 回答需要 version: 1、model 和非空 findings 数组')
  const saved = await readAiJson(path.join(roundDir, 'ai', 'request.json'))
  if (saved.version !== 1 || reply.roundId !== analysis.round.id || reply.roundId !== saved.roundId || reply.requestId !== saved.requestId)
    fail('回答的轮次或 requestId 与导出请求不匹配')
  const { request, prepared } = await buildRequest(analysis, config)
  if (saved.requestId !== request.requestId) fail('扫描分析、配置或源码已经变化，请重新执行 lhkit ai-export 导出任务')
  const tasks = new Map(prepared.tasks.map((task) => [task.finding.id, task]))
  const updates = new Map()
  for (const item of reply.findings) {
    if (!item || typeof item.id !== 'string' || !tasks.has(item.id) || updates.has(item.id)) fail('AI 回答包含未知或重复的审计项 ID')
    try { updates.set(item.id, validateAdvice(item, tasks.get(item.id).sources, reply.model)) } catch (error) {
      fail(`审计项 ${item.id} 的建议无效：${error.message}`)
    }
  }
  const out = structuredClone(analysis)
  delete out.aiPlanned
  for (const finding of out.findings) if (updates.has(finding.id)) finding.ai = updates.get(finding.id)
  out.aiSent = [
    ...(out.aiSent ?? []).filter((s) => !updates.has(s.finding)),
    ...prepared.tasks.filter((task) => updates.has(task.finding.id)).flatMap(sourceList),
  ]
  return out
}
