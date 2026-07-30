/**
 * Vite plugin: Lab URL Banner
 *
 * Vite's own startup banner advertises the server root (`/`), which serves
 * `index.html` — the GAME, not the lab shell. Labs live at
 * `/lab.html?lab=<id>`, so copying the printed URL lands you on the wrong
 * page. This plugin prints the correct, copy-pasteable lab URL once the
 * dev server is actually listening.
 *
 * Only registered for `vite --mode lab` (see vite.config.ts).
 */
import type { Plugin, ViteDevServer } from 'vite';

/** Builds the canonical lab URL for a given port (and optional lab id). */
export function formatLabUrl(port: number, labId?: string): string {
  const query = labId ? `?lab=${labId}` : '';
  return `http://localhost:${port}/lab.html${query}`;
}

export function labUrlBannerPlugin(): Plugin {
  return {
    name: 'crawler-lab-url-banner',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const print = (): void => {
        const address = server.httpServer?.address();
        const port =
          typeof address === 'object' && address ? address.port : server.config.server.port;
        if (typeof port !== 'number') return;
        server.config.logger.info(
          `\n  Labs are served from lab.html — open:\n    ${formatLabUrl(port, '<lab-id>')}\n  e.g. ${formatLabUrl(port, 'ai-runner')}\n`,
        );
      };
      server.httpServer?.once('listening', () => {
        // Defer so this lands after Vite's own "ready in Xms" banner.
        setTimeout(print, 0);
      });
    },
  };
}
