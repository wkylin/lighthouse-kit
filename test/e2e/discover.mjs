import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { findChrome } from '../../src/chrome.mjs'
import { normalizeConfig } from '../../src/config.mjs'
import { discoverPages } from '../../src/discover.mjs'
import { createRound } from '../../src/round.mjs'

const BIN = fileURLToPath(new URL('../../bin/lhkit.mjs', import.meta.url))
const exec = promisify(execFile)
const html = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Discovery</title></head><body><h1>Discovery</h1>${body}</body></html>`
const xml = body => ({ type: 'application/xml', body })
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const cli = (args, cwd) => exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, LHKIT_NO_OPEN: '1' }, timeout: 180000, maxBuffer: 2 * 1024 * 1024 })

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-discover-'))
  const routes = new Map()
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const route = routes.get(new URL(req.url, 'http://fixture').pathname)
    if (typeof route === 'function') return route(req, res)
    if (route == null) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(html('Not found')) }
    res.writeHead(200, { 'content-type': typeof route === 'string' ? 'text/html; charset=utf-8' : route.type })
    res.end(typeof route === 'string' ? route : route.body)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://localhost:${server.address().port}`
  const warnings = []
  const log = { info() {}, warn(message) { warnings.push(message) } }
  const config = raw => normalizeConfig({ serve: { url: origin }, ...raw }, root, null)
  const discover = (raw = {}, extra = {}) => {
    const c = config(raw)
    return discoverPages({ config: c, origin: c.serve.url, chromePath: findChrome(c), log, ...extra })
  }
  return { root, routes, requests, origin, warnings, config, discover }
}

test('discovery combines namespace-aware sitemap indexes, rendered SPA links and hash routes', async t => {
  const s = await fixture(t)
  const outside = await fixture(t)
  s.routes.set('/', html(`<a href="/about#top">About</a><a href="/about/">Alias</a><a href="/guide/start?b=2&a=1">Guide</a>
    <a href="/#/settings">Hash route</a><a href="/asset.pdf">Asset</a><a href="/download" download>Download</a><a href="/logout">Logout</a>
    <a href="${outside.origin}/external">External</a><script>setTimeout(() => { const a=document.createElement('a');a.href='/dynamic';a.textContent='Dynamic';document.body.append(a) }, 30)</script>`))
  s.routes.set('/about', html('<a href="/deep">Deep</a><a href="/#intro">Home anchor</a>'))
  for (const route of ['/guide/start', '/dynamic', '/deep', '/sitemap-only']) s.routes.set(route, html('Page'))
  s.routes.set('/sitemap.xml', xml(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${s.origin}/maps/child.xml</loc></sitemap><sitemap><loc>${s.origin}/sitemap.xml</loc></sitemap><sitemap><loc>${outside.origin}/external.xml</loc></sitemap></sitemapindex>`))
  s.routes.set('/maps/child.xml', xml(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${s.origin}/sitemap-only?x=1&amp;y=2</loc></url><url><loc>${s.origin}/about</loc></url><url><loc>${outside.origin}/foreign</loc></url></urlset>`))
  const result = await s.discover()
  assert.deepEqual(new Set(result.pages), new Set(['/', '/about', '/guide/start?b=2&a=1', '/#/settings', '/dynamic', '/deep', '/sitemap-only?x=1&y=2']))
  assert.equal(result.limited, false)
  assert.equal(result.errors, 0)
  assert.equal(result.visited, 7)
  assert.deepEqual(outside.requests, [])
  assert.ok(!s.requests.includes('/logout') && !s.requests.includes('/download'))
})

test('discovery enforces page and link-depth limits', async t => {
  const s = await fixture(t)
  s.routes.set('/', html('<a href="/a">A</a>'))
  s.routes.set('/a', html('<a href="/b">B</a>'))
  s.routes.set('/b', html('<a href="/c">C</a>'))
  const byCount = await s.discover({ crawl: { maxPages: 2 } })
  assert.deepEqual(byCount.pages, ['/', '/a'])
  assert.equal(byCount.limited, true)
  assert.deepEqual(byCount.limitReasons, ['页面数超过 2'])
  const byDepth = await s.discover({ crawl: { maxDepth: 0 } })
  assert.deepEqual(byDepth.pages, ['/'])
  assert.equal(byDepth.limited, true)
  assert.deepEqual(byDepth.limitReasons, ['链接深度超过 0'])
  assert.ok(!s.requests.includes('/b'))
})

