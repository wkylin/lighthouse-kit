// 读取并规范化项目配置（lhkit.config.mjs / lhkit.config.js）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { slugKey } from './slug.mjs'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const CONFIG_FILES = ['lhkit.config.mjs', 'lhkit.config.js']
export const DEFAULT_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing']
export const BUILTIN_EXCLUDE = [
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/node_modules/**',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
]

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isPort = (v) => Number.isInteger(v) && v > 0 && v < 65536
const isPositiveInt = (v) => Number.isInteger(v) && v > 0
const fail = (message) => {
  throw new ConfigError(`配置错误：${message}`)
}

const AI_DEFAULTS = {
  anthropic: { model: 'claude-opus-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY', baseURL: null },
  openai: { model: 'gpt-4.1-mini', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1' },
  deepseek: { model: 'deepseek-flash', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
  'openai-compatible': { model: null, apiKeyEnv: 'OPENAI_API_KEY', baseURL: null },
}

/** 页面路径必须以 / 开头，且不能有两页落到同一个结果目录。 */
export function checkPages(pages) {
  const seen = new Map()
  for (const p of pages) {
    if (typeof p !== 'string' || !p.startsWith('/')) fail(`页面路径必须以 / 开头：${JSON.stringify(p)}`)
    const key = slugKey(p)
    if (seen.has(key)) fail(`页面 ${seen.get(key)} 和 ${p} 会写到同一个结果目录，请只保留一个`)
    seen.set(key, p)
  }
}

function parseUrl(url, label = 'serve.url') {
  let u
  try {
    u = new URL(url)
  } catch {
    fail(`${label} 必须是有效的 HTTP/HTTPS 网址：${url}`)
  }
  if (!['http:', 'https:'].includes(u.protocol)) fail(`${label} 必须是 HTTP/HTTPS 网址：${url}`)
  return u
}

function portOf(url, label = 'serve.url') {
  const u = parseUrl(url, label)
  if (u.port) return Number(u.port)
  return u.protocol === 'https:' ? 443 : 80
}

/**
 * 把原始配置规范化为 Config。纯函数：不读文件系统。
 * @param {object} raw
 * @param {string} root 项目根目录（绝对路径）
 * @param {string|null} configFile 配置文件路径；直接扫描 URL 时为 null
 * @param {{url?: string, runs?: number, maxPages?: number, maxDepth?: number}} [overrides]
 * @returns {import('./types.mjs').Config}
 */
export function normalizeConfig(raw, root, configFile, overrides = {}) {
  if (!isObject(raw)) fail('配置文件必须 export default 一个对象')
  const abs = (p) => (p == null ? null : path.resolve(root, p))

  // 页面
  const autoPages = raw.pages === undefined
  let pages = autoPages ? ['/'] : raw.pages
  if (!Array.isArray(pages) || pages.length === 0) fail('pages 必须是非空数组，例如 ["/", "/about"]')
  checkPages(pages)
  if (raw.crawl != null && !isObject(raw.crawl)) fail('crawl 必须是配置对象')
  const crawlRaw = raw.crawl ?? {}
  const crawl = {
    enabled: autoPages,
    maxPages: overrides.maxPages ?? crawlRaw.maxPages ?? 50,
    maxDepth: overrides.maxDepth ?? crawlRaw.maxDepth ?? 3,
    timeoutMs: crawlRaw.timeoutMs ?? 15000,
  }
  if (!Number.isSafeInteger(crawl.maxPages) || crawl.maxPages < 1) fail('crawl.maxPages 必须是 ≥ 1 的整数')
  if (!Number.isSafeInteger(crawl.maxDepth) || crawl.maxDepth < 0) fail('crawl.maxDepth 必须是 ≥ 0 的整数')
  if (!Number.isSafeInteger(crawl.timeoutMs) || crawl.timeoutMs < 1 || crawl.timeoutMs > 2147483647) fail('crawl.timeoutMs 必须是 1–2147483647 的整数')
  if (raw.outDir != null && typeof raw.outDir !== 'string') fail('outDir 必须是字符串')
  if (raw.chromePath != null && typeof raw.chromePath !== 'string') fail('chromePath 必须是字符串（Chrome 可执行文件的路径）')
  if (raw.categories != null) {
    if (!Array.isArray(raw.categories) || raw.categories.some((c) => !DEFAULT_CATEGORIES.includes(c)))
      fail(`categories 只能取 ${DEFAULT_CATEGORIES.join('、')}`)
  }

  // 服务
  const rs = isObject(raw.serve) ? raw.serve : {}
  const timeoutMs = rs.timeoutMs ?? 60000
  if (!isPositiveInt(timeoutMs)) fail('serve.timeoutMs 必须是正整数（毫秒）')
  const readyPath = rs.readyPath ?? '/'
  if (typeof readyPath !== 'string' || !readyPath.startsWith('/')) fail('serve.readyPath 必须以 / 开头')
  /** @type {import('./types.mjs').ServeConfig} */
  let serve
  if (overrides.url != null) {
    serve = { mode: 'url', url: overrides.url, port: portOf(overrides.url, '--url'), readyPath, proxy: {}, timeoutMs }
  } else if (rs.command && rs.static) {
    fail('serve.command 与 serve.static 只能二选一')
  } else if (rs.command) {
    if (typeof rs.command !== 'string') fail('serve.command 必须是字符串')
    if (!rs.url) fail('serve.command 需要同时给出 serve.url（服务就绪后访问的地址）')
    serve = { mode: 'command', command: rs.command, url: rs.url, port: portOf(rs.url), readyPath, proxy: {}, timeoutMs }
  } else if (rs.static) {
    const port = rs.port ?? 4173
    if (!isPort(port)) fail('serve.port 必须是 1–65535 之间的整数')
    serve = { mode: 'static', static: abs(rs.static), port, url: `http://localhost:${port}`, readyPath, proxy: isObject(rs.proxy) ? { ...rs.proxy } : {}, timeoutMs }
  } else if (rs.url) {
    serve = { mode: 'url', url: rs.url, port: portOf(rs.url), readyPath, proxy: {}, timeoutMs }
  } else {
    fail('serve 需要 command + url、static 或 url 三者之一')
  }
  if (autoPages && serve.mode === 'url') {
    const url = parseUrl(serve.url)
    // 自动发现从完整入口开始，显式 pages 继续沿用基础地址的拼接语义。
    const base = new URL('/', url).href.slice(0, -1)
    pages = [url.href.slice(base.length)]
    serve = { ...serve, url: base }
  }

  // 构建（url 模式不构建）
  let build = null
  if (serve.mode !== 'url' && raw.build != null) {
    if (!isObject(raw.build) || typeof raw.build.command !== 'string') fail('build.command 必须是字符串')
    build = { command: raw.build.command, env: isObject(raw.build.env) ? { ...raw.build.env } : {} }
  }

  const httpsRaw = isObject(raw.https) ? raw.https : {}
  const https = { enabled: serve.mode !== 'url' && httpsRaw.enabled === true, port: httpsRaw.port ?? 4443 }
  if (!isPort(https.port)) fail('https.port 必须是 1–65535 之间的整数')

  const runs = overrides.runs ?? raw.runs ?? 1
  if (!Number.isInteger(runs) || runs < 1) fail('runs 必须是 ≥ 1 的整数')
  const visit = raw.visit ?? 'first'
  if (visit !== 'first' && visit !== 'repeat') fail("visit 只能是 'first' 或 'repeat'")
  const formFactor = raw.formFactor ?? 'mobile'
  if (formFactor !== 'mobile') fail("第一版只支持 formFactor: 'mobile'")
  if (raw.beforePage != null && typeof raw.beforePage !== 'function') fail('beforePage 必须是函数')
  const keep = raw.keep ?? 'latest'
  if (keep !== 'latest' && !(Number.isInteger(keep) && keep > 0)) fail("keep 只能是 'latest' 或正整数")

  const docsRaw = isObject(raw.docs) ? raw.docs : {}
  const audiences = docsRaw.audiences ?? ['dev', 'lead']
  if (!Array.isArray(audiences) || audiences.length === 0 || audiences.some((a) => a !== 'dev' && a !== 'lead'))
    fail("docs.audiences 只能包含 'dev' 和 'lead'")

  const aiRaw = isObject(raw.ai) ? raw.ai : {}
  if (raw.ai != null && !isObject(raw.ai)) fail('ai 必须是配置对象')
  const provider = aiRaw.provider ?? 'anthropic'
  if (typeof provider !== 'string' || !Object.hasOwn(AI_DEFAULTS, provider))
    fail(`ai.provider 只能取 ${Object.keys(AI_DEFAULTS).join('、')}`)
  const aiDefaults = AI_DEFAULTS[provider]
  for (const key of ['enabled', 'cache'])
    if (aiRaw[key] != null && typeof aiRaw[key] !== 'boolean') fail(`ai.${key} 必须是布尔值`)
  if (aiRaw.exclude != null && (!Array.isArray(aiRaw.exclude) || aiRaw.exclude.some((p) => typeof p !== 'string' || !p)))
    fail('ai.exclude 必须是字符串数组，例如 ["**/secret/**"]')
  for (const key of ['maxFindings', 'timeoutMs', 'maxTokens', 'maxFileChars', 'maxFindingChars', 'concurrency'])
    if (aiRaw[key] != null && (!Number.isSafeInteger(aiRaw[key]) || aiRaw[key] < 1)) fail(`ai.${key} 必须是正整数`)
  if (aiRaw.concurrency > 8) fail('ai.concurrency 只能取 1–8')
  if (aiRaw.timeoutMs > 2147483647) fail('ai.timeoutMs 不能大于 2147483647')
  if (aiRaw.maxRetries != null && (!Number.isInteger(aiRaw.maxRetries) || aiRaw.maxRetries < 0 || aiRaw.maxRetries > 3))
    fail('ai.maxRetries 只能取 0–3')
  for (const key of ['model', 'apiKeyEnv', 'sourceRoot', 'baseURL', 'language'])
    if (aiRaw[key] != null && (typeof aiRaw[key] !== 'string' || !aiRaw[key].trim())) fail(`ai.${key} 必须是非空字符串`)
  if (aiRaw.instructions != null && typeof aiRaw.instructions !== 'string') fail('ai.instructions 必须是字符串')
  const responseFormat = aiRaw.responseFormat ?? 'auto'
  if (!['auto', 'json-schema', 'json', 'text'].includes(responseFormat)) fail('ai.responseFormat 只能取 auto、json-schema、json、text')
  const maxFileChars = aiRaw.maxFileChars ?? 8000
  const maxFindingChars = aiRaw.maxFindingChars ?? 24000
  if (maxFileChars > maxFindingChars) fail('ai.maxFileChars 不能大于 ai.maxFindingChars')
  let baseURL = aiRaw.baseURL ?? aiDefaults.baseURL
  if (baseURL) {
    let u
    try { u = new URL(baseURL) } catch { fail('ai.baseURL 必须是 HTTP/HTTPS 地址') }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      fail('ai.baseURL 必须是 HTTP/HTTPS 地址，不能包含账户密码、查询参数或 fragment')
    baseURL = u.href.replace(/\/+$/, '')
  }
  if (provider === 'openai-compatible' && (!aiRaw.model || !baseURL)) fail('openai-compatible 需要配置 ai.model 和 ai.baseURL')
  const exclude = [...BUILTIN_EXCLUDE]
  for (const p of aiRaw.exclude ?? []) if (!exclude.includes(p)) exclude.push(p)

  const smRaw = isObject(raw.sourceMap) ? raw.sourceMap : {}

  return {
    root,
    configFile,
    build,
    serve,
    https,
    pages: [...pages],
    crawl,
    beforePage: raw.beforePage ?? null,
    runs,
    visit,
    formFactor,
    categories: Array.isArray(raw.categories) && raw.categories.length ? [...raw.categories] : [...DEFAULT_CATEGORIES],
    chromePath: raw.chromePath ?? null,
    sourceMap: { manifest: abs(smRaw.manifest), maps: abs(smRaw.maps) },
    docs: { audiences: [...audiences], lang: 'zh-CN' },
    ai: {
      enabled: aiRaw.enabled === true,
      provider,
      model: (aiRaw.model ?? aiDefaults.model).trim(),
      apiKeyEnv: (aiRaw.apiKeyEnv ?? aiDefaults.apiKeyEnv).trim(),
      baseURL,
      responseFormat,
      timeoutMs: aiRaw.timeoutMs ?? 120000,
      maxRetries: aiRaw.maxRetries ?? 1,
      maxTokens: aiRaw.maxTokens ?? 16000,
      concurrency: aiRaw.concurrency ?? 2,
      cache: aiRaw.cache ?? true,
      maxFileChars,
      maxFindingChars,
      language: aiRaw.language?.trim() ?? 'zh-CN',
      instructions: aiRaw.instructions ?? '',
      // 默认只看 src/（有的话），不把整个项目当作可发送的源码。
      sourceRoot: abs(aiRaw.sourceRoot ?? (fs.existsSync(path.join(root, 'src')) ? 'src' : '.')),
      maxFindings: aiRaw.maxFindings ?? 10,
      exclude,
    },
    outDir: abs(raw.outDir ?? '.lhkit'),
    keep,
  }
}

/**
 * 在 cwd 查找并读取配置文件；没有配置时可用 --url 直接扫描。
 * @param {string} cwd
 * @param {{url?: string, runs?: number, maxPages?: number, maxDepth?: number}} [overrides]
 * @returns {Promise<import('./types.mjs').Config>}
 */
export async function loadConfig(cwd, overrides = {}) {
  const root = path.resolve(cwd)
  const file = CONFIG_FILES.map((name) => path.join(root, name)).find((f) => fs.existsSync(f))
  if (!file) {
    if (overrides.url == null)
      fail(`在 ${root} 找不到 ${CONFIG_FILES.join(' 或 ')}（可运行 lhkit init 生成，或使用 lhkit scan --url <网址> 直接扫描）`)
    parseUrl(overrides.url, '--url')
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`项目目录不存在或不是目录：${root}`)
    return normalizeConfig({}, root, null, overrides)
  }
  let mod
  try {
    mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`)
  } catch (error) {
    fail(`读取 ${path.basename(file)} 失败：${error.message}`)
  }
  return normalizeConfig(mod.default, root, file, overrides)
}
