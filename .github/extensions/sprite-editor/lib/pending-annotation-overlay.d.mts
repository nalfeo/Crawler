export declare function resolvePendingAnnotationsPath(
  repoRoot: string,
  deps?: { env?: NodeJS.ProcessEnv; homedir?: string },
): string;

export declare function readPendingDislikedSpriteNames(
  pendingAnnotationsPath: string,
  deps?: {
    readFile?: (path: string) => string;
    exists?: (path: string) => boolean;
    getCurrentAnnotation?: (key: string) => unknown;
  },
): ReadonlySet<string>;
