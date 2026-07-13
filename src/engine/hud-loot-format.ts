export function formatCompactLootValue(value: number): string {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (normalized < 1_000) return String(normalized);
  if (normalized < 999_500) return `${Math.round(normalized / 1_000)}K`;
  if (normalized < 9_950_000) return `${(Math.round(normalized / 100_000) / 10).toFixed(1)}M`;
  return `${Math.min(99, Math.round(normalized / 1_000_000))}M`;
}
