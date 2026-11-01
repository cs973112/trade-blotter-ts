import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// The app calls the API with relative URLs (/trades, /positions). In development and preview the
// Vite server forwards those paths to the API, so the browser sees one origin and the API needs no
// CORS. Point API_TARGET elsewhere when the API does not run on its default port.
const apiTarget = process.env['API_TARGET'] ?? 'http://localhost:5299'
const proxy = Object.fromEntries(['/trades', '/positions', '/documentation'].map((path) => [path, { target: apiTarget }]))

export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, strictPort: true, proxy },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/support/no-network.ts'],
    // A zone with daylight-saving changes, so timestamp tests cover skipped and repeated hours.
    env: { TZ: 'America/New_York' },
  },
})
