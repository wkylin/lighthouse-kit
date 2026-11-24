import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSourceResolver } from '../src/analyze/sourcemap.mjs'

const project = fileURLToPath(new URL('./fixtures/project', import.meta.url))
const manifest = path.join(project, 'build/.vite/manifest.json')
const maps = path.join(project, 'build')

test('vite manifest resolves a page chunk to its source file', async () => {
  const resolve = await createSourceResolver({ manifest, maps, root: project })
  assert.deepEqual(resolve('https://localhost:4443/js/MobileHome-Bg_GMbry.js'), { file: 'src/mobile/home/MobileHome.vue', share: 1 })
})

test('a manifest source that is not on disk is kept as written', async () => {
  const resolve = await createSourceResolver({ manifest, maps: null, root: project })
  assert.deepEqual(resolve('https://localhost:4443/js/MIHost-Dr2bGijs.js'), { file: 'src/mobile/instant/MIHost.vue', share: 1 })
})

test('a source map resolves to its largest source and its share', async () => {
  const resolve = await createSourceResolver({ manifest, maps, root: project })
  assert.deepEqual(resolve('https://localhost:4443/js/MBoard-q88wBfdR.js?v=1'), { file: 'src/mobile/ui/MBoard.vue', share: 0.6 })
})

test('a node_modules source resolves to the package name', async () => {
  const resolve = await createSourceResolver({ manifest, maps, root: project })
  assert.deepEqual(resolve('https://localhost:4443/js/vue-runtime-CXWO_RqQ.js'), { file: '@vue/runtime-core (node_modules)', share: 0.9 })
})

test('missing manifest and maps resolve to null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-maps-'))
  await fs.writeFile(path.join(dir, 'broken.json'), '{not json')
  await fs.mkdir(path.join(dir, 'js'))
  await fs.writeFile(path.join(dir, 'js/a-1.js.map'), 'nope')
  for (const opts of [
    { manifest: null, maps: null, root: dir },
    { manifest: path.join(dir, 'missing.json'), maps: path.join(dir, 'missing'), root: dir },
    { manifest: path.join(dir, 'broken.json'), maps: dir, root: dir },
  ]) {
    const resolve = await createSourceResolver(opts)
    assert.equal(resolve('https://localhost/js/a-1.js'), null)
    assert.equal(resolve('Unattributable'), null)
    assert.equal(resolve('https://localhost/'), null)
  }
})

test('manifest sources resolve from above the build output folder, not inside it', async () => {
  const resolve = await createSourceResolver({ manifest, maps: null, root: project })
  assert.deepEqual(resolve('https://localhost:4443/js/index-AAAA1111.js'), { file: 'index.html', share: 1 })
})

test('a source map wins over the manifest when both know the bundle', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-maps-'))
  await fs.mkdir(path.join(dir, 'out/.vite'), { recursive: true })
  await fs.mkdir(path.join(dir, 'out/js'))
  await fs.writeFile(path.join(dir, 'out/.vite/manifest.json'), JSON.stringify({ 'index.html': { file: 'js/main-1.js', src: 'index.html', isEntry: true } }))
  await fs.writeFile(path.join(dir, 'out/js/main-1.js.map'), JSON.stringify({ version: 3, sources: ['../../src/app.ts', '../../src/tiny.ts'], sourcesContent: ['a'.repeat(30), 'b'.repeat(10)], names: [], mappings: '' }))
  const resolve = await createSourceResolver({ manifest: path.join(dir, 'out/.vite/manifest.json'), maps: path.join(dir, 'out'), root: dir })
  assert.deepEqual(resolve('http://x/js/main-1.js'), { file: 'src/app.ts', share: 0.75 })
})

test('a URL with a literal % does not throw', async () => {
  const resolve = await createSourceResolver({ manifest, maps, root: project })
  assert.equal(resolve('http://x/img/100%.png'), null)
  assert.equal(resolve('http://x/js/%E0%A4%A.js'), null)
})

test('a page chunk keeps its own source file even when its map is mostly a dependency', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-maps-'))
  await fs.mkdir(path.join(dir, 'out/.vite'), { recursive: true })
  await fs.mkdir(path.join(dir, 'out/js'))
  await fs.mkdir(path.join(dir, 'src/pages'), { recursive: true })
  await fs.writeFile(path.join(dir, 'src/pages/Home.vue'), '')
  await fs.writeFile(path.join(dir, 'out/.vite/manifest.json'), JSON.stringify({ 'src/pages/Home.vue': { file: 'js/Home-1.js', src: 'src/pages/Home.vue', isDynamicEntry: true } }))
  await fs.writeFile(path.join(dir, 'out/js/Home-1.js.map'), JSON.stringify({ version: 3, sources: ['../../node_modules/chart.js/dist/chart.js', '../../src/pages/Home.vue'], sourcesContent: ['c'.repeat(90), 'h'.repeat(10)], names: [], mappings: '' }))
  const resolve = await createSourceResolver({ manifest: path.join(dir, 'out/.vite/manifest.json'), maps: path.join(dir, 'out'), root: dir })
  assert.deepEqual(resolve('http://x/js/Home-1.js'), { file: 'src/pages/Home.vue', share: 1 })
})

test('a site served under a base path still maps', async () => {
  const resolve = await createSourceResolver({ manifest, maps, root: project, basePath: '/app/' })
  assert.deepEqual(resolve('https://localhost:4443/app/js/MobileHome-Bg_GMbry.js'), { file: 'src/mobile/home/MobileHome.vue', share: 1 })
  assert.deepEqual(resolve('https://localhost:4443/app/js/MBoard-q88wBfdR.js'), { file: 'src/mobile/ui/MBoard.vue', share: 0.6 })
  assert.equal(resolve('https://cdn.example.com/js/MBoard-q88wBfdR.js'), null, 'a URL outside the base path is not ours')
})
