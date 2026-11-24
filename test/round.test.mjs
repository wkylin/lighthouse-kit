import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigError } from '../src/config.mjs'
import { createRound, pageSlug, pruneRounds, readRoundMeta, resolveRound, writeRoundMeta } from '../src/round.mjs'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-round-'))
const at = (s) => new Date(2026, 10, 24, 21, 30, s)

async function finish(round, status) {
  const meta = { ...round.meta, status, finishedAt: new Date().toISOString() }
  await writeRoundMeta(round.dir, meta)
  return meta
}

test('slug', () => {
  assert.equal(pageSlug('/m/home'), 'm/home')
  assert.equal(pageSlug('/'), 'root')
  assert.equal(pageSlug('/a?b=1'), 'a_b_1')
})

test('unnamed round dir is a local timestamp, named round uses the name, bad names are ConfigError', async () => {
  const out = await tmp()
  const a = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(1))
  assert.equal(path.basename(a.dir), '20261124-213001')
  assert.equal(a.meta.status, 'running')
  assert.deepEqual(await readRoundMeta(a.dir), a.meta)
  const b = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(1))
  assert.equal(path.basename(b.dir), '20261124-213001-2', 'same second gets a suffix')
  const named = await createRound(out, { name: 'base', partial: false, pagesRequested: ['/'] }, at(2))
  assert.equal(path.basename(named.dir), 'base')
  assert.equal(named.meta.name, 'base')
  await assert.rejects(createRound(out, { name: 'base', partial: false, pagesRequested: ['/'] }, at(3)), ConfigError)
  for (const bad of ['../x', 'a/b', '', '.hidden'])
    await assert.rejects(createRound(out, { name: bad, partial: false, pagesRequested: ['/'] }, at(4)), ConfigError, bad)
})

test('prune keeps named, partial, failed and the current round', async () => {
  const out = await tmp()
  const old1 = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(1))
  await finish(old1, 'complete')
  const old2 = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(2))
  await finish(old2, 'complete')
  const named = await createRound(out, { name: 'base', partial: false, pagesRequested: ['/'] }, at(3))
  await finish(named, 'complete')
  const partial = await createRound(out, { name: null, partial: true, pagesRequested: ['/'] }, at(4))
  await finish(partial, 'complete')
  const failed = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(5))
  await finish(failed, 'failed-pages')
  const current = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(6))
  const meta = await finish(current, 'complete')
  const removed = await pruneRounds(out, 'latest', meta)
  assert.deepEqual(removed.map((d) => path.basename(d)).sort(), ['20261124-213001', '20261124-213002'])
  const left = (await fs.readdir(path.join(out, 'runs'))).sort()
  assert.deepEqual(left, ['20261124-213004', '20261124-213005', '20261124-213006', 'base'])
})

test('prune with keep 3 keeps the three newest complete unnamed rounds', async () => {
  const out = await tmp()
  let meta
  for (let s = 1; s <= 5; s++) meta = await finish(await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(s)), 'complete')
  await pruneRounds(out, 3, meta)
  assert.deepEqual((await fs.readdir(path.join(out, 'runs'))).sort(), ['20261124-213003', '20261124-213004', '20261124-213005'])
})

test('prune does nothing when the current round is not complete', async () => {
  const out = await tmp()
  await finish(await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(1)), 'complete')
  for (const status of ['failed-pages', 'aborted', 'running']) {
    const cur = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(10))
    const meta = await finish(cur, status)
    assert.deepEqual(await pruneRounds(out, 'latest', meta), [], status)
  }
  assert.ok((await fs.readdir(path.join(out, 'runs'))).includes('20261124-213001'))
})

test('resolveRound finds by name, by directory, defaults to the latest finished round, and rejects unknown names', async () => {
  const out = await tmp()
  const a = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(1))
  await finish(a, 'complete')
  const b = await createRound(out, { name: 'new', partial: false, pagesRequested: ['/'] }, at(2))
  await finish(b, 'failed-pages')
  const running = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(3))
  assert.equal(await resolveRound(out, 'new'), b.dir)
  assert.equal(await resolveRound(out, a.dir), a.dir)
  assert.equal(await resolveRound(out, undefined), b.dir, 'a running round is not finished')
  await assert.rejects(resolveRound(out, 'missing'), ConfigError)
  assert.ok(running.dir)
})

test('a named or partial current round never prunes the unnamed full rounds', async () => {
  const out = await tmp()
  await finish(await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(1)), 'complete')
  const named = await finish(await createRound(out, { name: 'base', partial: false, pagesRequested: ['/'] }, at(2)), 'complete')
  assert.deepEqual(await pruneRounds(out, 'latest', named), [])
  const partial = await finish(await createRound(out, { name: null, partial: true, pagesRequested: ['/'] }, at(3)), 'complete')
  assert.deepEqual(await pruneRounds(out, 'latest', partial), [])
  assert.ok((await fs.readdir(path.join(out, 'runs'))).includes('20261124-213001'))
})

test('prune only removes rounds that scanned the same target', async () => {
  const out = await tmp()
  const local = await createRound(out, { name: null, partial: false, pagesRequested: ['/'], meta: { origin: 'https://localhost:4443' } }, at(1))
  await finish(local, 'complete')
  const staging = await createRound(out, { name: null, partial: false, pagesRequested: ['/'], meta: { origin: 'https://staging.test' } }, at(2))
  const meta = await finish(staging, 'complete')
  assert.deepEqual(await pruneRounds(out, 'latest', meta), [])
  const local2 = await createRound(out, { name: null, partial: false, pagesRequested: ['/'], meta: { origin: 'https://localhost:4443' } }, at(3))
  assert.deepEqual((await pruneRounds(out, 'latest', await finish(local2, 'complete'))).map((d) => path.basename(d)), ['20261124-213001'])
})

test('an aborted named round can be run again under the same name; a finished one cannot', async () => {
  const out = await tmp()
  const first = await createRound(out, { name: 'base', partial: false, pagesRequested: ['/'] }, at(1))
  await fs.writeFile(path.join(first.dir, 'leftover.txt'), 'x')
  await finish(first, 'aborted')
  const again = await createRound(out, { name: 'base', partial: false, pagesRequested: ['/'] }, at(2))
  assert.equal(again.dir, first.dir)
  await assert.rejects(fs.access(path.join(again.dir, 'leftover.txt')), 'the aborted results are replaced')
  await finish(again, 'complete')
  await assert.rejects(createRound(out, { name: 'base', partial: false, pagesRequested: ['/'] }, at(3)), ConfigError)
  const running = await createRound(out, { name: 'live', partial: false, pagesRequested: ['/'] }, at(4))
  await assert.rejects(createRound(out, { name: 'live', partial: false, pagesRequested: ['/'] }, at(5)), (e) => /正在运行/.test(e.message))
  assert.ok(running.dir)
})

test('a hint names interrupted and unfinished rounds other than the current one', async () => {
  const { staleRoundsHint } = await import('../src/round.mjs')
  const out = await tmp()
  await finish(await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(1)), 'aborted')
  await createRound(out, { name: 'stuck', partial: false, pagesRequested: ['/'] }, at(2))
  await finish(await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(3)), 'complete')
  const current = await createRound(out, { name: null, partial: false, pagesRequested: ['/'] }, at(4))
  const hint = await staleRoundsHint(out, current.meta.id)
  assert.match(hint, /2 个/)
  assert.ok(hint.includes('20261124-213001') && hint.includes('stuck'))
  assert.equal(await staleRoundsHint(await tmp(), 'x'), null)
})
