import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Production hostnames allowed to hit the Vite server (prevents host-header
    // attacks but also blocks legitimate droplet traffic without this list)
    allowedHosts: [
      'bytescon.com',
      'www.bytescon.com',
      'app.bytescon.com',
      '.bytescon.com', // wildcard — matches any subdomain for Phase 5B firm portals
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
        },
      },
    },
  },
});
