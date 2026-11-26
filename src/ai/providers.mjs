// 协议适配；各服务共用覆盖响应正文的 deadline 和有限重试。
import { REPLY_SCHEMA } from './reply.mjs'

const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function resolveAiSettings(ai) {
  if (ai.provider !== 'anthropic') return ai
  return { ...ai, baseURL: (ai.baseURL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '') }
}

export function requestFor(task, system, ai) {
  const format = ai.responseFormat === 'auto' ? (['anthropic', 'openai'].includes(ai.provider) ? 'json-schema' : 'json') : ai.responseFormat
  if (ai.provider === 'anthropic') {
    const p = { model: ai.model, max_tokens: ai.maxTokens, system, messages: [{ role: 'user', content: task.prompt }] }
    if (format === 'json-schema') p.output_config = { format: { type: 'json_schema', schema: REPLY_SCHEMA } }
    if (FALLBACK_MODELS.has(ai.model)) {
      p.output_config = { ...p.output_config, effort: 'high' }
      Object.assign(p, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    }
    return p
  }
  const p = { model: ai.model, messages: [{ role: 'system', content: system }, { role: 'user', content: task.prompt }], stream: false }
  p[ai.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = ai.maxTokens
  if (format === 'json-schema') p.response_format = { type: 'json_schema', json_schema: { name: 'lighthouse_advice', strict: true, schema: REPLY_SCHEMA } }
  if (format === 'json') p.response_format = { type: 'json_object' }
  return p
}

export const isFatal = (error) => error?.status === 401 || error?.status === 403 || error?.status === 408 ||
  error?.name === 'APIConnectionError' || error?.name === 'APIConnectionTimeoutError'
const retryable = (e) => e?.status === 408 || e?.status === 429 || e?.status >= 500 ||
  e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError'

function withPolicy(ai, operation) {
  return { create: async (params) => {
    let everSent = false
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      let timer
      let timedOut = false
      let responseStatus = null
      const context = { signal: controller.signal, onResponse: (status) => { everSent = true; responseStatus = status } }
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error('模型请求超时'))
        }, ai.timeoutMs)
      })
      try {
        return await Promise.race([operation(params, context), deadline])
      } catch (error) {
        if (error?.status != null || error?.sent) everSent = true
        let e = error
        if (timedOut) e = Object.assign(new Error('模型请求超时'), { name: 'APIConnectionTimeoutError' })
        else if (error?.status == null && error?.name === 'SyntaxError' && responseStatus != null)
          e = Object.assign(new Error('模型服务返回非 JSON 响应'), { status: responseStatus })
        else if (error?.status == null && !['APIConnectionError', 'APIConnectionTimeoutError'].includes(error?.name))
          e = Object.assign(new Error('无法连接模型服务'), { name: 'APIConnectionError' })
        e.sent = everSent
        if (!retryable(e) || attempt >= ai.maxRetries) throw e
      } finally { clearTimeout(timer) }
      await pause(Math.min(200 * 2 ** attempt, 2000))
    }
  } }
}

export async function createClient(settings, apiKey, { fetch: fetcher = globalThis.fetch } = {}) {
  const ai = resolveAiSettings(settings)
  if (ai.provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    return withPolicy(ai, async (params, context) => {
      // 每次尝试绑定自己的真实 fetch signal，覆盖 SDK 读取正文期间也生效。
      // 关闭 SDK 重试，避免 SDK 与外层重复重试或重试鉴权错误。
      const sdk = new Anthropic({ apiKey, baseURL: ai.baseURL, timeout: ai.timeoutMs, maxRetries: 0,
        fetch: async (url, options) => {
          const response = await fetcher(url, { ...options, signal: context.signal, redirect: 'error' })
          context.onResponse(response.status)
          return response
        },
      })
      return sdk.beta.messages.create(params, { signal: context.signal, maxRetries: 0 })
    })
  }
  return withPolicy(ai, async (params, context) => {
    const response = await fetcher(`${ai.baseURL}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: context.signal, redirect: 'error',
    })
    context.onResponse(response.status)
    let data
    try { data = await response.json() } catch (error) {
      if (context.signal.aborted) throw error
      throw Object.assign(new Error('模型服务返回非 JSON 响应'), { status: response.status })
    }
    if (!response.ok) {
      const message = String(data?.error?.message ?? data?.message ?? response.statusText).slice(0, 400).replaceAll(apiKey, '[redacted]')
      throw Object.assign(new Error(message), { status: response.status })
    }
    return data
  })
}
