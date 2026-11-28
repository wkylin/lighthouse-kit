// 发现可扫描的同源页面：sitemap 与浏览器渲染后的链接。
import puppeteer from 'puppeteer-core'
import { slugKey } from './slug.mjs'

const ASSET = /\.(?:avif|bmp|css|csv|gif|gz|ico|jpe?g|js|json|map|mjs|mp[34]|ogg|otf|pdf|png|svg|tar|ttf|txt|wasm|wav|webm|webmanifest|webp|woff2?|xml|zip)$/i
const LOGOUT = /(?:^|\/)(?:logout|log-out|signout|sign-out)(?:\/|$)/i
const isLogout = url => LOGOUT.test(url.pathname) || /^(?:logout|signout|sign-out)$/i.test(url.searchParams.get('action') ?? '')

/** Normalize a discovered link; preserve the entry's exact query/fragment. */
export function pageCandidate(value, base, siteOrigin, { entry = false } = {}) {
  let url
  try { url = new URL(value, base) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== siteOrigin || ASSET.test(url.pathname)) return null
  const hashRoute = url.hash.startsWith('#/') || url.hash.startsWith('#!/')
  let hashUrl
  if (hashRoute) {
    try { hashUrl = new URL(url.hash.replace(/^#!/, '').replace(/^#/, ''), url.origin) } catch { return null }
  }
  if (!entry && (isLogout(url) || (hashUrl && isLogout(hashUrl)))) return null
  if (!entry && !hashRoute) url.hash = ''
  const canonical = new URL(url)
  if (!hashRoute) canonical.hash = ''
  canonical.pathname = canonical.pathname.replace(/\/+$/, '') || '/'
  canonical.searchParams.sort()
  const root = new URL('/', url).href.slice(0, -1)
  const page = url.href.slice(root.length)
  return { url, page, key: canonical.href, slug: slugKey(page) }
}

async function readLinks(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href], area[href]')).filter(a => !a.hasAttribute('download'))
    return { links: links.slice(0, 2000).map(a => a.href), limited: links.length > 2000 }
  })
}

async function readSitemap(page, url, timeoutMs) {
  return page.evaluate(async ({ url, timeoutMs }) => {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(timeoutMs) })
    if (response.status === 404 || response.status === 410) return null
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const read = async stream => {
      const reader = stream.getReader()
      const chunks = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 2 * 1024 * 1024) throw new Error('sitemap 超过 2 MiB')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return bytes
    }
    let bytes = await read(response.body)
    if (bytes[0] === 0x1f && bytes[1] === 0x8b)
      bytes = await read(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')))
    const text = new TextDecoder().decode(bytes)
    // SPA 服务经常对不存在的 sitemap 返回首页，这不算发现失败。
    if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) return null
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) throw new Error('sitemap XML 无法解析')
    const root = doc.documentElement.localName
    if (root !== 'urlset' && root !== 'sitemapindex') return null
    const tag = root === 'urlset' ? 'url' : 'sitemap'
    const locations = Array.from(doc.getElementsByTagNameNS('*', tag))
      .map(node => node.getElementsByTagNameNS('*', 'loc')[0]?.textContent?.trim())
      .filter(Boolean)
    return { url: response.url, index: root === 'sitemapindex', locations }
  }, { url, timeoutMs })
}

/**
 * Discover same-origin routes before measurement; never reuse this browser for Lighthouse.
 * @param {{config: import('./types.mjs').Config, origin: string, chromePath: string, signal?: AbortSignal,
 *   log: {info:(message:string)=>void, warn:(message:string)=>void}}} opts
 * @returns {Promise<{origin:string,pages:string[],visited:number,limited:boolean,limitReasons:string[],errors:number,skipped:{url:string,reason:string}[]}>}
 */
