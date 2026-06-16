import { defineConfig } from 'vite';
import { resolve } from 'path';
import { labTuningSavePlugin } from './tools/vite-plugin-save-tuning.ts';

const basePaths: Record<string, string> = {
  local: '/',
  dev: '/Crawler/dev/',
  beta: '/Crawler/beta/',
  prod: '/Crawler/',
};

export default defineConfig(({ mode }) => {
  const deployEnv = process.env.DEPLOY_ENV ?? 'local';
  const includeLabs = deployEnv === 'dev' || mode === 'lab';
  const includeDevTools = deployEnv === 'local' && mode === 'devtools';

  const input: Record<string, string> = {
    index: resolve(__dirname, 'index.html'),
  };

  if (includeLabs) {
    input.lab = resolve(__dirname, 'lab.html');
  }

  if (includeDevTools) {
    input.devtools = resolve(__dirname, 'devtools.html');
  }

  return {
    base: basePaths[deployEnv] ?? '/',
    plugins: mode === 'lab' ? [labTuningSavePlugin()] : [],
    build: {
      target: 'es2022',
      outDir: process.env.BUILD_OUTDIR ?? 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input,
      },
    },
    server: {
      port: 3000,
      open: mode === 'lab' ? '/lab.html' : mode === 'devtools' ? '/devtools.html' : '/',
      watch: {
        // Ignore directories written by the sprite pipeline so that creating/updating
        // YAML briefs or generated assets does not trigger a full Vite page reload.
        ignored: ['**/briefs/**', '**/generated/**'],
      },
    },
  };
});
