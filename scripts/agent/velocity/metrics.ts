/**
 * Metric extraction from a headless Copilot CLI transcript.
 *
 * A trial runs `copilot -p ... --output-format json`, which emits JSONL. Every
 * number the velocity lab reports comes from that transcript, so a trial is
 * fully self-describing — no dependency on an external session database.
 *
 * Event fields we rely on (verified empirically against Copilot CLI 1.0.71):
 * - `model.call_start`            → one model call ("agent turn")
 * - `assistant.message`           → `outputTokens`, `toolRequests[]`
 * - `session.usage_checkpoint`    → `totalNanoAiu` (true billed cost)
 * - `result`                      → `sessionId`, `exitCode`, `usage.*`
 */
import { readFileSync } from 'node:fs';
import type { TaskSpec, TrialMetrics } from './types.js';

export const EMPTY_METRICS: TrialMetrics = {
  modelCalls: 0,
  outputTokens: 0,
  toolCalls: 0,
  nanoAiu: 0,
  sessionDurationMs: 0,
  apiDurationMs: 0,
  linesAdded: 0,
  linesRemoved: 0,
  filesModified: 0,
};

interface TranscriptEvent {
  type?: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  exitCode?: number;
  usage?: {
    totalApiDurationMs?: number;
    sessionDurationMs?: number;
    codeChanges?: {
      linesAdded?: number;
      linesRemoved?: number;
      filesModified?: string[];
    };
  };
}

export function parseTranscript(text: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed) as TranscriptEvent);
    } catch {
      // A partial or interleaved line is not fatal; the metrics are aggregates.
    }
  }
  return events;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function extractMetrics(events: readonly TranscriptEvent[]): TrialMetrics {
  const metrics: TrialMetrics = { ...EMPTY_METRICS };
  for (const event of events) {
    switch (event.type) {
      case 'model.call_start':
        metrics.modelCalls++;
        break;
      case 'assistant.message': {
        metrics.outputTokens += num(event.data?.outputTokens);
        const toolRequests = event.data?.toolRequests;
        if (Array.isArray(toolRequests)) metrics.toolCalls += toolRequests.length;
        break;
      }
      case 'session.usage_checkpoint':
        // Checkpoints are cumulative; the last one wins.
        metrics.nanoAiu = num(event.data?.totalNanoAiu);
        break;
      case 'result':
        metrics.sessionDurationMs = num(event.usage?.sessionDurationMs);
        metrics.apiDurationMs = num(event.usage?.totalApiDurationMs);
        metrics.linesAdded = num(event.usage?.codeChanges?.linesAdded);
        metrics.linesRemoved = num(event.usage?.codeChanges?.linesRemoved);
        metrics.filesModified = event.usage?.codeChanges?.filesModified?.length ?? 0;
        break;
      default:
        break;
    }
  }
  return metrics;
}

export function extractSessionId(events: readonly TranscriptEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const id = events[i]?.sessionId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Leak audit.
 *
 * A replayed task's real solution lives in the repository's future history. The
 * trial worktree is truncated at the base commit and has no remote, but a
 * determined agent could still surface the answer (a stray remote, a cached
 * checkout, a web search). Rather than trusting the sandbox, every transcript
 * is scanned for identifiers that should be unreachable from inside a trial.
 *
 * A trial with leak signals is reported but excluded from the verdict.
 */
export function auditLeak(transcript: string, task: TaskSpec): string[] {
  const signals: string[] = [];
  const haystack = transcript.toLowerCase();

  const shortSha = task.solutionCommit.slice(0, 8).toLowerCase();
  if (shortSha.length >= 7 && haystack.includes(shortSha)) {
    signals.push(`solution-commit:${shortSha}`);
  }

  // `#1930`, `pull/1930`, `pr 1930` — the ways a PR gets referenced.
  const prPatterns = [`#${task.prNumber}`, `pull/${task.prNumber}`, `pr ${task.prNumber}`];
  for (const pattern of prPatterns) {
    if (haystack.includes(pattern.toLowerCase())) {
      signals.push(`pr-reference:${pattern}`);
      break;
    }
  }

  return signals;
}

/**
 * Commands capable of reaching the repository's real future.
 *
 * This exists because credential-stripping does **not** work: the Copilot CLI
 * needs a valid GitHub token to run at all, `gh` falls back to the OS keyring
 * when the token env vars are unset, and an unauthenticated `git ls-remote`
 * against a public repo succeeds regardless. Poisoning the token blocks `gh`
 * but also breaks the agent under test.
 *
 * Since prevention is not achievable in-process, this is a **detection**
 * control: any trial that ran one of these is flagged and excluded from the
 * verdict, so a leak shows up as a visible warning instead of a fast arm.
 */
const REMOTE_ACCESS_PATTERNS: readonly { readonly id: string; readonly re: RegExp }[] = [
  { id: 'gh-cli', re: /\bgh\s+(pr|issue|api|search|repo|release|run)\b/i },
  { id: 'git-remote-read', re: /\bgit\s+(fetch|pull|ls-remote|clone|remote\s+add)\b/i },
  { id: 'curl-github', re: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*github/i },
  { id: 'api-github', re: /api\.github\.com/i },
];

/**
 * Flag any use of a command that could fetch the real solution.
 *
 * Deliberately matches on the *attempt*, not on success: an agent that tried to
 * read the PR has already told you its trial is untrustworthy, whether or not
 * the call returned anything.
 */
export function auditCommandLeak(transcript: string): string[] {
  const signals: string[] = [];
  for (const { id, re } of REMOTE_ACCESS_PATTERNS) {
    if (re.test(transcript)) signals.push(`remote-access:${id}`);
  }
  return signals;
}

/**
 * True when the session stopped because it ran out of its credit budget.
 *
 * This must be distinguished from a genuine failure: a budget-capped trial says
 * nothing about whether the arm *could* have solved the task, and silently
 * scoring it as "failed" would let a too-tight budget masquerade as a real
 * difference between arms.
 */
export function detectBudgetExhaustion(events: readonly TranscriptEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'session.warning' &&
      (event.data as { warningType?: string } | undefined)?.warningType === 'session_limits',
  );
}

export function readTrialMetrics(
  transcriptPath: string,
  task: TaskSpec,
): {
  metrics: TrialMetrics;
  sessionId: string | null;
  leakSignals: string[];
  budgetExhausted: boolean;
} {
  let text: string;
  try {
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    return {
      metrics: { ...EMPTY_METRICS },
      sessionId: null,
      leakSignals: [],
      budgetExhausted: false,
    };
  }
  const events = parseTranscript(text);
  return {
    metrics: extractMetrics(events),
    sessionId: extractSessionId(events),
    leakSignals: [...auditLeak(text, task), ...auditCommandLeak(text)],
    budgetExhausted: detectBudgetExhaustion(events),
  };
}
