// 可选的 AI 分析：对排名靠前、能对到源码的问题，把证据和源码片段发给 Claude，取回原因与改法。
// 只在 ai.enabled 且对应环境变量里有 Key 时运行；任何失败都退回规则建议，不影响文档生成。
import fs from 'node:fs/promises'
import path from 'node:path'

const MAX_FILE_CHARS = 8000
const MAX_FINDING_CHARS = 24000
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
/** 支持服务端拒答回退（fallbacks: 'default'）的模型。 */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string', description: '这个项目里造成该问题的具体原因' },
    fix: { type: 'string', description: '具体改法：文件、代码位置与修改方式' },
  },
  required: ['cause', 'fix'],
  additionalProperties: false,
}

const SYSTEM = [
  '你是资深的前端性能工程师。下面给出 Lighthouse 在一个网站上发现的一个问题、它的证据和相关源码。',
  '请判断这个项目里造成该问题的具体原因，并给出可以直接动手的改法：指明文件和代码位置，必要时写出修改后的关键代码。',
  '只根据给出的证据和源码下结论；证据不足以确定时，写明还需要确认什么。用简体中文回答。',
].join('\n')

const toPosix = (p) => p.split(path.sep).join('/')

const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.jks', '.keystore', '.kdbx'])
const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.htpasswd', 'credentials', 'credentials.json'])
/** 不靠通配符、按路径本身判断的敏感文件：任何一层叫 .env*、密钥证书扩展名（含以点开头的文件）、SSH 私钥、包管理器凭据。 */
function isSecretPath(rel) {
  const parts = rel.split('/')
  const base = parts.at(-1)
  return (
    parts.some((p) => p.startsWith('.env')) ||
    SECRET_EXT.has(path.extname(base).toLowerCase()) ||
    SECRET_EXT.has(`.${base.split('.').at(-1).toLowerCase()}`) ||
    SECRET_NAMES.has(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(base)
  )
}

/** 配置里能看出来的构建产物目录：source map 目录、manifest 所在的构建输出、静态托管目录。 */
function outputDirs(config) {
  const dirs = []
  if (config.sourceMap.maps) dirs.push(config.sourceMap.maps)
  if (config.sourceMap.manifest) {
    const d = path.dirname(config.sourceMap.manifest)
    dirs.push(path.basename(d) === '.vite' ? path.dirname(d) : d)
  }
  if (config.serve.mode === 'static' && config.serve.static) dirs.push(config.serve.static)
  return dirs.map((d) => path.resolve(d))
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

/**
 * 问题证据对应、位于 ai.sourceRoot 之下且不在排除名单里的源文件片段。
 * @param {import('../types.mjs').MergedFinding} finding
 * @param {import('../types.mjs').Config} config
 * @returns {Promise<{file: string, text: string}[]>}
 */
export async function collectSources(finding, config) {
  const sourceRoot = path.resolve(config.ai.sourceRoot)
  let realRoot = sourceRoot
  try {
    realRoot = await fs.realpath(sourceRoot)
  } catch {}
  const outputs = outputDirs(config)
  const seen = new Set()
  const out = []
  let used = 0
  for (const e of finding.evidence) {
    const file = e.source?.file
    if (!file || file.includes('(node_modules)') || seen.has(file)) continue
    seen.add(file)
    const abs = path.resolve(config.root, file)
    if (!inside(abs, sourceRoot)) continue
    const rel = toPosix(path.relative(config.root, abs))
    if (isSecretPath(rel) || outputs.some((d) => inside(abs, d))) continue
    if (config.ai.exclude.some((p) => path.matchesGlob(rel, p) || path.matchesGlob(abs, p))) continue
    let text
    try {
      // 符号链接指到源码目录外（或指到被排除的文件）时不跟过去。
      const real = await fs.realpath(abs)
      if (!inside(real, realRoot) || isSecretPath(toPosix(path.relative(realRoot, real)))) continue
      if (!(await fs.stat(real)).isFile()) continue
      text = await fs.readFile(real, 'utf8')
    } catch {
      continue
    }
    const room = Math.min(MAX_FILE_CHARS, MAX_FINDING_CHARS - used)
    if (room <= 0) break
    text = text.slice(0, room)
    used += text.length
    out.push({ file: rel, text })
  }
  return out
}

function promptFor(finding, sources, origin) {
  const s = finding.savings
  const savings = [
    s.lcp && `LCP 约 ${Math.round(s.lcp)} ms`,
    s.tbt && `TBT 约 ${Math.round(s.tbt)} ms`,
    s.fcp && `FCP 约 ${Math.round(s.fcp)} ms`,
    s.cls && `CLS 约 ${s.cls.toFixed(3)}`,
    s.bytes && `可省 ${(s.bytes / 1024).toFixed(1)} KB`,
  ].filter(Boolean)
  const evidence = finding.evidence.map((e) => {
    const what = e.url ?? e.selector ?? e.label ?? ''
    const parts = [what, e.label && e.label !== what ? e.label : null, e.ms != null ? `${e.ms} ms` : null, e.bytes != null ? `${(e.bytes / 1024).toFixed(1)} KB` : null, e.source ? `源文件 ${e.source.file}` : null]
    return `- ${parts.filter(Boolean).join(' · ')}`
  })
  const code = sources.map((src) => `### ${src.file}\n\`\`\`\n${src.text}\n\`\`\``)
  return [
    `目标站点：${origin}`,
    `问题：${finding.title}（Lighthouse 审计项 ${finding.id}，类别 ${finding.category}）`,
    `涉及页面：${finding.pages.join('、')}`,
    savings.length ? `估算收益：${savings.join('，')}` : null,
    '证据：',
    ...evidence,
    `规则库建议：${finding.advice}`,
    '',
    '相关源码：',
    ...code,
  ]
    .filter((line) => line !== null)
    .join('\n')
}

function requestFor(finding, sources, config, origin) {
  const params = {
    model: config.ai.model,
    max_tokens: 16000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: REPLY_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: promptFor(finding, sources, origin) }],
  }
  if (FALLBACK_MODELS.has(config.ai.model)) Object.assign(params, { betas: [FALLBACK_BETA], fallbacks: 'default' })
  return params
}

