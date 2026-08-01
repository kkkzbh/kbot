import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const projectRoot = resolve(import.meta.dirname, '../..');
const outDir = process.env.QQBOT_ADMIN_OUT_DIR
  ? resolve(process.env.QQBOT_ADMIN_OUT_DIR)
  : resolve(projectRoot, 'dist/admin-web');
const adminApiProxy = process.env.QQBOT_ADMIN_API_PROXY ?? 'http://127.0.0.1:5140';

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '@contracts': resolve(projectRoot, 'src/admin/contracts/index.ts'),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api/admin': {
        target: adminApiProxy,
        changeOrigin: true,
      },
    },
  },
});
