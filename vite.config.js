import { defineConfig } from 'vite';

const allowedHosts = [
  'd7o6l8tnnfgg0ao6vbf0-dbce867hlvn2b43g2meg-5173.labs.playdev.online',
  ...(process.env.VITE_ALLOWED_HOST ? [process.env.VITE_ALLOWED_HOST] : []),
];

const apiProxy = {
  '/api': { target: 'http://localhost:3001', changeOrigin: true },
};

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts,
    proxy: apiProxy,
  },
  // Mode produksi: `vite build` lalu `vite preview` menyajikan folder dist
  // di port 5173 dan meneruskan /api ke server Express (port 3001).
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts,
    proxy: apiProxy,
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 900 },
});
