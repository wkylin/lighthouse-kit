import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // manifest 让 lhkit 把打包文件对回源文件
  build: { manifest: true },
})
