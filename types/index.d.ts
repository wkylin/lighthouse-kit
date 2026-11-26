// lhkit.config.mjs 的类型。用法（二选一）：
//   /** @type {import('lighthouse-kit').UserConfig} */
//   export default { ... }
// 或
//   import { defineConfig } from 'lighthouse-kit'
//   export default defineConfig({ ... })
import type { Page } from 'puppeteer-core'

/** Lighthouse 类别。 */
export type Category = 'performance' | 'accessibility' | 'best-practices' | 'seo' | 'agentic-browsing'

export interface BuildConfig {
  /** 构建命令，在项目根目录执行。想把问题对到源码，让构建输出 source map，例如 `npm run build -- --sourcemap hidden`。 */
  command: string
  /** 构建时额外的环境变量。 */
  env?: Record<string, string>
}

interface ServeCommon {
  /** 判断服务就绪时请求的路径，默认 `/`。 */
  readyPath?: string
  /** 等服务就绪的最长时间（毫秒），默认 60000。 */
  timeoutMs?: number
}

/** 用项目自己的命令起服务（例如 `npm run preview`）。 */
export interface ServeCommand extends ServeCommon {
  command: string
  /** 服务的地址，例如 `http://localhost:4173`；子路径部署时带上路径。 */
  url: string
}

/** 工具自带的静态服务托管构建目录（SPA 回退、哈希文件长缓存、压缩，只监听 127.0.0.1）。 */
export interface ServeStatic extends ServeCommon {
  /** 构建目录，相对项目根目录，例如 `dist`。 */
  static: string
  /** 端口，默认 4173。 */
  port?: number
  /** 接口代理：路径前缀 → 目标地址，例如 `{ '/api': 'http://localhost:3000' }`（含 WebSocket）。 */
  proxy?: Record<string, string>
}

/** 直接扫描一个已经在运行的地址（不构建、不起服务）。 */
export interface ServeUrl extends ServeCommon {
  url: string
}

export type ServeConfig = ServeCommand | ServeStatic | ServeUrl

export interface BeforePageContext {
  /** 即将打开页面的 puppeteer Page。 */
  page: Page
  /** 要打开的完整网址。 */
  url: string
  /** `visit: 'repeat'` 时的预热访问为 true。 */
  warmup: boolean
}

export type AiProvider = 'anthropic' | 'openai' | 'deepseek' | 'openai-compatible'

export interface AiConfig {
  /** 默认关闭。打开即允许把筛选后的证据和源码片段发给所选模型服务；Key 从环境变量读取。 */
  enabled?: boolean
  /** 默认 anthropic。Codex 等助手通过通用 skill 复用当前会话。 */
  provider?: AiProvider
  /** 默认：Anthropic claude-opus-5-5，OpenAI gpt-4.1-mini，DeepSeek deepseek-flash。兼容服务必须指定。 */
  model?: string
  /** API 根地址（保留 /v1 等路径前缀）；openai-compatible 必须指定。 */
  baseURL?: string
  /** 默认按 provider 读取 ANTHROPIC_API_KEY、OPENAI_API_KEY 或 DEEPSEEK_API_KEY。 */
  apiKeyEnv?: string
  /** 默认 auto：Anthropic/OpenAI 用 schema，DeepSeek/兼容服务用 JSON。text 仍要求 JSON 回答。 */
  responseFormat?: 'auto' | 'json-schema' | 'json' | 'text'
  /** 每次请求超时，默认 120000 毫秒。 */
  timeoutMs?: number
  /** 临时失败的重试次数，0–3，默认 1。 */
  maxRetries?: number
  /** 回答 token 上限，默认 16000（推理模型也包含推理 token）。 */
  maxTokens?: number
  /** 同时分析的问题数，1–8，默认 2。 */
  concurrency?: number
  /** 按模型、提示和源码内容缓存有效建议，默认 true；false 强制重新请求。 */
  cache?: boolean
  /** 每文件源码字符预算，默认 8000，不能大于 maxFindingChars。 */
  maxFileChars?: number
  /** 每问题源码字符预算，默认 24000。 */
  maxFindingChars?: number
  /** AI 回答语言，默认 zh-CN。 */
  language?: string
  /** 额外业务约束，例如“保持 SSR，优先兼容旧设备”；不替代证据和验证要求。 */
  instructions?: string
  /** 允许发送的源码目录。默认：项目有 `src/` 就用 `src/`，否则项目根目录。 */
  sourceRoot?: string
  /** 最多分析的问题数，默认 10。 */
  maxFindings?: number
  /** 追加的排除规则（glob）。`.env*`、密钥证书、凭据文件、node_modules、锁文件和构建产物总是排除。 */
  exclude?: string[]
}

export interface UserConfig {
  /** 构建步骤；`serve` 为网址模式时忽略。 */
  build?: BuildConfig
  /** 三选一：`{ command, url }`、`{ static }` 或 `{ url }`。 */
  serve: ServeConfig
  /** 在服务前面加一层 HTTP/2 + 自签证书的代理，贴近线上（网址模式下忽略）。 */
  https?: { enabled?: boolean; port?: number }
  /** 要扫描的页面路径，以 `/` 开头，例如 `['/', '/about']`。 */
  pages: string[]
  /** 打开每个页面前执行，例如写入登录态、sessionStorage。 */
  beforePage?: (ctx: BeforePageContext) => void | Promise<void>
  /** 每页扫描次数，取中位数，默认 1。 */
  runs?: number
  /** `'first'` 首次访问（默认，每次全新的浏览器）；`'repeat'` 回访（先预热一次，保留缓存和存储）。 */
  visit?: 'first' | 'repeat'
  /** 目前只支持 `'mobile'`。 */
  formFactor?: 'mobile'
  /** 默认五类全扫。 */
  categories?: Category[]
  /** Chrome 可执行文件路径；默认自动查找（也可用环境变量 CHROME_PATH）。 */
  chromePath?: string
  /** 把问题对到源码：Vite manifest 和 source map 所在目录（相对项目根目录）。 */
  sourceMap?: { manifest?: string; maps?: string }
  /** 生成哪些文档：`'dev'` 开发版、`'lead'` 负责人版，默认两份都要。 */
  docs?: { audiences?: Array<'dev' | 'lead'> }
  /** 可选的 AI 分析。 */
  ai?: AiConfig
  /** 结果目录，默认 `.lhkit`。 */
  outDir?: string
  /** 未命名的完整轮次保留几轮：`'latest'`（默认）或正整数。 */
  keep?: 'latest' | number
}

/** 原样返回配置，只为类型提示。 */
export function defineConfig<T extends UserConfig>(config: T): T
