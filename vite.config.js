import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy: forward /api requests to backend running on port 4000
export default defineConfig({
  plugins: [react()],
  resolve: {
    extensions: ['.js', '.jsx', '.json'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path,
      },
    },
  },
})