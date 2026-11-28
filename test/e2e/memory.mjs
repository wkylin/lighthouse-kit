import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { normalizeConfig } from '../../src/config.mjs'
import { createRound } from '../../src/round.mjs'
import { scanRound } from '../../src/scan.mjs'

const lighthouseRequire = createRequire(import.meta.resolve('lighthouse'))
const { stackTraceForEventInTrace } = await import(pathToFileURL(lighthouseRequire.resolve('@paulirish/trace_engine/models/trace/extras/StackTraceForEvent.js')).href)

test('sequential scans release trace stack caches between runs and after the last run', async () => {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cache lifecycle</title></head>
<body><h1>Trace cache lifecycle</h1><div id="box">Layout</div><script>
function forceLayout() { const box=document.getElementById('box'); for(let i=0;i<2000;i++){box.style.paddingLeft=(i%20)+'px';void box.offsetHeight;} }
forceLayout();</script></body></html>`
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-memory-test-'))
  const observed = []
  let cacheWrites = 0
  const originalSet = stackTraceForEventInTrace.set
  stackTraceForEventInTrace.clear()
  stackTraceForEventInTrace.set = function (...args) { cacheWrites++; return originalSet.apply(this, args) }
  try {
    const origin = `http://localhost:${server.address().port}`
    const config = normalizeConfig({ serve: { url: origin }, pages: ['/'], runs: 3, beforePage: async () => observed.push(stackTraceForEventInTrace.size) }, root, path.join(root, 'lhkit.config.mjs'))
    const round = await createRound(config.outDir, { name: null, partial: false, pagesRequested: ['/'] })
    const result = await scanRound({ config, origin, roundDir: round.dir, meta: round.meta, pages: ['/'], log: { info() {} } })
    assert.ok(result.pages[0].runs.every(run => run.ok), 'all three real Lighthouse scans must finish')
    assert.ok(cacheWrites >= 3, 'the page must exercise the real forced-reflow stack cache')
    assert.deepEqual(observed, [0, 0, 0], 'completed traces must not survive into the next scan')
    assert.equal(stackTraceForEventInTrace.size, 0, 'the final trace must also be released')
  } finally {
    stackTraceForEventInTrace.set = originalSet
    stackTraceForEventInTrace.clear()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
})
