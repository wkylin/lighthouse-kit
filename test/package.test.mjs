import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the package can be published: not private, MIT, points at its GitHub repository', () => {
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.name, 'lighthouse-kit')
  assert.equal(pkg.license, 'MIT')
  assert.match(pkg.repository.url, /github\.com\/wkylin\/lighthouse-kit/)
  assert.equal(pkg.bin.lhkit, 'bin/lhkit.mjs')
  assert.equal(pkg.scripts.prepublishOnly, 'npm test', 'unit tests run before every publish')
})

test('the published tarball has the CLI, the code and the config types, and no tests, docs or examples', () => {
  const [report] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  const files = report.files.map((f) => f.path)
  for (const f of ['bin/lhkit.mjs', 'src/cli.mjs', 'src/index.mjs', 'types/index.d.ts', 'skills/lighthouse-kit/SKILL.md', 'README.md', 'LICENSE', 'package.json']) assert.ok(files.includes(f), f)
  for (const f of files) assert.ok(!/^(test|docs|examples|\.superpowers|\.github)\//.test(f), `${f} should not be published`)
})

test('import { defineConfig } from "lighthouse-kit" returns the config unchanged', async () => {
  const { defineConfig } = await import('lighthouse-kit')
  const config = { serve: { static: 'dist' }, pages: ['/'] }
  assert.equal(defineConfig(config), config)
})
