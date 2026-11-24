// 文档与总览共用的格式化工具。

export const PHASE_LABELS = {
  timeToFirstByte: '首字节',
  resourceLoadDelay: '资源加载延迟',
  resourceLoadDuration: '资源加载耗时',
  elementRenderDelay: '元素渲染延迟',
  TTFB: '首字节',
  'Load Delay': '资源加载延迟',
  'Load Time': '资源加载耗时',
  'Render Delay': '元素渲染延迟',
}

export const VISIT_LABELS = { first: '首次访问', repeat: '回访' }

/** Lighthouse 的加载超时提示（maxWaitForLoad 内没有加载完，照常出分但结果可能不完整）。 */
const LOAD_TIMEOUT_RE = /too slowly to finish within the time limit/i
export const isLoadTimeout = (warning) => LOAD_TIMEOUT_RE.test(warning)
export const loadTimedOut = (summary) => (summary.warnings ?? []).some(isLoadTimeout)
export const TIMEOUT_MARK = '（加载超时，结果可能不完整）'

export const fmtScore = (v) => (v == null ? '–' : String(Math.round(v)))
export const fmtS = (ms) => (ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`)
export const fmtMs = (ms) => (ms == null ? '–' : `${Math.round(ms)} ms`)
export const fmtCls = (v) => (v == null ? '–' : v.toFixed(3))
export const fmtKb = (bytes) => (bytes == null ? '–' : `${(bytes / 1024).toFixed(1)} KB`)
export const fmtAgentic = (a) => (a ? `${a.pass}/${a.total}` : '–')

/** 带符号的差值：+5、-3、0。 */
export function signed(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '–'
  const s = v.toFixed(digits)
  return v > 0 ? `+${s}` : s === (-0).toFixed(digits) ? (0).toFixed(digits) : s
}

/** 表格单元格：转义竖线、去掉换行。 */
export const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** 本地时间 YYYY-MM-DD HH:mm。 */
export function fmtTime(iso) {
  if (!iso) return '–'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 页面报告相对轮次目录的路径。 */
export const reportPath = (summary) => `pages/${summary.slug}/run-${summary.representative}/lighthouse.html`

/**
 * 页面被重定向到的地址（同源只给路径和查询串）；没有重定向时返回 null。
 * 只看 origin + 路径 + 查询串：#hash 和结尾的 / 不算重定向。
 * @param {{page: string, finalUrl: string|null}} summary
 * @param {string} origin 本轮扫描的目标地址
 */
export function redirectedTo(summary, origin) {
  if (!summary?.finalUrl || !origin) return null
  let final
  let expected
  try {
    final = new URL(summary.finalUrl)
    expected = new URL(origin.replace(/\/+$/, '') + summary.page)
  } catch {
    return null
  }
  const norm = (u) => `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`
  if (norm(final) === norm(expected)) return null
  return final.origin === expected.origin ? final.pathname + final.search : final.host + final.pathname + final.search
}

/** 页面名后的“（跳转到 …）”标注；没有重定向时为空串。 */
export const redirectMark = (summary, origin) => {
  const to = redirectedTo(summary, origin)
  return to ? `（跳转到 ${to}）` : ''
}

/** 同源网址只显示路径，其他显示主机名 + 路径。 */
export function shortUrl(url, origin) {
  try {
    const u = new URL(url)
    if (origin && u.origin === new URL(origin).origin) return u.pathname + u.search
    return u.host + u.pathname
  } catch {
    return url
  }
}
