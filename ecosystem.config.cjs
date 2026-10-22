// Konfigurasi PM2 untuk Kantor AI — MODE PRODUKSI.
// Alur: `npm run build` (vite build ke dist/) lalu:
//   - kantor-ai-api : Express di port 3001 (API + static dist)
//   - kantor-ai-web : `vite preview` di port 5173 (menyajikan dist, proxy /api -> 3001)
// Pakai: npm run pm2:start   (build dulu, lalu start/reload)
// File .cjs dipakai karena package.json memakai "type": "module".
const path = require('node:path');

const ROOT = __dirname;
const ALLOWED_HOST =
  'd7o6l8tnnfgg0ao6vbf0-dbce867hlvn2b43g2meg-5173.labs.playdev.online';

module.exports = {
  apps: [
    {
      name: 'kantor-ai-api',
      cwd: ROOT,
      script: path.join(ROOT, 'server', 'index.js'),
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      max_memory_restart: '500M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      out_file: path.join(ROOT, 'logs', 'api.out.log'),
      error_file: path.join(ROOT, 'logs', 'api.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'kantor-ai-web',
      cwd: ROOT,
      script: path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      interpreter: 'node',
      args: 'preview',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,
      max_memory_restart: '800M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        VITE_ALLOWED_HOST: ALLOWED_HOST,
      },
      out_file: path.join(ROOT, 'logs', 'web.out.log'),
      error_file: path.join(ROOT, 'logs', 'web.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
