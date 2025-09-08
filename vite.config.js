// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022'      // or 'esnext'
  },
  esbuild: {
    target: 'es2022'      // keep esbuild in sync
  }
})