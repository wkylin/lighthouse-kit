// lhkit 配置：React + Vite 示例。
export default {
  build: { command: 'npm run build -- --sourcemap hidden' },
  serve: { static: 'dist', port: 4180 },
  pages: ['/', '/about'],
  sourceMap: { manifest: 'dist/.vite/manifest.json', maps: 'dist' },
  docs: { audiences: ['dev', 'lead'] },
  ai: { enabled: false, sourceRoot: 'src' },
}
