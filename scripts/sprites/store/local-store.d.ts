/**
 * LocalRunStore — filesystem-backed RunStore.
 *
 * Stores run artifacts under `<root>/runs/<key>` on the local filesystem.
 * This is the default when `SPRITES_RUN_STORE` is unset or `'local'`.
 *
 * Directory creation is handled transparently by `put`: callers never need
 * to pre-create directories the way the old `run-artifacts.ts` flow required
 * explicit `mkdirSync` calls.
 */
import { type RunStore } from './types.js';
export declare class LocalRunStore implements RunStore {
  private readonly root;
  readonly backend: 'local';
  /**
   * @param root Absolute path to the runs directory
   *             (e.g. `<repoRoot>/generated/runs`).
   */
  constructor(root: string);
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
  list(prefix: string): Promise<readonly string[]>;
  remove(key: string): Promise<void>;
  resolve(key: string): string;
  private abs;
  private walk;
}
//# sourceMappingURL=local-store.d.ts.map
