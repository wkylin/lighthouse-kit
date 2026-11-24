// 用法：node test/fixtures/trim.mjs <lighthouse.json> <输出>
// 去掉截图等大块数据，保留分析用到的部分。
import fs from 'node:fs'
const [input, output] = process.argv.slice(2)
const lhr = JSON.parse(fs.readFileSync(input, 'utf8'))
for (const id of ['screenshot-thumbnails', 'final-screenshot', 'full-page-screenshot', 'script-treemap-data']) delete lhr.audits[id]
delete lhr.fullPageScreenshot
if (lhr.i18n) delete lhr.i18n.icuMessagePaths
fs.writeFileSync(output, JSON.stringify(lhr))
