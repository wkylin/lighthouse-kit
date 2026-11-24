import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { appendHistory, comparableBaseline, historyEntryFromRound, readHistory, trend } from '../src/history.mjs'

const scores = { perf: 40, a11y: 90, bp: 100, seo: 83, agentic: { pass: 1, total: 4 } }
const metrics = { fcp: 2000, lcp: 6000, tbt: 1000, cls: 0.01, si: 7000 }

function entry(id, finishedAt, over = {}) {
  return {
    roundId: id, name: null, partial: false, origin: 'https://localhost:4443', lighthouseVersion: '13.5.0', visit: 'first', formFactor: 'mobile', runs: 1,
    git: null, buildFingerprint: null, finishedAt, pages: { '/m/home': { scores, metrics }, '/m/live': { scores, metrics } }, ...over,
  }
}

test('historyEntryFromRound keeps median scores and metrics of the pages that succeeded', () => {
  const meta = { id: 'r1', name: 'base', partial: false, pagesRequested: ['/a', '/b'], origin: 'http://x', startedAt: 's', finishedAt: '2026-11-24T00:00:00.000Z',
    status: 'failed-pages', failedPages: ['/b'], lighthouseVersion: '13.5.0', visit: 'first', formFactor: 'mobile', runs: 3, git: { commit: 'abc', dirty: false }, buildFingerprint: 'f' }
  const pages = [
    { page: '/a', slug: 'a', ok: true, error: null, finalUrl: 'http://x/a', runs: [], representative: 1, median: { scores, metrics } },
    { page: '/b', slug: 'b', ok: false, error: 'boom', finalUrl: null, runs: [], representative: null, median: null },
  ]
  const e = historyEntryFromRound(meta, pages)
  assert.deepEqual(e, { roundId: 'r1', name: 'base', partial: false, origin: 'http://x', lighthouseVersion: '13.5.0', visit: 'first', formFactor: 'mobile', runs: 3,
    git: { commit: 'abc', dirty: false }, buildFingerprint: 'f', finishedAt: '2026-11-24T00:00:00.000Z', pages: { '/a': { scores, metrics } } })
})

test('append and read history in finishing order', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-history-'))
  await appendHistory(out, entry('b', '2026-11-24T02:00:00.000Z'))
  await appendHistory(out, entry('a', '2026-11-24T01:00:00.000Z'))
  assert.deepEqual((await readHistory(out)).map((e) => e.roundId), ['a', 'b'])
  assert.deepEqual(await readHistory(path.join(out, 'nothing-here')), [])
})

test('comparable baseline needs same origin, lighthouse major, visit and formFactor, and skips partial rounds', () => {
  const current = entry('now', '2026-11-24T10:00:00.000Z')
  const good = entry('good', '2026-11-24T05:00:00.000Z', { lighthouseVersion: '13.4.1', git: { commit: 'x', dirty: true } })
  const others = [
    entry('origin', '2026-11-24T06:00:00.000Z', { origin: 'https://staging.test' }),
    entry('major', '2026-11-24T07:00:00.000Z', { lighthouseVersion: '12.8.2' }),
    entry('visit', '2026-11-24T08:00:00.000Z', { visit: 'repeat' }),
    entry('pages', '2026-11-24T08:30:00.000Z', { pages: { '/m/home': { scores, metrics } } }),
    entry('partial', '2026-11-24T09:00:00.000Z', { partial: true }),
    entry('later', '2026-11-24T11:00:00.000Z'),
  ]
  assert.equal(comparableBaseline([good, ...others, current], current).roundId, 'pages', 'a different page list is still comparable (pages are compared where both have them)')
  assert.equal(comparableBaseline([good, ...others.filter((e) => e.roundId !== 'pages'), current], current).roundId, 'good')
  assert.equal(comparableBaseline([...others.filter((e) => e.roundId !== 'pages'), current], current), null)
  assert.equal(comparableBaseline([good, current], { ...current, partial: true }), null, 'a partial round has no baseline')
})

test('trend returns up to 6 comparable entries ending with the current one', () => {
  const list = []
  for (let h = 1; h <= 8; h++) list.push(entry(`r${h}`, `2026-11-24T0${h}:00:00.000Z`))
  list.push(entry('odd', '2026-11-24T08:30:00.000Z', { origin: 'https://other.test' }))
  const current = entry('now', '2026-11-24T09:00:00.000Z')
  assert.deepEqual(trend([...list, current], current).map((e) => e.roundId), ['r4', 'r5', 'r6', 'r7', 'r8', 'now'])
  assert.deepEqual(trend([...list], current, 3).map((e) => e.roundId), ['r7', 'r8', 'now'], 'current is appended when missing from the list')
  assert.deepEqual(trend(list, { ...current, partial: true }), [])
})
