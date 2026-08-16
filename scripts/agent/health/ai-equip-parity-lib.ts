/**
 * Library half of the AI equipment-parity guard — see
 * `check-ai-equip-parity.ts` for the rationale. Split out so the scan is unit
 * testable without spawning a process or asserting on exit codes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Equipment mutators that accept an `{ force }` option to skip the safe-context gate. */
export const EQUIPMENT_MUTATORS: readonly string[] = [
  'equipFromBag',
  'equip',
  'unequip',
  'claimGeneratedEquipmentRewardBundle',
];

/**
 * AI-path files permitted to force an equipment mutation. Empty by design: an
 * entry here is an explicit, reviewed statement that the AI may do something a
 * human player cannot. Never add one merely to make this check pass.
 */
export const ALLOWLIST: readonly string[] = [];

export interface ForceEquipViolation {
  /** Repo-relative POSIX path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The offending source line, trimmed. */
  readonly snippet: string;
}

export interface ForceEquipScanResult {
  readonly violations: readonly ForceEquipViolation[];
  readonly scannedFiles: number;
}

function listTypeScriptFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Scan `root` (normally `src/game/ai`) for equipment mutator calls that pass a
 * `force` option.
 *
 * The scan is intentionally textual rather than AST-based: it must also reject
 * indirect spellings such as building an options object and spreading it in,
 * and a false positive here costs one comment removal while a false negative
 * costs a silently privileged AI. Detection is per-line: a mutator call and a
 * `force` option token on the same line. `repoRelativeTo` controls the reported
 * path prefix so callers can report repo-relative paths from any cwd.
 */
export function findAiForceEquipViolations(
  root: string,
  repoRelativeTo: string = path.resolve(root, '..', '..', '..'),
): ForceEquipScanResult {
  const mutatorCall = new RegExp(`\\b(?:${EQUIPMENT_MUTATORS.join('|')})\\s*\\(`);
  const forceOption = /\bforce\s*:\s*true\b|\bforce\s*:\s*[A-Za-z_$][\w$]*/;
  const violations: ForceEquipViolation[] = [];
  const files = listTypeScriptFiles(root);

  for (const file of files) {
    const relative = path.relative(repoRelativeTo, file).split(path.sep).join('/');
    if (ALLOWLIST.includes(relative)) {
      continue;
    }
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i] ?? '';
      const line = raw.trim();
      // Comments describe the policy constantly in this area; only executable
      // code can actually grant the privilege.
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) {
        continue;
      }
      if (mutatorCall.test(raw) && forceOption.test(raw)) {
        violations.push({ file: relative, line: i + 1, snippet: line });
      }
    }
  }

  return { violations, scannedFiles: files.length };
}
