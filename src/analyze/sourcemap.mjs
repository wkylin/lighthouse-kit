// 打包文件 → 源文件。页面代码块（manifest 里记着自己的源文件）用 manifest；入口和共享代码块读 source map，
// 取占比最大的源文件；都没有时返回 null。站点挂在子路径（basePath）下时先去掉这段前缀。
import fs from 'node:fs'
import path from 'node:path'

const toPosix = (p) => p.split(path.sep).join('/')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** node_modules 里的源文件 → 包名（含作用域）。 */
function packageOf(p) {
  const rest = p.split('node_modules/').at(-1)
  const parts = rest.split('/')
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 没有 sourcesContent 时，按映射段数统计每个源文件的占比。 */
function segmentCounts(mappings, sourceCount) {
  const counts = new Array(sourceCount).fill(0)
  let source = 0
  for (const line of String(mappings ?? '').split(';')) {
    for (const seg of line.split(',')) {
      if (!seg) continue
      const fields = []
      let value = 0
      let shift = 0
      for (const ch of seg) {
        const digit = BASE64.indexOf(ch)
        if (digit < 0) break
        value += (digit & 31) << shift
        if (digit & 32) {
          shift += 5
        } else {
          fields.push(value & 1 ? -(value >> 1) : value >> 1)
          value = 0
          shift = 0
        }
      }
      if (fields.length >= 4) {
        source += fields[1]
        if (source >= 0 && source < sourceCount) counts[source]++
      }
    }
  }
  return counts
}

/**
 * @param {{manifest: string|null, maps: string|null, root: string, basePath?: string}} opts
 * @returns {Promise<(bundleUrl: string) => {file: string, share: number}|null>}
 */
export async function createSourceResolver({ manifest, maps, root, basePath = '/' }) {
  const prefix = `/${String(basePath).replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '')
  /** @type {Map<string, string>} 打包文件（相对构建目录）→ manifest 里的 src */
  const bySrc = new Map()
  const manifestJson = manifest ? readJson(manifest) : null
  if (manifestJson && typeof manifestJson === 'object') {
    for (const entry of Object.values(manifestJson)) {
      if (entry && typeof entry.file === 'string' && typeof entry.src === 'string' && !entry.src.startsWith('_')) bySrc.set(entry.file, entry.src)
    }
  }
  // manifest 里的 src 相对 Vite 根目录。manifest 在 <构建输出>/.vite/ 下，Vite 根目录在构建输出之上：
  // 从构建输出的上一级开始往上找，避免对到构建输出里的同名文件（例如 dist/index.html）。
  const manifestAncestors = []
  if (manifest) {
    const manifestDir = path.dirname(path.resolve(manifest))
    const outDir = path.basename(manifestDir) === '.vite' ? path.dirname(manifestDir) : manifestDir
    for (let d = path.dirname(outDir); ; d = path.dirname(d)) {
      manifestAncestors.push(d)
      if (path.dirname(d) === d) break
    }
  }
  const display = (abs) => {
    const rel = toPosix(path.relative(root, abs))
    return rel.includes('node_modules/') ? `${packageOf(rel)} (node_modules)` : rel
  }
  const manifestSource = (src) => {
    for (const dir of manifestAncestors) {
      const abs = path.resolve(dir, src)
      if (fs.existsSync(abs)) return display(abs)
    }
    return src
  }
  const mapCache = new Map()
  const fromMap = (rel) => {
    if (!maps) return null
    const mapFile = path.join(maps, `${rel}.map`)
    if (mapCache.has(mapFile)) return mapCache.get(mapFile)
    let result = null
    const map = readJson(mapFile)
    if (map && Array.isArray(map.sources) && map.sources.length) {
      const sizes = Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length
        ? map.sourcesContent.map((c) => (typeof c === 'string' ? c.length : 0))
        : segmentCounts(map.mappings, map.sources.length)
      const total = sizes.reduce((a, b) => a + b, 0)
      if (total > 0) {
        let best = 0
        for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
        const raw = String(map.sources[best])
        const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i
        const abs = scheme.test(raw)
          ? path.resolve(root, raw.replace(scheme, ''))
          : path.resolve(path.dirname(mapFile), map.sourceRoot || '', raw)
        result = { file: display(abs), share: Math.round((sizes[best] / total) * 100) / 100 }
      }
    }
    mapCache.set(mapFile, result)
    return result
  }
  return (bundleUrl) => {
    let pathname
    try {
      pathname = new URL(bundleUrl).pathname
    } catch {
      return null
    }
    if (!pathname || pathname.endsWith('/')) return null
    let decoded = pathname
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      // 网址里有不成对的 %（例如 100%.png）：按原样使用
    }
    if (prefix) {
      if (decoded !== prefix && !decoded.startsWith(`${prefix}/`)) return null
      decoded = decoded.slice(prefix.length)
    }
    const rel = decoded.replace(/^\/+/, '')
    const src = bySrc.get(rel)
    // 页面代码块：manifest 记的就是它自己的源文件（.vue / .tsx），比 map 里占比最大的依赖更有用。
    if (src && !src.endsWith('.html')) return { file: manifestSource(src), share: 1 }
    // 入口（manifest 里只是 index.html）和共享代码块：看 source map 里占比最大的源文件。
    const mapped = fromMap(rel)
    if (mapped) return mapped
    return src ? { file: manifestSource(src), share: 1 } : null
  }
}
