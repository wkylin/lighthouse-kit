import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import { createLogger } from '../src/log.mjs'

test('a logger with a file keeps every line it prints', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-log-'))
  const sink = new Writable({ write: (_c, _e, cb) => cb() })
  const log = createLogger({ out: sink, err: sink })
  const file = path.join(dir, 'logs', 'scan.log')
  const tee = log.withFile(file)
  tee.info('/m/home  性能 45')
  tee.warn('1 个页面扫描失败')
  tee.error('出错了')
  const text = await fs.readFile(file, 'utf8')
  assert.match(text, /\/m\/home {2}性能 45/)
  assert.match(text, /警告：1 个页面扫描失败/)
  assert.match(text, /错误：出错了/)
})
