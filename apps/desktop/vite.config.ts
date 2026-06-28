import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Browser mode (`pnpm dev:browser`) sets ORCA_BROWSER_PROXY=1 so the dev server
// proxies /v1 (HTTP + WS) to the daemon, reading the discovery record live each
// time. This keeps working across daemon restarts (new ephemeral port + token)
// with no reload, and means the browser never holds a token. See CLAUDE.md.
function daemonRecord(): { url: string; token: string } | null {
  const file = process.env.ORCA_DATA_DIR
    ? path.join(process.env.ORCA_DATA_DIR, 'daemon.json')
    : path.join(os.homedir(), '.orca', 'daemon.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const browserProxy = process.env.ORCA_BROWSER_PROXY === '1'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: browserProxy
      ? {
          '/v1': {
            // Initial target; refreshed live in configure() below.
            target: daemonRecord()?.url ?? 'http://127.0.0.1:8787',
            changeOrigin: true,
            ws: true,
            configure: (proxy, options) => {
              // http-proxy reads options.target on every web()/ws() call, so
              // mutating it here points new requests at the current daemon.
              setInterval(() => {
                const rec = daemonRecord()
                if (rec?.url) options.target = rec.url
              }, 1000).unref()
              proxy.on('proxyReq', (proxyReq) => {
                const token = daemonRecord()?.token
                if (token) proxyReq.setHeader('authorization', `Bearer ${token}`)
              })
              proxy.on('proxyReqWs', (proxyReq) => {
                const token = daemonRecord()?.token
                if (token) {
                  const sep = proxyReq.path.includes('?') ? '&' : '?'
                  proxyReq.path += `${sep}token=${token}`
                }
              })
              // Swallow errors while the daemon is down; the client reconnects.
              proxy.on('error', () => {})
            },
          },
        }
      : undefined,
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