function parseReply(res, config) {
  if (res?.stop_reason === 'refusal') throw new Error('模型拒绝回答')
  if (res?.stop_reason === 'max_tokens') throw new Error('回答被截断')
  const text = (res?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    throw new Error('返回的内容不是 JSON')
  }
  if (typeof obj?.cause !== 'string' || typeof obj?.fix !== 'string' || !obj.cause.trim() || !obj.fix.trim()) throw new Error('返回缺少 cause 或 fix')
  return { cause: obj.cause.trim(), fix: obj.fix.trim(), model: res.model ?? config.ai.model }
}

async function createClient(apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  // 每次调用最多等 2 分钟、只重试 1 次：网络不通时不会卡住几个小时。
  const anthropic = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 })
  return { create: (params) => anthropic.beta.messages.create(params) }
}

const describe = (error) => (error?.status ? `${error.status} ${error.message}` : String(error?.message ?? error))
/** Key 无效、没有权限、连不上：后面的调用也会一样失败，直接停。 */
const isFatal = (error) => error?.status === 401 || error?.status === 403 || error?.name === 'APIConnectionError' || error?.name === 'APIConnectionTimeoutError'

/**
 * 重新分析时保留之前拿到的 AI 建议：本次没有 AI 建议的问题，沿用上一次同一审计项的建议和发送记录。
 * @param {import('../types.mjs').Analysis} next
 * @param {import('../types.mjs').Analysis|null} previous
 * @returns {import('../types.mjs').Analysis}
 */
export function carryForwardAi(next, previous) {
  if (!previous?.findings) return next
  const before = new Map(previous.findings.filter((f) => f.ai).map((f) => [f.id, f.ai]))
  const carried = []
  const findings = next.findings.map((f) => {
    if (f.ai || !before.has(f.id)) return f
    carried.push(f.id)
    return { ...f, ai: before.get(f.id) }
  })
  if (!carried.length) return next
  const sent = (previous.aiSent ?? []).filter((s) => carried.includes(s.finding))
  return { ...next, findings, aiSent: [...next.aiSent, ...sent] }
}

/**
 * @param {import('../types.mjs').Analysis} analysis
 * @param {import('../types.mjs').Config} config
 * @param {{dryRun?: boolean, client?: {create: (params: object) => Promise<any>}, warn?: (msg: string) => void}} [opts]
 * @returns {Promise<import('../types.mjs').Analysis>}
 */
export async function enrichWithAi(analysis, config, { dryRun = false, client, warn = () => {}, info = () => {} } = {}) {
  const out = structuredClone(analysis)
  out.aiSent = []
  delete out.aiPlanned
  if (!config.ai.enabled) return out
  const apiKey = process.env[config.ai.apiKeyEnv]
  if (!dryRun && !client && !apiKey) {
    warn(`已打开 AI 分析，但环境变量 ${config.ai.apiKeyEnv} 里没有 Key：本轮使用规则建议`)
    return out
  }
  const picked = []
  for (const finding of out.findings) {
    if (picked.length >= config.ai.maxFindings) break
    const sources = await collectSources(finding, config)
    if (sources.length) picked.push({ finding, sources })
  }
  const listOf = ({ finding, sources }) => sources.map((s) => ({ finding: finding.id, file: s.file, chars: s.text.length }))
  if (dryRun) {
    // 试运行：只列出本会发送的内容；aiSent 只记录真正发出去的。
    out.aiPlanned = picked.flatMap(listOf)
    return out
  }
  if (!picked.length) return out
  let api = client
  if (!api) {
    try {
      api = await createClient(apiKey)
    } catch (error) {
      warn(`无法加载 Anthropic SDK（${describe(error)}）：本轮使用规则建议`)
      out.aiSent = []
      return out
    }
  }
  const failures = []
  for (const [i, item] of picked.entries()) {
    const { finding, sources } = item
    info(`AI 分析 ${i + 1}/${picked.length}：${finding.title}`)
    let response
    try {
      response = await api.create(requestFor(finding, sources, config, out.round.origin))
    } catch (error) {
      // 有状态码说明请求到了服务端，内容已发送；连接错误则没有发出去。
      if (error?.status != null) out.aiSent.push(...listOf(item))
      if (isFatal(error)) {
        const rest = picked.length - i - 1
        warn(`AI 分析遇到 ${describe(error)}，已停止${rest ? `其余 ${rest} 条` : ''}，改用规则建议`)
        return out
      }
      failures.push(`${finding.id}：${describe(error)}`)
      continue
    }
    out.aiSent.push(...listOf(item))
    try {
      finding.ai = parseReply(response, config)
    } catch (error) {
      failures.push(`${finding.id}：${describe(error)}`)
    }
  }
  if (failures.length) warn(`AI 分析有 ${failures.length} 条失败，已改用规则建议（${failures[0]}）`)
  return out
}
