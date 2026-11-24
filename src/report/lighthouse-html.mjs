// 每页的 Lighthouse HTML 报告（与 Chrome DevTools 里看到的相同，单文件、离线可开）。
import fs from 'node:fs'
import path from 'node:path'
import { ReportGenerator } from 'lighthouse/report/generator/report-generator.js'

/**
 * 在 lighthouse.json 旁边写 lighthouse.html。未给 lhr 时从 jsonPath 读取。
 * @param {string} jsonPath
 * @param {object} [lhr]
 * @returns {string} 写出的 HTML 路径
 */
export function writeLighthouseHtml(jsonPath, lhr) {
  const htmlPath = path.join(path.dirname(jsonPath), 'lighthouse.html')
  const data = lhr ?? JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  fs.writeFileSync(htmlPath, ReportGenerator.generateReportHtml(data))
  return htmlPath
}
