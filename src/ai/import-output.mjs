// 按轮次串行导入；先生成完整产物，再替换，安装失败则恢复原文件。
import fs from 'node:fs/promises'
import path from 'node:path'
import { ConfigError } from '../config.mjs'

export async function withImportLock(roundDir, action) {
  const file = path.join(roundDir, '.ai-import.lock')
  const deadline = Date.now() + 10000
  let handle
  while (!handle) {
    try { handle = await fs.open(file, 'wx') } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new ConfigError(`配置错误：导入锁仍被占用：${file}。请稍后重试；确认没有其他导入进程后可删除遗留锁文件`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }))
    return await action()
  } finally {
    await handle.close()
    await fs.unlink(file)
  }
}

export async function stageImportOutputs(roundDir, config, render) {
  const stage = await fs.mkdtemp(path.join(roundDir, '.ai-import-'))
  const states = []
  let keepBackup = false
  try {
    const oldDocs = path.join(roundDir, 'docs')
    const stat = await fs.lstat(oldDocs).catch((error) => { if (error.code !== 'ENOENT') throw error; return null })
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`文档目录必须是实际目录：${oldDocs}`)
      await fs.cp(oldDocs, path.join(stage, 'docs'), { recursive: true, dereference: false, verbatimSymlinks: true })
      // 保留其他文档，但不跟随既有生成文件上的符号链接写入。
      for (const audience of config.docs.audiences) for (const ext of ['md', 'html'])
        await fs.rm(path.join(stage, 'docs', `${audience}.${ext}`), { recursive: true, force: true })
    }
    const output = await render(stage)
    const backup = path.join(stage, '.backup')
    await fs.mkdir(backup)
    for (const name of ['docs', 'index.html', 'analysis.json']) {
      const state = { name, backed: false, installed: false }
      states.push(state)
      try {
        await fs.rename(path.join(roundDir, name), path.join(backup, name))
        state.backed = true
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await fs.rename(path.join(stage, name), path.join(roundDir, name))
      state.installed = true
    }
    return { ...output, docs: output.docs.map((file) => path.join(roundDir, path.relative(stage, file))), index: path.join(roundDir, 'index.html') }
  } catch (error) {
    try {
      for (const state of states.reverse()) {
        if (state.installed) await fs.rm(path.join(roundDir, state.name), { recursive: true, force: true })
        if (state.backed) await fs.rename(path.join(stage, '.backup', state.name), path.join(roundDir, state.name))
      }
    } catch (rollbackError) {
      keepBackup = true
      throw new Error(`导入失败且无法完整回滚，备份保留在 ${stage}：${rollbackError.message}`, { cause: error })
    }
    throw error
  } finally {
    if (!keepBackup) await fs.rm(stage, { recursive: true, force: true })
  }
}
