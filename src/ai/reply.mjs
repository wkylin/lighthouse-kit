// 新建议必须能追溯到实际给出的源码；历史建议的显示不经过此入口。
export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    cause: { type: 'string', description: '区分 Lighthouse 实测与源码推断；证据不足时说明缺口' },
    fix: { type: 'string', description: '针对证据的具体改法、文件和适用前提' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, quote: { type: 'string' } }, required: ['file', 'quote'], additionalProperties: false } },
    verification: { type: 'array', items: { type: 'string' }, description: '验证诊断、优化效果与回归的方法；不能声称已经执行' },
  },
  required: ['cause', 'fix', 'confidence', 'evidence', 'verification'],
  additionalProperties: false,
}

const nonempty = (s) => typeof s === 'string' && s.trim().length > 0

export function validateAdvice(obj, sources, model) {
  if (!nonempty(obj?.cause) || !nonempty(obj?.fix)) throw new Error('返回缺少 cause 或 fix')
  if (!['high', 'medium', 'low'].includes(obj.confidence)) throw new Error('返回缺少有效 confidence')
  if (!Array.isArray(obj.verification) || !obj.verification.length || obj.verification.some((s) => !nonempty(s)))
    throw new Error('返回缺少非空 verification 验证步骤')
  if (!Array.isArray(obj.evidence)) throw new Error('返回缺少 evidence 源码引用')
  for (const e of obj.evidence) {
    const source = sources.find((s) => s.file === e?.file)
    if (!source || !nonempty(e.quote) || !source.text.includes(e.quote)) throw new Error('源码引用不在实际提供的片段中')
  }
  if (!obj.evidence.length && obj.confidence !== 'low') throw new Error('没有源码引用的建议只能标为低置信度')
  if (!nonempty(model)) throw new Error('缺少模型或会话名称')
  return {
    cause: obj.cause.trim(), fix: obj.fix.trim(), model: model.trim(), confidence: obj.confidence,
    evidence: obj.evidence.map(({ file, quote }) => ({ file, quote })), verification: obj.verification.map((s) => s.trim()),
  }
}

export function parseReply(res, ai, sources) {
  let text
  if (ai.provider === 'anthropic') {
    if (res?.stop_reason !== 'end_turn') throw new Error(res?.stop_reason === 'refusal' ? '模型拒绝回答' : '回答被截断或没有正常结束')
    text = (res?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  } else {
    const choice = res?.choices?.[0]
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new Error('模型拒绝回答')
    if (choice?.finish_reason !== 'stop') throw new Error('回答被截断或没有正常结束')
    text = choice?.message?.content
  }
  if (!nonempty(text)) throw new Error('模型返回空回答')
  // text 模式允许完整 JSON 围栏，不从任意正文中猜测或拼接 JSON。
  text = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1')
  let obj
  try { obj = JSON.parse(text) } catch { throw new Error('返回的内容不是 JSON') }
  return validateAdvice(obj, sources, res.model ?? ai.model)
}
