#!/usr/bin/env node
/**
 * sprites:synth CLI — turns a subject name into N reviewable
 * minimal-brief YAML candidates the human then picks from.
 *
 * Usage:
 *   npm run sprites:synth -- <name>
 *   npm run sprites:synth -- <name> --type weapon
 *   npm run sprites:synth -- <name> --type weapon --candidates 3
 *   npm run sprites:synth -- <name> --allow-partial
 *
 * The CLI is intentionally tiny: argv parsing, env wiring, and a
 * human-readable summary table. All the real work lives in
 * `synthesize-brief.ts` so unit tests can exercise the orchestrator
 * without going through stdin/argv.
 */
import { type SpriteType } from './synthesize-brief.js';
interface SynthCliArgs {
  readonly name: string;
  readonly type: SpriteType | undefined;
  readonly candidates: number;
  readonly allowPartial: boolean;
}
export declare function parseArgs(argv: ReadonlyArray<string>): SynthCliArgs;
export {};
//# sourceMappingURL=synth-cli.d.ts.map
