import { FLOOR2_BASIC_LEATHER_STABLE_IDS } from './src/shared/data/floor2-basic-leather-bases.ts';
import { loadShippedManifestRaw } from './tests/helpers/generated-manifest.ts';
import { fetchGeneratedSpriteRegistry } from './src/engine/generatedAssets/index.ts';
import { isPlaceholderEntry } from './src/shared/item-sprites.ts';

function conceptVersion(briefId: string, concept: string): number | null {
  if (briefId === concept) return 0;
  const prefix = `${concept}-v`;
  if (!briefId.startsWith(prefix)) return null;
  const digits = briefId.slice(prefix.length);
  if (digits.length === 0 || !/^\d+$/.test(digits)) return null;
  return Number(digits);
}

function resolveBasicLeatherAliasEntry(registry: any, stableId: string) {
  const slug = stableId.slice(stableId.indexOf('.') + 1);
  const concept = `classic-fantasy-basic-leather-${slug}`;
  return (
    registry
      .entries()
      .filter(
        (entry: any) =>
          conceptVersion(entry.briefId, concept) !== null && !isPlaceholderEntry(entry),
      )
      .sort((a: any, b: any) => {
        const versionDiff =
          conceptVersion(a.briefId, concept)! - conceptVersion(b.briefId, concept)!;
        if (versionDiff !== 0) return versionDiff;
        if (a.variantIndex !== b.variantIndex) return a.variantIndex - b.variantIndex;
        return a.textureKey.localeCompare(b.textureKey);
      })[0] ?? null
  );
}

async function loadRealShippedRegistry() {
  const raw = loadShippedManifestRaw();
  const fetcher = (async () =>
    new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return fetchGeneratedSpriteRegistry({ url: '/assets/generated/manifest.json', fetcher });
}

async function run() {
  const registry = await loadRealShippedRegistry();

  let failures = 0;
  for (const id of FLOOR2_BASIC_LEATHER_STABLE_IDS) {
    const entry = resolveBasicLeatherAliasEntry(registry, id);
    if (!entry) {
      console.error(`Missing non-placeholder entry for ${id}`);
      failures++;
    } else {
      console.log(`OK: ${id} -> ${entry.textureKey}`);
    }
  }
  console.log(`Failures: ${failures}`);
}
run().catch(console.error);
