// 真实 Lighthouse 扫描一个本地小站（约 2–3 分钟）。运行：npm run test:e2e
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { normalizeConfig } from '../../src/config.mjs'
import { loadTimedOut } from '../../src/docs/format.mjs'
import { createRound } from '../../src/round.mjs'
import { scanRound } from '../../src/scan.mjs'

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>t</title></head><body><h1>Hello</h1><p>Some text for the largest paint.</p>
<script>const n = Number(localStorage.getItem('visits') || 0); localStorage.setItem('visits', n + 1); fetch('/seen?n=' + n)</script></body></html>`

async function site() {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/seen') {
      seen.push(Number(url.searchParams.get('n')))
      return res.end('ok')
    }
    if (url.pathname === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' })
      return res.end('<h1>nope</h1>')
    }
    if (url.pathname === '/old') {
      res.writeHead(302, { location: '/new' })
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, seen, origin: `http://localhost:${server.address().port}` }
}

const silent = { info() {}, warn() {} }

async function setup(raw, pages) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-scan-'))
  const config = normalizeConfig({ serve: { url: 'http://unused' }, pages, ...raw }, root, path.join(root, 'lhkit.config.mjs'))
  const round = await createRound(config.outDir, { name: null, partial: false, pagesRequested: pages })
  return { config, round }
}

test('scan writes json, html and summary per page and picks the median run', async () => {
  const s = await site()
  try {
    const { config, round } = await setup({ runs: 3 }, ['/a'])
    const out = await scanRound({ config, origin: s.origin, roundDir: round.dir, meta: round.meta, pages: config.pages, log: silent })
    const [p] = out.pages
    assert.equal(p.ok, true)
    assert.equal(p.runs.length, 3)
    for (const n of [1, 2, 3]) {
      await fs.access(path.join(round.dir, 'pages/a', `run-${n}`, 'lighthouse.json'))
      await fs.access(path.join(round.dir, 'pages/a', `run-${n}`, 'lighthouse.html'))
    }
    const perfs = p.runs.map((r) => r.scores.perf)
    const med = [...perfs].sort((x, y) => x - y)[1]
    assert.equal(p.median.scores.perf, med)
    const rep = p.runs.find((r) => r.index === p.representative)
    assert.ok(perfs.every((v) => Math.abs(rep.scores.perf - med) <= Math.abs(v - med)))
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(round.dir, 'pages/a/summary.json'), 'utf8')), p)
    assert.equal(out.meta.status, 'complete')
    assert.equal(out.meta.origin, s.origin)
    assert.match(out.meta.lighthouseVersion, /^13\./)
    assert.ok(out.meta.finishedAt)
    assert.ok(p.median.scores.agentic && p.median.scores.agentic.total > 0)
  } finally {
    s.server.close()
  }
})

test('first visit uses a fresh profile per run; repeat visit warms up then keeps storage', async () => {
  const s = await site()
  try {
    const first = await setup({ runs: 2 }, ['/a'])
    await scanRound({ config: first.config, origin: s.origin, roundDir: first.round.dir, meta: first.round.meta, pages: first.config.pages, log: silent })
    assert.ok(s.seen.length >= 2 && s.seen.every((n) => n === 0), `first visits saw ${s.seen}`)
    s.seen.length = 0
    const repeat = await setup({ visit: 'repeat' }, ['/a'])
    await scanRound({ config: repeat.config, origin: s.origin, roundDir: repeat.round.dir, meta: repeat.round.meta, pages: repeat.config.pages, log: silent })
    assert.equal(s.seen[0], 0, 'warm-up is the first visit')
    assert.ok(s.seen.slice(1).length >= 1 && s.seen.slice(1).every((n) => n >= 1), `scanned visit saw ${s.seen}`)
  } finally {
    s.server.close()
  }
})

test('beforePage runs before every navigation, with warmup true on the warm-up', async () => {
  const s = await site()
  try {
    const calls = []
    const { config, round } = await setup({ visit: 'repeat', beforePage: async ({ url, warmup, page }) => calls.push({ url, warmup, hasPage: !!page }) }, ['/a'])
    await scanRound({ config, origin: s.origin, roundDir: round.dir, meta: round.meta, pages: config.pages, log: silent })
    assert.deepEqual(calls, [{ url: `${s.origin}/a`, warmup: true, hasPage: true }, { url: `${s.origin}/a`, warmup: false, hasPage: true }])
  } finally {
    s.server.close()
  }
})

test('a failed page is recorded and the round is not pruned', async () => {
  const s = await site()
  try {
    const { config, round } = await setup({}, ['/missing', '/a'])
    const out = await scanRound({ config, origin: s.origin, roundDir: round.dir, meta: round.meta, pages: config.pages, log: silent })
    const missing = out.pages.find((p) => p.page === '/missing')
    assert.equal(missing.ok, false)
    assert.ok(missing.error)
    assert.equal(missing.median, null)
    assert.equal(out.pages.find((p) => p.page === '/a').ok, true, 'the other page is still scanned')
    assert.equal(out.meta.status, 'failed-pages')
    assert.deepEqual(out.meta.failedPages, ['/missing'])
  } finally {
    s.server.close()
  }
})

test('a redirected page records its final url', async () => {
  const s = await site()
  try {
    const { config, round } = await setup({}, ['/old'])
    const out = await scanRound({ config, origin: s.origin, roundDir: round.dir, meta: round.meta, pages: config.pages, log: silent })
    assert.equal(new URL(out.pages[0].finalUrl).pathname, '/new')
  } finally {
    s.server.close()
  }
})

test('scan stops when the signal aborts and returns status aborted', async () => {
  const s = await site()
  try {
    const { config, round } = await setup({}, ['/a', '/b', '/c'])
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 1500)
    const started = Date.now()
    const out = await scanRound({ config, origin: s.origin, roundDir: round.dir, meta: round.meta, pages: config.pages, log: silent, signal: ac.signal })
    assert.equal(out.meta.status, 'aborted')
    assert.ok(Date.now() - started < 20000, 'stops without scanning every page')
  } finally {
    s.server.close()
  }
})

test('a page that never finishes loading is kept but flagged with Lighthouse’s warning', async () => {
  const hang = http.createServer((req, res) => {
    if (req.url.startsWith('/slow.png')) return // never answers
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>t</title></head><body><h1>Hi</h1><img src="/slow.png" alt=""></body></html>')
  })
  await new Promise((r) => hang.listen(0, '127.0.0.1', r))
  try {
    const { config, round } = await setup({}, ['/'])
    const out = await scanRound({ config, origin: `http://localhost:${hang.address().port}`, roundDir: round.dir, meta: round.meta, pages: config.pages, log: silent, maxWaitForLoad: 5000 })
    const [p] = out.pages
    assert.equal(p.ok, true)
    assert.ok(p.warnings.length > 0, 'the load-timeout warning is kept')
    assert.ok(loadTimedOut(p), `recognised as a load timeout: ${p.warnings.join(' / ')}`)
  } finally {
    hang.closeAllConnections()
    hang.close()
  }
})
