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
  ai-export [轮次]                       导出当前助手可分析的证据与源码任务，不调用 API
  ai-import <回答文件> [轮次]             校验并写回助手建议，重新生成报告，不调用 API

通用参数：
  --config <dir>                         指定配置目录（默认当前目录）
  -h, --help                             显示帮助
  -v, --version                          显示版本

直接扫描（无需配置文件）：
  lhkit scan --url https://example.com
  lhkit scan --url https://example.com --max-pages 100 --max-depth 5
  lhkit scan /about --url https://example.com --runs 3
  有配置时沿用项目设置，--url / --runs / 页面参数优先；URL 模式跳过构建和起服务。

自动发现（未指定命令行页面或配置 pages 时）：
  从入口、sitemap 和渲染后的站内链接发现同源页面，逐页扫描。
  --max-pages N                         最多发现页面数（默认 50）
  --max-depth N                         站内链接最大深度（默认 3，可为 0）
  显式指定页面（例如 scan / --url ...）只扫描该列表。

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
