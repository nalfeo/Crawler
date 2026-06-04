import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => ({
  build: {
    target: 'es2022',
    rollupOptions: {
      input:
        mode === 'lab'
          ? resolve(__dirname, 'lab.html')
          : resolve(__dirname, 'index.html'),
    },
  },
  server: {
    port: 3000,
    open: mode === 'lab' ? '/lab.html' : '/',
  },
}));
