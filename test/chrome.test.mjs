import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findChrome } from '../src/chrome.mjs'
import { ConfigError } from '../src/config.mjs'

test('findChrome prefers config.chromePath, then CHROME_PATH', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-chrome-'))
  const a = path.join(dir, 'a-chrome')
  const b = path.join(dir, 'b-chrome')
  await fs.writeFile(a, '')
  await fs.writeFile(b, '')
  assert.equal(findChrome({ chromePath: a }, { CHROME_PATH: b }), a)
  assert.equal(findChrome({ chromePath: null }, { CHROME_PATH: b }), b)
})

test('a configured path that does not exist is a ConfigError', () => {
  assert.throws(() => findChrome({ chromePath: '/nope/chrome' }, {}), ConfigError)
})
