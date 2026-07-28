/**
 * CI-bypass gate for Constitutional §3 (Deterministic CI Only).
 *
 * By default, code paths that call live Azure APIs (`synthesizeBrief`,
 * `judgeVariant`) refuse to run when `env.CI` is set. That is the correct
 * default for CI gates that must be deterministic and free.
 *
 * The asset-request pipeline is an intentional exception: it processes
 * queued asset-request issues from an author allowlist in a bounded,
 * human-reviewable way. Enabling the bypass requires an explicit env
 * variable AND is authorised by ADR 0043.
 *
 * The gate opens when `SPRITES_ALLOW_CI_PIPELINE=true` (case-insensitive,
 * also accepts `1`/`yes`) — it does NOT open on any other truthy value.
 * The env value must be an explicit acknowledgement so a stray env leak
 * (e.g. from a different workflow) cannot silently unlock it.
 *
 * See: docs/knowledge/adr/0043-ci-asset-request-worker-bypass.md
 */

/** Return true when the caller is in CI (`env.CI` set to any non-falsy value). */
export function isCiEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env.CI;
  if (v === undefined || v === '') return false;
  return v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * Return true when the caller is running in CI AND has explicitly opted
 * into the asset-request pipeline bypass. `isCiEnv(env)` MUST be true;
 * we never allow the bypass flag to relax anything outside of CI (which
 * doesn't need the bypass anyway).
 */
export function isCiPipelineBypassed(env: Readonly<Record<string, string | undefined>>): boolean {
  if (!isCiEnv(env)) return false;
  const v = env.SPRITES_ALLOW_CI_PIPELINE;
  if (typeof v !== 'string') return false;
  const norm = v.trim().toLowerCase();
  return norm === 'true' || norm === '1' || norm === 'yes';
}

/**
 * Theme-equipment collection generation is a separately trusted, manual CI
 * capability. The generic asset-request worker flag is intentionally
 * insufficient: a workflow must opt in by name as well as by flag.
 */
export function isThemeEquipmentPipelineBypassed(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  if (!isCiEnv(env) || env.GITHUB_ACTIONS !== 'true') return false;
  if (env.SPRITES_ALLOW_CI_THEME_PIPELINE !== 'true') return false;
  return (
    typeof env.GITHUB_WORKFLOW_REF === 'string' &&
    env.GITHUB_WORKFLOW_REF.includes('/.github/workflows/theme-equipment.yml@')
  );
}
