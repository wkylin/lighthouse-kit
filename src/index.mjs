// 包入口：配置辅助。命令行入口是 bin/lhkit.mjs。

/**
 * 原样返回配置，只为编辑器里的类型提示和补全：
 *   import { defineConfig } from 'lighthouse-kit'
 *   export default defineConfig({ serve: { static: 'dist' }, pages: ['/'] })
 * 需要 lighthouse-kit 装在项目里；只用 npx 运行时，改用配置文件顶部的 @type 注释。
 * @template {import('lighthouse-kit').UserConfig} T
 * @param {T} config
 * @returns {T}
 */
export function defineConfig(config) {
  return config
}
