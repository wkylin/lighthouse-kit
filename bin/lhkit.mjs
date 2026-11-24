#!/usr/bin/env node
// lhkit 命令行入口。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { exitCodeFor, runCli } from '../src/cli.mjs'
import { createLogger } from '../src/log.mjs'

const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

export const HELP = `lhkit ${pkg.version} — 本地 Lighthouse 扫描、报告与问题文档

用法：lhkit <命令> [参数]

命令：
  init [--force]                         生成 lhkit.config.mjs 模板
  run [页面…] [--runs N] [--name X] [--url U] [--ai-dry-run]
                                         全流程：构建 → 起服务 → 扫描 → 分析 → 文档 → 打开总览
  build                                  只构建
  scan [页面…] [--runs N] [--name X] [--url U] [--ai-dry-run]
                                         不构建：起服务、扫描、分析、出文档，不打开浏览器
  analyze [轮次] [--ai-dry-run]           对已有轮次重新分析、重新生成文档
  preview [轮次]                          在浏览器打开总览
  compare <A> <B>                        对比两个轮次

通用参数：
  -h, --help                             显示帮助
  -v, --version                          显示版本

退出码：0 成功；1 运行失败；2 配置错误；3 端口占用或服务未就绪；4 部分页面失败
`

async function main(argv) {
  const [command] = argv
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (command === '-v' || command === '--version') {
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  const log = createLogger()
  try {
    return await runCli(argv, { log })
  } catch (error) {
    const code = error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 2 : exitCodeFor(error)
    log.error(error?.message ?? String(error))
    if (code === 2 && !String(error?.message).startsWith('配置错误')) process.stderr.write(`\n${HELP}`)
    return code
  }
}

process.exitCode = await main(process.argv.slice(2))
