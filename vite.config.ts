import { defineConfig } from 'vite';
import { resolve } from 'path';
import { labTuningSavePlugin } from './tools/vite-plugin-save-tuning.js';

const basePaths: Record<string, string> = {
  local: '/',
  dev: '/Crawler/dev/',
  beta: '/Crawler/beta/',
  prod: '/Crawler/',
};

export default defineConfig(({ mode }) => {
  const deployEnv = process.env.DEPLOY_ENV ?? 'local';
  const includeLabs = deployEnv === 'dev' || mode === 'lab';

  return {
    base: basePaths[deployEnv] ?? '/',
    plugins: mode === 'lab' ? [labTuningSavePlugin()] : [],
    build: {
      target: 'es2022',
      outDir: process.env.BUILD_OUTDIR ?? 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: includeLabs
          ? {
              index: resolve(__dirname, 'index.html'),
              lab: resolve(__dirname, 'lab.html'),
            }
          : {
              index: resolve(__dirname, 'index.html'),
            },
      },
    },
    server: {
      port: 3000,
      open: mode === 'lab' ? '/lab.html' : '/',
    },
  };
});
