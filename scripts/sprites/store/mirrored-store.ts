/**
 * MirroredRunStore — a local working store with a FAIL-CLOSED durable mirror.
 *
 * Why this exists
 * ---------------
 * Generation used to write run artifacts to whichever single store the caller
 * injected. `sprites:run` / `sprites:batch` injected nothing, so they silently
 * fell back to a `LocalRunStore` rooted at the gitignored `generated/runs/`
 * tree (see `generateSheetCore`). The Azure *image provider* was still used, so
 * the run looked fully "cloud-backed" while every LLM-authored artifact — the
 * brief, the exact prompt, the raw sheet, the sliced candidates, the scorecards
 * — existed only inside one worktree. Approving a winner then published art to
 * git with a `sourceRun` pointer into a run that evaporated with the worktree.
 *
 * A plain "just use the Azure store" swap would have broken the local review
 * UX: `sprites:approve <runDir>`, the gallery, and the anchor overlay all read
 * run artifacts as real files, and `AzureBlobRunStore.resolve()` returns a blob
 * URL. So instead of replacing the local store we WRAP it:
 *
 * - reads (`get` / `has` / `list` / `resolve`) come from the local primary, so
 *   every existing local-file consumer keeps working unchanged;
 * - writes (`put` / `remove`) go to BOTH, and the call only resolves once the
 *   durable mirror accepted them.
 *
 * Fail-closed ordering
 * --------------------
 * `put` writes the primary FIRST and the mirror SECOND, then propagates any
 * mirror error. Writing the primary first means a mirror outage still leaves
 * the operator's bytes on local disk to retry from, while the rejected promise
 * guarantees no caller can treat the artifact as durably persisted. That is the
 * property the publication gate (`assertRunDurable`) relies on.
 *
 * Idempotency
 * -----------
 * Every method is a plain key/value operation against stable, content-derived
 * keys, so replaying a partially-failed run re-writes byte-identical content to
 * the same keys on both sides. There is no accumulate-or-append state here.
 *
 * Deliberately NOT supported
 * --------------------------
 * `putConditional` / `getWithETag`. A compare-and-swap spanning two independent
 * stores is not atomic and cannot be made so, and `conditionalWrites` is the
 * documented capability flag callers must check (see `RunStore`). Reporting
 * `'unsupported'` here is honest; the generation pipeline never uses CAS, and
 * CAS callers (workflow state, issue checkpoints) construct their store through
 * `createRunStore` rather than this wrapper.
 */

import type { ListOptions, RunStore } from './types.js';

export interface MirroredRunStoreOptions {
  /** Working store. Serves every read and `resolve`. Written first. */
  readonly primary: RunStore;
  /** Durable store. Written second; its failures fail the whole operation. */
  readonly mirror: RunStore;
}

export class MirroredRunStore implements RunStore {
  readonly backend: RunStore['backend'];
  /** See the class doc: CAS across two stores cannot be atomic. */
  readonly conditionalWrites = 'unsupported' as const;

  private readonly primary: RunStore;
  private readonly mirror: RunStore;

  constructor(options: MirroredRunStoreOptions) {
    this.primary = options.primary;
    this.mirror = options.mirror;
    this.backend = options.primary.backend;
  }

  /** The durable side, for callers that must verify persistence explicitly. */
  get durable(): RunStore {
    return this.mirror;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.primary.put(key, data);
    await this.mirror.put(key, data);
  }

  async get(key: string): Promise<Buffer> {
    return this.primary.get(key);
  }

  async has(key: string): Promise<boolean> {
    return this.primary.has(key);
  }

  async list(prefix: string, options?: ListOptions): Promise<readonly string[]> {
    return this.primary.list(prefix, options);
  }

  async remove(key: string): Promise<void> {
    await this.primary.remove(key);
    await this.mirror.remove(key);
  }

  resolve(key: string): string {
    return this.primary.resolve(key);
  }

  resolveForExternalRead(key: string): string {
    // The mirror is the externally reachable copy: the local primary resolves
    // to a filesystem path no GitHub comment could ever fetch.
    if (typeof this.mirror.resolveForExternalRead === 'function') {
      return this.mirror.resolveForExternalRead(key);
    }
    return this.mirror.resolve(key);
  }
}
