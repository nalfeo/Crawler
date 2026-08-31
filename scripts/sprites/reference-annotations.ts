import { readFileSync } from 'node:fs';

const ANNOTATION_PARSE_ATTEMPTS = 3;

export function loadAnnotationSpritesMap(
  annotationsPath: string,
): Readonly<Record<string, unknown>> {
  for (let attempt = 0; attempt < ANNOTATION_PARSE_ATTEMPTS; attempt += 1) {
    try {
      const raw = JSON.parse(readFileSync(annotationsPath, 'utf8')) as {
        readonly sprites?: unknown;
      };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const sprites = raw.sprites;
      if (!sprites || typeof sprites !== 'object' || Array.isArray(sprites)) return {};
      return sprites as Record<string, unknown>;
    } catch {
      // Concurrent editor writes can expose a transient truncated snapshot.
    }
  }
  return {};
}

export function loadDislikedSpriteNamesFromAnnotations(
  annotationsPath: string,
): ReadonlySet<string> {
  const sprites = loadAnnotationSpritesMap(annotationsPath);
  const disliked = new Set<string>();
  for (const [spriteName, note] of Object.entries(sprites)) {
    if (!note || typeof note !== 'object' || Array.isArray(note)) continue;
    if ((note as { readonly disliked?: unknown }).disliked === true) disliked.add(spriteName);
  }
  return disliked;
}
