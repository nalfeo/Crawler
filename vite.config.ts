import { defineConfig } from 'vite';
import { resolve } from 'path';
import {
  getSessionServerPorts,
  getVitePortForMode,
} from './scripts/shared/session-server-ports.js';
import { labTuningSavePlugin } from './tools/vite-plugin-save-tuning';
import { generatedManifestPlugin } from './tools/vite-plugin-generated-manifest';
import { labUrlBannerPlugin } from './tools/vite-plugin-lab-url-banner';

const basePaths: Record<string, string> = {
  local: '/',
  dev: '/Crawler/dev/',
  beta: '/Crawler/beta/',
  preview: '/Crawler/preview/',
  prod: '/Crawler/',
};

export default defineConfig(({ mode }) => {
  const deployEnv = process.env.DEPLOY_ENV ?? 'local';
  const includeLabs = deployEnv === 'dev' || deployEnv === 'preview' || mode === 'lab';
  const includeDevTools = deployEnv === 'local' && mode === 'devtools';
  const sessionPorts = getSessionServerPorts({ cwd: __dirname, env: process.env });

  const input: Record<string, string> = {
    index: resolve(__dirname, 'index.html'),
  };

  if (includeLabs) {
    input.lab = resolve(__dirname, 'lab.html');
  }

  if (includeDevTools) {
    input.devtools = resolve(__dirname, 'devtools.html');
  }

  process.env.VITE_SPRITES_SIDECAR_BASE_URL = sessionPorts.sidecarBaseUrl;

  return {
    base: basePaths[deployEnv] ?? '/',
    define: {
      __CRAWLER_SPRITES_SIDECAR_BASE_URL__: JSON.stringify(sessionPorts.sidecarBaseUrl),
      'import.meta.env.VITE_SPRITES_SIDECAR_BASE_URL': JSON.stringify(sessionPorts.sidecarBaseUrl),
    },
    plugins:
      mode === 'lab'
        ? [generatedManifestPlugin(), labTuningSavePlugin(), labUrlBannerPlugin()]
        : [generatedManifestPlugin()],
    build: {
      target: 'es2022',
      outDir: process.env.BUILD_OUTDIR ?? 'dist',
      emptyOutDir: true,
      minify: 'esbuild',
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        input,
        output: {
          manualChunks: (id) => {
            // Split large vendor dependencies into separate chunks
            if (id.includes('node_modules')) {
              if (id.includes('phaser')) {
                return 'vendor-phaser';
              }
              if (id.includes('bitecs') || id.includes('rot-js') || id.includes('loglevel')) {
                return 'vendor-core';
              }
              return 'vendor-other';
            }
            // Split labs into separate chunks for lazy loading
            if (id.includes('/src/labs/') && !id.includes('lab-main')) {
              const labMatch = id.match(/\/src\/labs\/([^/]+)/);
              if (labMatch) {
                return `lab-${labMatch[1]}`;
              }
            }
          },
        },
      },
    },
    server: {
      port: getVitePortForMode(mode, { cwd: __dirname, env: process.env }),
      open: mode === 'devtools' ? '/devtools.html' : mode === 'lab' ? false : '/',
      watch: {
        // Ignore directories written by the sprite pipeline so that creating/updating
        // YAML briefs or generated assets does not trigger a full Vite page reload.
        ignored: ['**/briefs/**', '**/generated/**'],
      },
    },
    optimizeDeps: {
      include: ['phaser', 'bitecs', 'rot-js', 'loglevel'],
    },
  };
});
