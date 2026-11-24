import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.mjs'
import { installHint, writeConfigTemplate } from '../src/init.mjs'

const project = async (pkg, lock) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-init-'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg))
  if (lock) await fs.writeFile(path.join(dir, lock), '')
  return dir
}

test('the template is typed for editors without importing anything, and loads as a valid config', async () => {
  const dir = await project({ scripts: { build: 'vite build' } })
  const text = await fs.readFile(writeConfigTemplate(dir), 'utf8')
  assert.ok(text.includes("/** @type {import('lighthouse-kit').UserConfig} */\nexport default {"))
  assert.ok(!/^import /m.test(text), 'works with npx too, when lighthouse-kit is not installed in the project')
  assert.equal((await loadConfig(dir)).serve.mode, 'static')
})

test('init suggests adding lighthouse-kit to the project with its own package manager, unless it is already there', async () => {
  assert.equal(installHint(await project({}, 'pnpm-lock.yaml')), 'pnpm add -D lighthouse-kit')
  assert.equal(installHint(await project({}, 'yarn.lock')), 'yarn add -D lighthouse-kit')
  assert.equal(installHint(await project({})), 'npm install -D lighthouse-kit')
  assert.equal(installHint(await project({ devDependencies: { 'lighthouse-kit': '^0.1.0' } })), null)
  assert.equal(installHint(await project({ dependencies: { 'lighthouse-kit': 'link:../lighthouse-kit' } })), null)
})
