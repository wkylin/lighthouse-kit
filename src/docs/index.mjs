// 按配置写出开发版、负责人版文档（Markdown + HTML）。
import fs from 'node:fs/promises'
import path from 'node:path'
import { renderDevDoc } from './dev.mjs'
import { markdownToHtmlPage } from './html.mjs'
import { renderLeadDoc } from './lead.mjs'

const TITLES = { dev: '性能问题清单（开发版）', lead: '性能概况（负责人版）' }

/**
 * @param {string} roundDir
 * @param {import('../types.mjs').Analysis} analysis
 * @param {import('../types.mjs').Config} config
 * @param {{baseline: import('../types.mjs').HistoryEntry|null, trend: import('../types.mjs').HistoryEntry[]}} ctx
 * @returns {Promise<string[]>} 写出的文件
 */
export async function writeDocs(roundDir, analysis, config, ctx) {
  const dir = path.join(roundDir, 'docs')
  await fs.mkdir(dir, { recursive: true })
  const written = []
  for (const audience of config.docs.audiences) {
    const markdown = audience === 'dev' ? renderDevDoc(analysis) : renderLeadDoc(analysis, ctx)
    const mdFile = path.join(dir, `${audience}.md`)
    const htmlFile = path.join(dir, `${audience}.html`)
    await fs.writeFile(mdFile, markdown)
    await fs.writeFile(htmlFile, markdownToHtmlPage(markdown, TITLES[audience]))
    written.push(mdFile, htmlFile)
  }
  return written
}