export async function discoverPages({ config, origin, chromePath, signal, log }) {
  const { maxPages, maxDepth, timeoutMs } = config.crawl
  let browser
  let closing
  const close = () => {
    if (browser && !closing) closing = browser.close().catch(() => {})
    return closing
  }
  const onAbort = () => { void close() }
  signal?.throwIfAborted()
  signal?.addEventListener('abort', onAbort, { once: true })
  let limited = false
  const limitReasons = new Set()
  const limit = reason => { limited = true; limitReasons.add(reason) }
  let errors = 0
  let visited = 0
  const skipped = []
  const fail = (url, reason) => {
    errors++
    if (skipped.length < 50) {
      skipped.push({ url, reason })
      log.warn(`自动发现跳过 ${url}：${reason}`)
    }
  }
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath, headless: true,
      args: ['--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check'],
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    })
    signal?.throwIfAborted()
    const page = await browser.newPage()
    const navigate = async url => {
      signal?.throwIfAborted()
      if (config.beforePage) await config.beforePage({ page, url, warmup: false })
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`)
      const type = response?.headers()['content-type'] ?? ''
      if (type && !/text\/html|application\/xhtml\+xml/i.test(type)) return false
      await page.waitForNetworkIdle({ idleTime: 300, timeout: Math.min(timeoutMs, 2000) }).catch(() => {})
      signal?.throwIfAborted()
      return true
    }
    const entryUrl = `${origin.replace(/\/+$/, '')}${config.pages[0]}`
    if (!await navigate(entryUrl)) throw new Error(`自动发现入口不是 HTML 页面：${entryUrl}`)
    visited++
    // 入口允许正常的域名/HTTPS 重定向；之后固定在最终 origin。
    const finalEntry = new URL(page.url())
    const siteOrigin = finalEntry.origin
    if (!['http:', 'https:'].includes(finalEntry.protocol)) throw new Error('自动发现入口必须是 HTTP/HTTPS 页面')
    const entries = []
    const keys = new Set()
    const slugs = new Map()
    const add = (value, base, depth, entry = false) => {
      const candidate = pageCandidate(value, base, siteOrigin, { entry })
      if (!candidate || keys.has(candidate.key)) return
      if (depth > maxDepth) { limit(`链接深度超过 ${maxDepth}`); return }
      if (entries.length >= maxPages) { limit(`页面数超过 ${maxPages}`); return }
      if (slugs.has(candidate.slug)) {
        fail(candidate.url.href, `与 ${slugs.get(candidate.slug)} 的报告目录重复，请显式选择页面`)
        return
      }
      keys.add(candidate.key)
      slugs.set(candidate.slug, candidate.url.href)
      entries.push({ ...candidate, depth, skip: false })
      log.info(`发现页面 ${entries.length}：${candidate.page}`)
    }
    add(finalEntry.href === new URL(entryUrl).href ? entryUrl : finalEntry.href, finalEntry.href, 0, true)
    if (!entries.length) throw new Error(`自动发现没有可扫描的入口页面：${entryUrl}`)
    const firstLinks = await readLinks(page)
    if (firstLinks.limited) limit('单页链接超过 2000 条')

    let activeSitemap = null
    page.on('request', request => {
      let outside = false
      try { outside = new URL(request.url()).origin !== siteOrigin } catch {}
      const sitemapRequest = activeSitemap && (request.url() === activeSitemap || request.redirectChain().some(previous => previous.url() === activeSitemap))
      const block = outside && ((request.isNavigationRequest() && request.frame() === page.mainFrame()) || sitemapRequest)
      void (block ? request.abort('blockedbyclient') : request.continue()).catch(() => {})
    })
    await page.setRequestInterception(true)

    const sitemaps = [`${siteOrigin}/sitemap.xml`, `${siteOrigin}/sitemap_index.xml`]
    const seenMaps = new Set()
    let mapCount = 0
    for (let i = 0; i < sitemaps.length; i++) {
      signal?.throwIfAborted()
      let mapUrl
      try { mapUrl = new URL(sitemaps[i]) } catch { continue }
      mapUrl.hash = ''
      if (mapUrl.origin !== siteOrigin || seenMaps.has(mapUrl.href)) continue
      if (mapCount >= 10) { limit('sitemap 文档超过 10 份'); break }
      seenMaps.add(mapUrl.href)
      mapCount++
      try {
        activeSitemap = mapUrl.href
        const sitemap = await readSitemap(page, mapUrl.href, timeoutMs)
        if (!sitemap) continue
        seenMaps.add(sitemap.url)
        for (const location of sitemap.locations) {
          if (sitemap.index) {
            try { sitemaps.push(new URL(location, sitemap.url).href) } catch {}
          } else add(location, sitemap.url, 0)
        }
      } catch (error) {
        signal?.throwIfAborted()
        fail(mapUrl.href, String(error?.message ?? error))
      } finally {
        activeSitemap = null
      }
    }
    for (const link of firstLinks.links) add(link, finalEntry.href, 1)
    for (let i = 1; i < entries.length; i++) {
      const current = entries[i]
      try {
        if (!await navigate(current.url.href)) { current.skip = true; continue }
        visited++
        const links = await readLinks(page)
        if (links.limited) limit('单页链接超过 2000 条')
        for (const link of links.links) add(link, page.url(), current.depth + 1)
      } catch (error) {
        signal?.throwIfAborted()
        current.skip = true
        fail(current.url.href, String(error?.message ?? error))
      }
    }
    signal?.throwIfAborted()
    const pages = entries.filter(entry => !entry.skip).map(entry => entry.page)
    if (!pages.length) throw new Error('自动发现没有可扫描的页面，请显式指定 pages')
    if (limited) log.warn(`自动发现已达到范围限制：${[...limitReasons].join('；')}；本轮标记为部分扫描`)
    return { origin: siteOrigin, pages, visited, limited, limitReasons: [...limitReasons], errors, skipped }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await close()
  }
}
