// 逐页扫描：每次（页面 × 次数）一个全新的 Chrome，写 lighthouse.json / .html 与 summary.json。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import lighthouse from 'lighthouse'
import puppeteer from 'puppeteer-core'
import { findChrome } from './chrome.mjs'
import { loadTimedOut } from './docs/format.mjs'
import { writeLighthouseHtml } from './report/lighthouse-html.mjs'
import { pageSlug, writeRoundMeta } from './round.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

const pct = (cat) => (cat?.score == null ? null : Math.round(cat.score * 100))

/** @returns {import('./types.mjs').Scores} */
export function scoresOf(lhr) {
  const c = lhr.categories ?? {}
  const refs = (c['agentic-browsing']?.auditRefs ?? []).filter((r) => r.weight > 0)
  return {
    perf: pct(c.performance),
    a11y: pct(c.accessibility),
    bp: pct(c['best-practices']),
    seo: pct(c.seo),
    agentic: refs.length ? { pass: refs.filter((r) => lhr.audits?.[r.id]?.score === 1).length, total: refs.length } : null,
  }
}

/** @returns {import('./types.mjs').Metrics} */
export function metricsOf(lhr) {
  const v = (id) => lhr.audits?.[id]?.numericValue ?? null
  return { fcp: v('first-contentful-paint'), lcp: v('largest-contentful-paint'), tbt: v('total-blocking-time'), cls: v('cumulative-layout-shift'), si: v('speed-index') }
}

/** 性能分最接近中位数的那次（相同取序号小的）。 */
function representativeOf(okRuns) {
  const med = median(okRuns.map((r) => r.scores.perf))
  if (med == null) return okRuns[0]?.index ?? null
  let best = okRuns[0]
  for (const r of okRuns) if (Math.abs(r.scores.perf - med) < Math.abs(best.scores.perf - med)) best = r
  return best.index
}

