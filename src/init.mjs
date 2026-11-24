// lhkit init：按 package.json 的脚本生成配置模板。
import fs from 'node:fs'
import path from 'node:path'
import { ConfigError } from './config.mjs'

function packageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * 项目还没有依赖 lighthouse-kit 时，返回用项目自己的包管理器安装它的命令；已有则为 null。
 * @param {string} root
 * @returns {string|null}
 */
export function installHint(root) {
  let pkg = {}
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {}
  if (pkg.dependencies?.['lighthouse-kit'] || pkg.devDependencies?.['lighthouse-kit']) return null
  const pm = packageManager(root)
  return pm === 'npm' ? 'npm install -D lighthouse-kit' : `${pm} add -D lighthouse-kit`
}

/**
 * @param {string} root
 * @param {{force?: boolean}} [opts]
 * @returns {string} 写出的配置文件
 */
export function writeConfigTemplate(root, { force = false } = {}) {
  const file = path.join(root, 'lhkit.config.mjs')
  if (fs.existsSync(file) && !force) throw new ConfigError(`配置错误：${file} 已存在（要覆盖请加 --force）`)
  let scripts = {}
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {}
  } catch {}
  const pm = packageManager(root)
  const build = scripts.build ? `  build: { command: '${pm} run build' },\n` : `  // build: { command: '${pm} run build' },\n`
  const serve = scripts.preview
    ? `  serve: { command: '${pm} run preview', url: 'http://localhost:4173', readyPath: '/' },\n  // serve: { static: 'dist' },\n`
    : `  serve: { static: 'dist' },\n  // serve: { command: '${pm} run preview', url: 'http://localhost:4173', readyPath: '/' },\n`
  const text = `// lhkit 配置（lighthouse-kit）。字段说明：https://github.com/wkylin/lighthouse-kit#配置
/** @type {import('lighthouse-kit').UserConfig} */
export default {
  // 构建命令。想把问题对到源码，可让构建输出 source map（Vite：加 --sourcemap hidden），并在下面 sourceMap 里指向构建目录。
${build}  // 三选一：项目自己的服务命令；工具托管构建目录；或只写网址扫描外部服务（不构建、不起服务）。
${serve}  // serve: { url: 'https://staging.example.com' },
  // https: { enabled: true, port: 4443 },          // HTTP/2 + 自签证书的前置代理，贴近线上
  pages: ['/'],
  // beforePage: async ({ page, url, warmup }) => {},  // 打开每页前的准备（写 sessionStorage、登录态等）
  // runs: 3,                                        // 每页次数，取中位数
  // visit: 'repeat',                                // 'first' 首次访问（默认）；'repeat' 回访
  // sourceMap: { manifest: 'dist/.vite/manifest.json', maps: 'dist' },
  docs: { audiences: ['dev', 'lead'] },
  ai: { enabled: false, sourceRoot: 'src' },        // 打开后需要环境变量 ANTHROPIC_API_KEY
}
`
  fs.writeFileSync(file, text)
  return file
}