test('initial redirects set the final scan origin and later external redirects are excluded', async t => {
  const s = await fixture(t)
  const redirects = await fixture(t)
  redirects.routes.set('/entry', (_req, res) => { res.writeHead(302, { location: `${s.origin}/landing` }); res.end() })
  s.routes.set('/landing', html('<a href="/about">About</a><a href="/away">Away</a>'))
  s.routes.set('/about', html('About'))
  s.routes.set('/away', (_req, res) => { res.writeHead(302, { location: `${redirects.origin}/foreign` }); res.end() })
  const result = await s.discover({ serve: { url: `${redirects.origin}/entry` } })
  assert.equal(result.origin, s.origin)
  assert.deepEqual(result.pages, ['/landing', '/about'])
  assert.equal(result.errors, 1)
  assert.ok(result.skipped.some(item => item.url.endsWith('/away')))
  assert.ok(!redirects.requests.includes('/foreign'))
})

test('discovery reuses beforePage authentication for pages and sitemap requests', async t => {
  const s = await fixture(t)
  let hooks = 0
  s.routes.set('/', html('Home'))
  s.routes.set('/sitemap_index.xml', html('SPA fallback'))
  s.routes.set('/sitemap.xml', (req, res) => {
    res.writeHead(req.headers['x-lhkit-auth'] === 'yes' ? 200 : 401, { 'content-type': 'application/xml' })
    res.end(`<urlset><url><loc>${s.origin}/private</loc></url></urlset>`)
  })
  s.routes.set('/private', (req, res) => {
    res.writeHead(req.headers['x-lhkit-auth'] === 'yes' ? 200 : 401, { 'content-type': 'text/html' })
    res.end(html('Private page'))
  })
  const result = await s.discover({ beforePage: async ({ page }) => { hooks++; await page.setExtraHTTPHeaders({ 'x-lhkit-auth': 'yes' }) } })
  assert.deepEqual(result.pages, ['/', '/private'])
  assert.equal(result.errors, 0)
  assert.equal(hooks, 2)
})

test('same-origin sitemap redirects preserve relative locations and external redirects are blocked', async t => {
  const s = await fixture(t)
  const outside = await fixture(t)
  s.routes.set('/', html('Home'))
  s.routes.set('/sitemap.xml', (_req, res) => { res.writeHead(302, { location: '/maps/index.xml' }); res.end() })
  s.routes.set('/maps/index.xml', xml('<sitemapindex><sitemap><loc>leaf.xml.gz</loc></sitemap><sitemap><loc>outside.xml</loc></sitemap></sitemapindex>'))
  s.routes.set('/maps/leaf.xml.gz', { type: 'application/gzip', body: gzipSync('<urlset><url><loc>relative-only</loc></url></urlset>') })
  s.routes.set('/maps/relative-only', html('Sitemap only'))
  s.routes.set('/maps/outside.xml', (_req, res) => { res.writeHead(302, { location: `${outside.origin}/external.xml` }); res.end() })
  const result = await s.discover()
  assert.deepEqual(result.pages, ['/', '/maps/relative-only'])
  assert.equal(result.errors, 1)
  assert.ok(result.skipped.some(item => item.url.endsWith('/maps/outside.xml')))
  assert.deepEqual(outside.requests, [])
})

test('malformed sitemaps, output collisions and unavailable pages are recorded without overwrites', async t => {
  const s = await fixture(t)
  s.routes.set('/', html('<a href="/a?b=c">Query</a><a href="/a_b_c">Collision</a><a href="/missing">Missing</a><a href="/nested/page">Nested</a><a href="/nested//page">Alias</a>'))
  s.routes.set('/a', html('A'))
  s.routes.set('/nested/page', html('Nested'))
  s.routes.set('/nested//page', html('Filesystem alias'))
  s.routes.set('/sitemap.xml', xml('<urlset><url>'))
  const result = await s.discover()
  assert.deepEqual(result.pages, ['/', '/a?b=c', '/nested/page'])
  assert.equal(result.errors, 4)
  assert.ok(result.skipped.some(item => /XML/.test(item.reason)))
  assert.ok(result.skipped.some(item => item.url.endsWith('/a_b_c') && /目录/.test(item.reason)))
  assert.ok(result.skipped.some(item => item.url.endsWith('/missing') && /404/.test(item.reason)))
  assert.ok(result.skipped.some(item => item.url.endsWith('/nested//page') && /目录/.test(item.reason)))
})

