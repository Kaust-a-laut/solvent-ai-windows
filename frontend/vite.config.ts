import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-framer': ['framer-motion'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
          'vendor-d3': ['d3-force', 'd3-selection', 'd3-zoom', 'd3-drag'],
          'vendor-zustand': ['zustand'],
        },
      },
    },
    target: 'es2020',
  },
  server: {
    host: true,
    port: parseInt(process.env.PORT || '5173'),
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        timeout: 600_000,  // 10min — pipeline SSE streams can run long
      },
      '/files': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/generated_images': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/dev-secret': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        // Same-origin GETs carry no Origin header, but the backend's
        // /dev-secret hardening requires one from the CORS allowlist —
        // inject it so the browser-dev auth handshake can succeed.
        headers: {
          Origin: 'http://localhost:5173',
        },
      },
    },
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/test/**', 'src/types/**', 'src/**/*.d.ts'],
    },
  },
})
