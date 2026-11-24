import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gitInfo } from '../src/git.mjs'

test('untracked files do not make the tree dirty; changed tracked files do', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  await fs.writeFile(path.join(dir, 'a.txt'), 'a')
  git('add', 'a.txt')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'x')
  await fs.writeFile(path.join(dir, 'lhkit.config.mjs'), 'export default {}')
  const clean = gitInfo(dir)
  assert.match(clean.commit, /^[0-9a-f]{40}$/)
  assert.equal(clean.dirty, false)
  await fs.writeFile(path.join(dir, 'a.txt'), 'b')
  assert.equal(gitInfo(dir).dirty, true)
  assert.equal(gitInfo(os.tmpdir()), null, 'not a repository')
})
