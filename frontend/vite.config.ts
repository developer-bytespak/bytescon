import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Staging builds (VITE_APP_ENV=staging) tell search engines to stay out. Done at
// build time so it's in the HTML a crawler sees, before any script runs.
function noindexOnStaging(appEnv: string | undefined): Plugin {
  return {
    name: 'noindex-on-staging',
    transformIndexHtml: () =>
      appEnv === 'staging'
        ? [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' }, injectTo: 'head' }]
        : [],
  };
}

// The flavour comes from the build's mode (.env.staging for --mode staging) or
// the host's settings, which win. See project-docs/20-environments-staging-and-production.md.
export default defineConfig(({ mode }) => ({
  plugins: [react(), noindexOnStaging(process.env.VITE_APP_ENV ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_APP_ENV)],
  server: {
    port: 3000,
    // Production hostnames allowed to hit the Vite server (prevents host-header
    // attacks but also blocks legitimate droplet traffic without this list)
    allowedHosts: [
      'bytesgov.com',
      'www.bytesgov.com',
      'app.bytesgov.com',
      '.bytesgov.com', // wildcard — matches any subdomain for Phase 5B firm portals
    ],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react':  ['react', 'react-dom', 'react-router-dom'],
          'vendor-query':  ['@tanstack/react-query'],
          'vendor-charts': ['recharts'],
          'vendor-icons':  ['lucide-react'],
          'vendor-motion': ['framer-motion', 'lenis'],
        },
      },
    },
  },
}));
