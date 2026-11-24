// 两个轮次逐页对比：分数与核心指标的变化（取每页的中位数）。
import fs from 'node:fs/promises'
import path from 'node:path'
import { markdownToHtmlPage } from './docs/html.mjs'
import { VISIT_LABELS, cell, fmtCls, fmtMs, fmtS, fmtScore, fmtTime, median, redirectedTo, signed } from './docs/format.mjs'
import { pageSlug, readRoundMeta, resolveRound } from './round.mjs'

async function readSummary(dir, page) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'pages', pageSlug(page), 'summary.json'), 'utf8'))
  } catch {
    return null
  }
}

const label = (meta) => meta.name ?? meta.id
const major = (v) => String(v ?? '').split('.')[0]

function describe(meta) {
  const git = meta.git ? `，提交 ${meta.git.commit.slice(0, 7)}${meta.git.dirty ? '（有未提交改动）' : ''}` : ''
  return `${label(meta)}：${meta.origin}，Lighthouse ${meta.lighthouseVersion}，${VISIT_LABELS[meta.visit] ?? meta.visit}，每页 ${meta.runs} 次，${fmtTime(meta.finishedAt)}${git}`
}

function differences(a, b) {
  const diff = []
  if (a.origin !== b.origin) diff.push(`目标地址（${a.origin} / ${b.origin}）`)
  if (major(a.lighthouseVersion) !== major(b.lighthouseVersion)) diff.push(`Lighthouse 版本（${a.lighthouseVersion} / ${b.lighthouseVersion}）`)
  if (a.visit !== b.visit) diff.push(`访问方式（${VISIT_LABELS[a.visit] ?? a.visit} / ${VISIT_LABELS[b.visit] ?? b.visit}）`)
  if (a.formFactor !== b.formFactor) diff.push(`设备（${a.formFactor} / ${b.formFactor}）`)
  if (a.runs !== b.runs) diff.push(`每页次数（${a.runs} / ${b.runs}）`)
  return diff
}

/** 单个轮次自身的问题：只扫了部分页面、中途中断、没有正常结束。（有页面失败的在文末单独列出。） */
function caveats(meta) {
  const out = []
  if (meta.partial) out.push(`${label(meta)} 只扫了部分页面`)
  if (meta.status === 'aborted') out.push(`${label(meta)} 中途中断，结果不完整`)
  else if (meta.status === 'running') out.push(`${label(meta)} 没有正常结束，结果可能不完整`)
  return out
}

function row(name, x, y) {
  const d = (p, q) => (p == null || q == null ? null : q - p)
  const dPerf = d(x.perf, y.perf)
  const dLcp = d(x.lcp, y.lcp)
  const dTbt = d(x.tbt, y.tbt)
  const dCls = d(x.cls, y.cls)
  return `| ${cell(name)} | ${fmtScore(x.perf)} → ${fmtScore(y.perf)} | ${signed(dPerf)} | ${fmtS(x.lcp)} → ${fmtS(y.lcp)} | ${dLcp == null ? '–' : `${signed(dLcp / 1000, 1)} s`} | ${fmtMs(x.tbt)} → ${fmtMs(y.tbt)} | ${dTbt == null ? '–' : `${signed(dTbt)} ms`} | ${fmtCls(x.cls)} → ${fmtCls(y.cls)} | ${dCls == null ? '–' : signed(dCls, 3)} |`
}

const flat = (m) => ({ perf: m.scores.perf, lcp: m.metrics.lcp, tbt: m.metrics.tbt, cls: m.metrics.cls })

/**
 * @param {string} outDir
 * @param {string} a 轮次名称或目录（基准）
 * @param {string} b 轮次名称或目录（对比对象）
 * @returns {Promise<{md: string, mdPath: string, htmlPath: string}>}
 */
export async function compareRounds(outDir, a, b) {
  const [dirA, dirB] = [await resolveRound(outDir, a), await resolveRound(outDir, b)]
  const [metaA, metaB] = [await readRoundMeta(dirA), await readRoundMeta(dirB)]
  const [la, lb] = [label(metaA), label(metaB)]
  const lines = [`# 轮次对比：${la} → ${lb}`, '', `- ${describe(metaA)}`, `- ${describe(metaB)}`, '']
  const diff = differences(metaA, metaB)
  const notes = [...(diff.length ? [`两轮的${diff.join('、')}不同，分数不能直接比较`] : []), ...caveats(metaA), ...caveats(metaB)]
  if (notes.length) lines.push(`> 注意：${notes.join('；')}。`, '')
  const both = []
  const failed = []
  for (const page of metaA.pagesRequested.filter((p) => metaB.pagesRequested.includes(p))) {
    const [sa, sb] = [await readSummary(dirA, page), await readSummary(dirB, page)]
    if (sa?.ok && sa.median && sb?.ok && sb.median) {
      const to = redirectedTo(sb, metaB.origin) ?? redirectedTo(sa, metaA.origin)
      both.push({ page: to ? `${page}（跳转到 ${to}）` : page, x: flat(sa.median), y: flat(sb.median) })
    }
    else failed.push(page)
  }
  if (both.length) {
    lines.push('| 页面 | 性能 | 变化 | LCP | 变化 | TBT | 变化 | CLS | 变化 |', '|---|---|---|---|---|---|---|---|---|')
    for (const r of both) lines.push(row(r.page, r.x, r.y))
    const med = (side, key) => median(both.map((r) => r[side][key]))
    const mx = { perf: med('x', 'perf'), lcp: med('x', 'lcp'), tbt: med('x', 'tbt'), cls: med('x', 'cls') }
    const my = { perf: med('y', 'perf'), lcp: med('y', 'lcp'), tbt: med('y', 'tbt'), cls: med('y', 'cls') }
    lines.push(row('中位数', mx, my), '')
  } else {
    lines.push('两轮没有都扫描成功的页面，无法逐页对比。', '')
  }
  const onlyA = metaA.pagesRequested.filter((p) => !metaB.pagesRequested.includes(p))
  const onlyB = metaB.pagesRequested.filter((p) => !metaA.pagesRequested.includes(p))
  if (onlyA.length) lines.push(`- 只在 ${la} 中：${onlyA.join('、')}`)
  if (onlyB.length) lines.push(`- 只在 ${lb} 中：${onlyB.join('、')}`)
  if (failed.length) lines.push(`- 有一轮扫描失败、未对比：${failed.join('、')}`)
  const md = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  const dir = path.join(outDir, 'compare')
  await fs.mkdir(dir, { recursive: true })
  const base = `${metaA.id}-vs-${metaB.id}`
  const mdPath = path.join(dir, `${base}.md`)
  const htmlPath = path.join(dir, `${base}.html`)
  await fs.writeFile(mdPath, md)
  await fs.writeFile(htmlPath, markdownToHtmlPage(md, `轮次对比：${la} → ${lb}`))
  return { md, mdPath, htmlPath }
}
