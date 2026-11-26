// API 与会话导出共用的源码边界、预算和上下文选择。
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const posix = (p) => p.split(path.sep).join('/')
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)
const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.jks', '.keystore', '.kdbx'])
const SECRET_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.htpasswd', 'credentials', 'credentials.json'])
const LOCK_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'])
const realpath = (p) => fs.realpath(p).catch(() => path.resolve(p))

function secret(rel) {
  const parts = posix(rel).split('/')
  const base = parts.at(-1)
  return parts.some((p) => p.startsWith('.env') || p === '.git' || p === 'node_modules') || SECRET_NAMES.has(base) || LOCK_NAMES.has(base) ||
    SECRET_EXT.has(`.${base.split('.').at(-1).toLowerCase()}`) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(base)
}

function outputDirs(config) {
  const dirs = [config.sourceMap.maps, config.serve.mode === 'static' ? config.serve.static : null, config.outDir]
  if (config.sourceMap.manifest) {
    const d = path.dirname(config.sourceMap.manifest)
    dirs.push(path.basename(d) === '.vite' ? path.dirname(d) : d)
  }
  return dirs.filter(Boolean).map((d) => path.resolve(d))
}

function context(text, finding, file, room) {
  const needle = finding.evidence.filter((e) => e.source?.file === file).map((e) => e.snippet)
    .find((s) => typeof s === 'string' && s.length >= 8 && s.length <= room && text.includes(s))
  const at = needle ? text.indexOf(needle) : 0
  let start = Math.max(0, Math.min(at - Math.floor(room / 3), text.length - room))
  start = text.lastIndexOf('\n', start - 1) + 1
  if (needle) start = Math.max(start, at + needle.length - room)
  return {
    text: text.slice(start, start + room),
    startLine: text.slice(0, start).split('\n').length,
    truncated: start > 0 || start + room < text.length,
    hash: crypto.createHash('sha256').update(text).digest('hex'),
  }
}

/** @returns {Promise<{file:string,text:string,startLine:number,truncated:boolean,hash:string}[]>} */
export async function collectSources(finding, config, memo = new Map()) {
  const sourceRoot = path.resolve(config.ai.sourceRoot)
  const [realRoot, projectRoot] = await Promise.all([realpath(sourceRoot), realpath(config.root)])
  const outputs = outputDirs(config)
  outputs.push(...await Promise.all(outputs.map(realpath)))
  const excluded = (abs, rel) => secret(rel) || outputs.some((d) => inside(abs, d)) ||
    config.ai.exclude.some((p) => path.matchesGlob(rel, p) || (path.isAbsolute(p) && path.matchesGlob(abs, p)))
  const seen = new Set()
  const out = []
  let used = 0
  for (const e of finding.evidence) {
    const file = e.source?.file
    if (!file || file.includes('(node_modules)') || seen.has(file)) continue
    seen.add(file)
    const abs = path.resolve(config.root, file)
    const rel = posix(path.relative(config.root, abs))
    if (!inside(abs, sourceRoot) || excluded(abs, rel)) continue
    let text
    try {
      const real = await fs.realpath(abs)
      if (!inside(real, realRoot) || excluded(real, posix(path.relative(projectRoot, real)))) continue
      // 绝对规则也要匹配实际目标在逻辑项目/源码根目录下的路径（例如 /tmp 与 /private/tmp）。
      const aliases = [path.resolve(config.root, path.relative(projectRoot, real)), path.resolve(sourceRoot, path.relative(realRoot, real))]
      if (aliases.some((alias) => excluded(alias, posix(path.relative(config.root, alias))))) continue
      if (!(await fs.stat(real)).isFile()) continue
      if (!memo.has(real)) memo.set(real, fs.readFile(real, 'utf8'))
      text = await memo.get(real)
    } catch { continue }
    const room = Math.min(config.ai.maxFileChars, config.ai.maxFindingChars - used)
    if (room <= 0) break
    const snippet = context(text, finding, file, room)
    if (!snippet.text.trim()) continue
    used += snippet.text.length
    out.push({ file: rel, ...snippet })
  }
  return out
}