async function runOnce({ config, url, dir, signal, maxWaitForLoad, chromePath }) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-profile-'))
  let browser
  let page
  const onAbort = () => {
    page?.close().catch(() => {})
    void browser?.close().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // 优化 Chrome 启动参数：内存管理、协议稳定性
    const chromeArgs = [
      '--ignore-certificate-errors',
      '--no-first-run',
      '--no-default-browser-check',
      // 内存和进程优化
      '--memory-pressure-off',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-extensions-with-background-pages',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-features=Translate,OptimizationGuideModelDownloading,OptimizationHintsFetching,SyncPromoShowOnFirstRun,TranslateBubbleUIV2',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-service-autorun',
      '--password-store=basic',
      '--use-mock-volume-mount',
      // CDP 协议稳定性
      '--enable-automation',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-web-resources',
      '--enable-features=IsolateOrigins,NetworkService,NetworkServiceInProcess',
    ]

    browser = await puppeteer.launch({
      executablePath: chromePath ?? findChrome(config),
      headless: true,
      userDataDir,
      args: chromeArgs,
      // Ctrl+C / kill 由 lhkit 自己处理（中止扫描、关服务、标记轮次）；puppeteer 默认会自行退出或只关浏览器。
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: 30000, // 浏览器启动超时 30s
    })
    if (signal?.aborted) throw new Error('已中断')

    page = await browser.newPage()
    // 设置页面崩溃处理
    page.on('error', (err) => {
      throw new Error(`页面错误：${err.message}`)
    })

    if (config.visit === 'repeat') {
      if (config.beforePage) await config.beforePage({ page, url, warmup: true })
      await page.goto(url, { waitUntil: 'networkidle2', timeout: maxWaitForLoad }).catch(() => {})
      await sleep(2000)
    }
    if (config.beforePage) await config.beforePage({ page, url, warmup: false })

    // 增加 Lighthouse 超时，改善 maxWaitForLoad
    const enhancedMaxWaitForLoad = Math.max(maxWaitForLoad, 60000)
    const result = await lighthouse(
      url,
      {
        output: 'json',
        logLevel: 'error',
        formFactor: 'mobile',
        throttlingMethod: 'simulate',
        onlyCategories: config.categories,
        maxWaitForLoad: enhancedMaxWaitForLoad,
        disableStorageReset: config.visit === 'repeat',
        // 增强稳定性：给协议充足的响应时间
        pauseAfterLoad: 1000,
      },
      undefined,
      page,
    )
    if (!result) throw new Error('Lighthouse 没有返回结果')
    await fs.mkdir(dir, { recursive: true })
    const jsonPath = path.join(dir, 'lighthouse.json')
    await fs.writeFile(jsonPath, result.report)
    writeLighthouseHtml(jsonPath, result.lhr)
    return result.lhr
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // 确保页面先关闭
    await page?.close().catch(() => {})
    await sleep(500)
    await browser?.close().catch(() => {})
    await sleep(500)
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * @param {{config: import('./types.mjs').Config, origin: string, roundDir: string, meta: import('./types.mjs').RoundMeta, pages: string[],
 *   log: {info: (m: string) => void}, signal?: AbortSignal, maxWaitForLoad?: number, chromePath?: string}} opts
 * @returns {Promise<{meta: import('./types.mjs').RoundMeta, pages: import('./types.mjs').PageSummary[]}>}
 */
export async function scanRound({ config, origin, roundDir, meta, pages, log, signal, maxWaitForLoad = 45000, chromePath }) {
  /** @type {import('./types.mjs').PageSummary[]} */
  const summaries = []
  let lighthouseVersion = ''
  let aborted = false
  for (const page of pages) {
    if (signal?.aborted) {
      aborted = true
      break
    }
    const slug = pageSlug(page)
    const url = `${origin}${page}`
    const started = Date.now()
    const runs = []
    let finalUrl = null
    for (let index = 1; index <= config.runs; index++) {
      if (signal?.aborted) break

      // 重试机制：协议错误、浏览器崩溃等临时问题
      let lastError = null
      const maxRetries = 3
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const lhr = await runOnce({ config, url, dir: path.join(roundDir, 'pages', slug, `run-${index}`), signal, maxWaitForLoad, chromePath })
          lighthouseVersion ||= lhr.lighthouseVersion
          if (lhr.runtimeError) {
            runs.push({ index, ok: false, error: `${lhr.runtimeError.code}：${lhr.runtimeError.message}`, scores: null, metrics: null, warnings: [] })
          } else {
            finalUrl = lhr.finalDisplayedUrl ?? lhr.finalUrl ?? url
            // runWarnings：例如加载超时（照常出分，但结果可能不完整）
            runs.push({ index, ok: true, error: null, scores: scoresOf(lhr), metrics: metricsOf(lhr), warnings: [...(lhr.runWarnings ?? [])] })
          }
          lastError = null
          break
        } catch (error) {
          lastError = error
          const errorMsg = String(error?.message ?? error)
          const isProtocolError = errorMsg.includes('Protocol error') || errorMsg.includes('Session closed')
          const isBrowserCrash = errorMsg.includes('Target closed') || errorMsg.includes('page has been closed')
          const isRetryable = isProtocolError || isBrowserCrash

          if (isRetryable && attempt < maxRetries && !signal?.aborted) {
            // 指数退避：1s、2s、4s
            const waitMs = Math.pow(2, attempt - 1) * 1000
            await sleep(waitMs)
            // 继续重试下一次尝试
          } else {
            // 不可重试或已达最大重试次数
            const retryInfo = isRetryable && attempt < maxRetries ? ` (第 ${attempt}/${maxRetries} 次尝试失败，不继续重试)` : ''
            runs.push({ index, ok: false, error: signal?.aborted ? '已中断' : errorMsg + retryInfo, scores: null, metrics: null, warnings: [] })
            break
          }
        }
      }

      // 如果所有重试都失败了
      if (lastError && runs.filter((r) => r.index === index).length === 0) {
        runs.push({ index, ok: false, error: `${signal?.aborted ? '已中断' : String(lastError?.message ?? lastError)}`, scores: null, metrics: null, warnings: [] })
      }
    }
    if (signal?.aborted) {
      aborted = true
      break
    }
    const okRuns = runs.filter((r) => r.ok)
    const representative = representativeOf(okRuns)
    const rep = okRuns.find((r) => r.index === representative)
    const med = (pick) => median(okRuns.map(pick))
    /** @type {import('./types.mjs').PageSummary} */
    const summary = {
      page,
      slug,
      ok: okRuns.length > 0,
      error: okRuns.length ? null : (runs.at(-1)?.error ?? '扫描失败'),
      finalUrl,
      warnings: [...new Set(okRuns.flatMap((r) => r.warnings))],
      runs,
      representative,
      median: okRuns.length
        ? {
            scores: { perf: med((r) => r.scores.perf), a11y: med((r) => r.scores.a11y), bp: med((r) => r.scores.bp), seo: med((r) => r.scores.seo), agentic: rep.scores.agentic },
            metrics: { fcp: med((r) => r.metrics.fcp), lcp: med((r) => r.metrics.lcp), tbt: med((r) => r.metrics.tbt), cls: med((r) => r.metrics.cls), si: med((r) => r.metrics.si) },
          }
        : null,
    }
    await fs.mkdir(path.join(roundDir, 'pages', slug), { recursive: true })
    await fs.writeFile(path.join(roundDir, 'pages', slug, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    summaries.push(summary)
    const secs = Math.round((Date.now() - started) / 1000)
    if (summary.ok) {
      const m = summary.median
      const slow = loadTimedOut(summary) ? '  ⚠ 加载超时，结果可能不完整' : ''
      log.info(`${page}  性能 ${m.scores.perf ?? '–'}  LCP ${m.metrics.lcp == null ? '–' : (m.metrics.lcp / 1000).toFixed(1) + ' s'}  TBT ${m.metrics.tbt == null ? '–' : Math.round(m.metrics.tbt) + ' ms'}  ${secs}s${slow}`)
    } else {
      log.info(`${page}  失败：${summary.error}  ${secs}s`)
    }
  }
  const failedPages = summaries.filter((s) => !s.ok).map((s) => s.page)
  const next = {
    ...meta,
    origin,
    lighthouseVersion: lighthouseVersion || meta.lighthouseVersion,
    visit: config.visit,
    formFactor: config.formFactor,
    runs: config.runs,
    failedPages,
    status: aborted ? 'aborted' : failedPages.length ? 'failed-pages' : 'complete',
    finishedAt: new Date().toISOString(),
  }
  await writeRoundMeta(roundDir, next)
  return { meta: next, pages: summaries }
}
