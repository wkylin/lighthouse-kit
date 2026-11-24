// 测试共用：用真实报告夹具搭一个轮次目录。
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../src/config.mjs'

export const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url))
export const project = path.join(fixtures, 'project')

export const scores = { perf: 40, a11y: 90, bp: 100, seo: 83, agentic: { pass: 1, total: 4 } }
export const metrics = { fcp: 2000, lcp: 6000, tbt: 1000, cls: 0.01, si: 7000 }

/** 两页成功、一页失败的轮次目录。 */
export async function makeRound() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lhkit-analyze-'))
  const pages = [['/m/home', 'm/home', 'home.json'], ['/m/me/about-us', 'm/me/about-us', 'about-us.json']]
  const meta = { id: 'r1', name: null, partial: false, pagesRequested: ['/m/home', '/m/me/about-us', '/m/broken'], origin: 'https://localhost:4443',
    startedAt: '2026-11-24T13:00:00.000Z', finishedAt: '2026-11-24T13:05:00.000Z', status: 'failed-pages', failedPages: ['/m/broken'], lighthouseVersion: '13.5.0',
    visit: 'first', formFactor: 'mobile', runs: 1, git: null, buildFingerprint: null }
  await fs.writeFile(path.join(dir, 'round.json'), JSON.stringify(meta))
  for (const [page, slug, file] of pages) {
    await fs.mkdir(path.join(dir, 'pages', slug, 'run-1'), { recursive: true })
    await fs.copyFile(path.join(fixtures, file), path.join(dir, 'pages', slug, 'run-1', 'lighthouse.json'))
    const summary = { page, slug, ok: true, error: null, finalUrl: `https://localhost:4443${page}`, runs: [{ index: 1, ok: true, error: null, scores, metrics }],
      representative: 1, median: { scores, metrics } }
    await fs.writeFile(path.join(dir, 'pages', slug, 'summary.json'), JSON.stringify(summary))
  }
  await fs.mkdir(path.join(dir, 'pages', 'm/broken'), { recursive: true })
  await fs.writeFile(path.join(dir, 'pages', 'm/broken', 'summary.json'), JSON.stringify({ page: '/m/broken', slug: 'm/broken', ok: false, error: '页面加载超时',
    finalUrl: null, runs: [{ index: 1, ok: false, error: '页面加载超时', scores: null, metrics: null }], representative: null, median: null }))
  return dir
}

export const config = normalizeConfig({ serve: { url: 'https://localhost:4443' }, pages: ['/m/home'], sourceMap: { manifest: 'build/.vite/manifest.json', maps: 'build' } },
  project, path.join(project, 'lhkit.config.mjs'))

