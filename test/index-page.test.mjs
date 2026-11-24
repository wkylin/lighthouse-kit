import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { analyzeRound } from '../src/analyze/index.mjs'
import { writeIndex } from '../src/report/index-page.mjs'
import { writeLighthouseHtml } from '../src/report/lighthouse-html.mjs'
import { config, makeRound } from './helpers.mjs'

test('index page links each page report and both docs, marks failed pages, shows Agentic as pass/total', async () => {
  const dir = await makeRound()
  const analysis = await analyzeRound(dir, config)
  const file = writeIndex(dir, analysis, ['dev', 'lead'])
  assert.equal(file, path.join(dir, 'index.html'))
  const html = await fs.readFile(file, 'utf8')
  assert.ok(html.includes('href="pages/m/home/run-1/lighthouse.html"'))
  assert.ok(html.includes('href="pages/m/me/about-us/run-1/lighthouse.html"'))
  assert.ok(html.includes('href="docs/dev.html"') && html.includes('href="docs/lead.html"'))
  assert.ok(html.includes('/m/broken') && html.includes('页面加载超时'))
  assert.ok(html.includes('>1/4<'), 'agentic shown as passed/total')
  assert.ok(html.includes('https://localhost:4443'))
  assert.ok(html.includes('prefers-color-scheme: dark'))
})

test('index page only links the docs that were generated', async () => {
  const dir = await makeRound()
  const html = await fs.readFile(writeIndex(dir, await analyzeRound(dir, config), ['lead']), 'utf8')
  assert.ok(!html.includes('docs/dev.html'))
  assert.ok(html.includes('docs/lead.html'))
})

test('writeLighthouseHtml writes the Lighthouse report next to its json', async () => {
  const dir = await makeRound()
  const json = path.join(dir, 'pages/m/home/run-1/lighthouse.json')
  const out = writeLighthouseHtml(json)
  assert.equal(out, path.join(dir, 'pages/m/home/run-1/lighthouse.html'))
  const html = await fs.readFile(out, 'utf8')
  assert.ok(html.includes('__LIGHTHOUSE_JSON__'))
  assert.ok(html.length > 100000)
})
