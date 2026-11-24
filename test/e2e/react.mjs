// React + Vite 示例：构建、托管、扫描、分析，证明工具与框架无关（约 1 分钟；首次会 npm install）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../../bin/lhkit.mjs', import.meta.url))
const EXAMPLE = fileURLToPath(new URL('../../examples/react-vite', import.meta.url))
const run = (cmd, args) => spawnSync(cmd, args, { cwd: EXAMPLE, encoding: 'utf8', env: { ...process.env, LHKIT_NO_OPEN: '1' }, timeout: 300000 })

test('lhkit builds, serves and scans the React example and maps findings to src/', () => {
  if (!fs.existsSync(path.join(EXAMPLE, 'node_modules'))) assert.equal(run('npm', ['install', '--no-audit', '--no-fund']).status, 0)
  fs.rmSync(path.join(EXAMPLE, '.lhkit'), { recursive: true, force: true })
  const build = run(process.execPath, [BIN, 'build'])
  assert.equal(build.status, 0, build.stderr)
  const maps = fs.readdirSync(path.join(EXAMPLE, 'dist/assets')).filter((f) => f.endsWith('.js.map'))
  assert.ok(maps.length > 0, 'hidden source maps were written')
  const scan = run(process.execPath, [BIN, 'scan'])
  assert.equal(scan.status, 0, scan.stdout + scan.stderr)
  const [id] = fs.readdirSync(path.join(EXAMPLE, '.lhkit/runs'))
  const round = path.join(EXAMPLE, '.lhkit/runs', id)
  for (const f of ['index.html', 'docs/dev.md', 'docs/lead.md', 'pages/root/run-1/lighthouse.html', 'pages/about/run-1/lighthouse.html'])
    assert.ok(fs.existsSync(path.join(round, f)), f)
  const analysis = JSON.parse(fs.readFileSync(path.join(round, 'analysis.json'), 'utf8'))
  const sources = analysis.findings.flatMap((f) => f.evidence).map((e) => e.source?.file).filter(Boolean)
  assert.ok(sources.some((f) => f.startsWith('src/')), `mapped sources: ${[...new Set(sources)].join(', ')}`)
  assert.ok(fs.readFileSync(path.join(round, 'docs/dev.md'), 'utf8').includes('`src/'), 'the dev doc names a source file')
})