test('aborting discovery interrupts an in-flight navigation and closes Chrome', async t => {
  const s = await fixture(t)
  const ac = new AbortController()
  s.routes.set('/', html('<a href="/slow">Slow</a>'))
  s.routes.set('/slow', () => {})
  const started = Date.now()
  await assert.rejects(s.discover({ beforePage: ({ url }) => { if (url.endsWith('/slow')) setTimeout(() => ac.abort(), 50) } }, { signal: ac.signal }), error => error.name === 'AbortError')
  assert.ok(Date.now() - started < 5000)
})

test('CLI discovers routes and writes a Lighthouse report for every page; explicit pages skip discovery', async t => {
  const s = await fixture(t)
  s.routes.set('/', html('<a href="/about">About</a>'))
  s.routes.set('/about', html('About'))
  s.routes.set('/catalog', html('Catalog'))
  s.routes.set('/sitemap.xml', xml(`<urlset><url><loc>${s.origin}/catalog</loc></url></urlset>`))
  const result = await cli(['scan', '--url', s.origin, '--name', 'auto', '--max-pages', '3', '--max-depth', '2'], s.root)
  const round = path.join(s.root, '.lhkit', 'runs', 'auto')
  const meta = await readJson(path.join(round, 'round.json'))
  assert.equal(meta.status, 'complete')
  assert.equal(meta.partial, false)
  assert.deepEqual(new Set(meta.pagesRequested), new Set(['/', '/about', '/catalog']))
  assert.equal(meta.discovery.visited, 3)
  assert.equal(meta.discovery.limited, false)
  assert.equal(meta.discovery.errors, 0)
  const analysis = await readJson(path.join(round, 'analysis.json'))
  assert.equal(analysis.pages.length, 3)
  assert.ok(analysis.pages.every(page => page.ok))
  for (const page of analysis.pages) {
    const report = await readJson(path.join(round, 'pages', page.slug, 'run-1', 'lighthouse.json'))
    assert.equal(report.requestedUrl, s.origin + page.page)
    await fs.access(path.join(round, 'pages', page.slug, 'run-1', 'lighthouse.html'))
  }
  assert.match(result.stdout, /自动发现完成：3 个页面/)
  assert.deepEqual(await fs.readdir(s.root), ['.lhkit'])
  s.requests.length = 0
  const manual = await cli(['scan', '/about', '--url', s.origin, '--name', 'manual'], s.root)
  assert.ok(!manual.stdout.includes('自动发现'))
  assert.ok(!s.requests.includes('/sitemap.xml'))
  assert.equal((await readJson(path.join(s.root, '.lhkit', 'runs', 'manual', 'round.json'))).discovery, undefined)
})

test('a discovery limit marks the CLI round partial and preserves an older complete round', async t => {
  const s = await fixture(t)
  s.routes.set('/', html('<a href="/a">A</a>'))
  s.routes.set('/a', html('A'))
  await fs.writeFile(path.join(s.root, 'lhkit.config.mjs'), "export default { serve: { url: 'http://localhost:1' }, crawl: { maxPages: 1 }, outDir: 'reports' }\n")
  const old = await createRound(path.join(s.root, 'reports'), {
    name: null, partial: false, pagesRequested: ['/'], meta: { origin: s.origin, status: 'complete', finishedAt: '2026-11-01T00:00:01.000Z' },
  }, new Date('2026-11-01T00:00:00.000Z'))
  await cli(['scan', '--url', s.origin], s.root)
  const ids = await fs.readdir(path.join(s.root, 'reports', 'runs'))
  assert.equal(ids.length, 2)
  assert.ok(ids.includes(old.meta.id))
  const current = ids.find(id => id !== old.meta.id)
  const meta = await readJson(path.join(s.root, 'reports', 'runs', current, 'round.json'))
  assert.equal(meta.status, 'complete')
  assert.equal(meta.partial, true)
  assert.equal(meta.discovery.limited, true)
})
