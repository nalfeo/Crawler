import { statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliEntryResolverFor, loadRepoEnv } from './bridge.mjs';

/**
 * Build an in-process fast path for the read-only `artifact` command.
 *
 * Every preview image otherwise costs a fresh `node` process that loads the
 * whole bundled CLI — including `@azure/storage-blob` — just to run one
 * `store.get`. Measured live that is ~2.5-5s per image, essentially all cold
 * process + module load, not transfer or a cache miss. This imports the SAME
 * bundle once into the host process, constructs the RunStore a single time, and
 * reuses it across reads, so each subsequent read collapses to a warm
 * disk-cache hit.
 *
 * Returns a `read(command) -> { contentType, base64 }` function. It is a
 * best-effort accelerator: whenever the fast path is unavailable (the bundle
 * fell back to a tsx invocation the host cannot `import`, the bundle is missing
 * the reader export, or any read throws) it throws, and the caller is expected
 * to fall back to the child-process command path. A reader problem must never
 * break image previews.
 */
export function createInProcessArtifactReader({ repoRoot, log = () => {} }) {
  const resolveArgv = cliEntryResolverFor(repoRoot, log);
  // Cache the constructed reader against the bundle it came from and the
  // `.env.local` it was built with, so a developer editing the CLI or
  // refreshing Azure credentials while the canvas stays open still gets a
  // fresh store — matching the per-command env-freshness of the child path.
  let cached = null; // { reader, entry, envMtimeMs }

  const envMtimeMs = () => {
    try {
      return statSync(path.join(repoRoot, '.env.local')).mtimeMs;
    } catch {
      return -1;
    }
  };

  return async function readArtifact(command) {
    const argv = await resolveArgv();
    // The tsx fallback (`['--import', 'tsx', <cli.ts>]`) is not importable
    // in-process; only the single-file bundled `.mjs` entry is.
    if (argv.length !== 1 || !argv[0].endsWith('.mjs')) {
      throw new Error('in-process artifact reader unavailable (CLI not bundled)');
    }
    const entry = argv[0];
    const currentEnvMtimeMs = envMtimeMs();
    if (!cached || cached.entry !== entry || cached.envMtimeMs !== currentEnvMtimeMs) {
      const module = await import(pathToFileURL(entry).href);
      if (typeof module.createThemeEquipmentArtifactReader !== 'function') {
        throw new Error('bundle does not export createThemeEquipmentArtifactReader');
      }
      const reader = module.createThemeEquipmentArtifactReader({
        repoRoot,
        env: loadRepoEnv(repoRoot),
      });
      cached = { reader, entry, envMtimeMs: currentEnvMtimeMs };
    }
    return cached.reader.read(command.setId, command.itemId, command.artifactId);
  };
}
