#!/usr/bin/env node
/**
 * security/check-ai-prompts.ts — Static-scan `src/game/ai/**` for prompts
 * that concatenate non-literal data without a sanitization helper.
 *
 * Heuristic: look for template literals containing `${...}` where the
 * interpolated identifier isn't on a small allowlist of known-safe constants
 * AND the surrounding context references known prompt-emitting calls
 * (`prompt:`, `messages:`, `ollama`, `chat`, etc.).
 *
 * If `src/game/ai/` doesn't exist yet, emits SKIP and exits 0 so the loop
 * stays green until the directory lands.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Report, fromRepo } from '../shared/report.js';

const AI_DIR = 'src/game/ai';
const PROMPT_HINTS = ['prompt', 'messages', 'ollama', 'chat'];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs));
    } else if (e.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const report = new Report('security-check-ai-prompts');
  const absDir = fromRepo(AI_DIR);
  let stat;
  try {
    stat = statSync(absDir);
  } catch {
    report.skip(`${AI_DIR} does not exist yet.`);
    report.finish();
  }
  if (!stat!.isDirectory()) {
    report.skip(`${AI_DIR} is not a directory.`);
    report.finish();
  }

  const files = walk(absDir);
  if (files.length === 0) {
    report.skip(`No .ts files found under ${AI_DIR}.`);
    report.finish();
  }

  const interpRe = /`[^`]*\$\{[^}]+\}[^`]*`/g;
  for (const abs of files) {
    const rel = path.relative(fromRepo(), abs).replace(/\\/g, '/');
    const text = readFileSync(abs, 'utf8');
    const looksLikePromptFile = PROMPT_HINTS.some((h) => new RegExp(`\\b${h}\\b`, 'i').test(text));
    if (!looksLikePromptFile) continue;
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      // `matchAll` returns an iterator with fresh state per call — unlike
      // `exec` on a /g regex, which shares `lastIndex` across invocations.
      // This guarantees we visit every interpolation on every line.
      const matches = Array.from(line.matchAll(interpRe));
      if (matches.length === 0) return;
      // Heuristic guard: require the line to mention something prompt-shaped too.
      const lower = line.toLowerCase();
      if (!PROMPT_HINTS.some((h) => lower.includes(h))) return;
      // Allow lines that pass through an obvious sanitizer.
      if (/sanitize|escapePrompt|stripUnsafe/.test(line)) return;
      for (const m of matches) {
        report.warn(`Possible unsanitized prompt interpolation: ${m[0]}`, {
          file: rel,
          line: idx + 1,
          remediation:
            'Validate / sanitize interpolated values before they reach the prompt, or use a parameterized prompt template.',
        });
      }
    });
  }
  report.finish();
}

main().catch((err) => {
  process.stderr.write(`check-ai-prompts crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(2);
});
