/**
 * Shared helpers for the looping automation scripts under `scripts/agent/`.
 *
 * Every check script is expected to:
 *  - emit one or more `Finding` objects via `report.finding(...)`
 *  - print a compact ASCII summary on stdout
 *  - exit with `report.exitCode()` (non-zero when any blocking finding exists)
 *
 * The workflow YAML captures stdout into a per-script log file and aggregates
 * everything into a single tracking issue.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type Severity = 'info' | 'warn' | 'error' | 'skip';

export interface Finding {
  readonly severity: Severity;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly remediation?: string;
}

export interface ReportSummary {
  readonly script: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly findings: ReadonlyArray<Finding>;
  readonly blocking: number;
}

export class Report {
  private readonly findings: Finding[] = [];
  private readonly startedAt = new Date().toISOString();

  constructor(public readonly script: string) {}

  finding(f: Finding): void {
    this.findings.push(f);
    const prefix = this.prefixFor(f.severity);
    const location = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
    process.stdout.write(`${prefix}${location} ${f.message}\n`);
    if (f.remediation) {
      process.stdout.write(`    ↳ ${f.remediation}\n`);
    }
  }

  skip(reason: string): void {
    this.finding({ severity: 'skip', message: `SKIP: ${reason}` });
  }

  info(message: string): void {
    this.finding({ severity: 'info', message });
  }

  warn(message: string, extra: Omit<Finding, 'severity' | 'message'> = {}): void {
    this.finding({ severity: 'warn', message, ...extra });
  }

  error(message: string, extra: Omit<Finding, 'severity' | 'message'> = {}): void {
    this.finding({ severity: 'error', message, ...extra });
  }

  blockingCount(): number {
    return this.findings.filter((f) => f.severity === 'error').length;
  }

  exitCode(): number {
    return this.blockingCount() > 0 ? 1 : 0;
  }

  summarize(): ReportSummary {
    return {
      script: this.script,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      findings: this.findings.slice(),
      blocking: this.blockingCount(),
    };
  }

  writeSummary(): void {
    const outDir = process.env.AUTOMATION_REPORT_DIR;
    if (!outDir) return;
    const file = path.join(outDir, `${this.script}.json`);
    writeFileSync(file, JSON.stringify(this.summarize(), null, 2));
  }

  finish(): never {
    process.stdout.write(
      `\n${this.script}: ${this.findings.length} finding(s), ${this.blockingCount()} blocking\n`,
    );
    this.writeSummary();
    process.exit(this.exitCode());
  }

  private prefixFor(s: Severity): string {
    switch (s) {
      case 'error':
        return '[ERROR]';
      case 'warn':
        return '[WARN]';
      case 'skip':
        return '[SKIP]';
      case 'info':
      default:
        return '[INFO]';
    }
  }
}

export function repoRoot(): string {
  // scripts/agent/shared/report.ts → repo root is three levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function fromRepo(...parts: ReadonlyArray<string>): string {
  return path.join(repoRoot(), ...parts);
}
