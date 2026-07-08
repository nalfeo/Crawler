export interface HoverTooltipTarget {
  readonly kind: 'rect' | 'point';
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly radius?: number;
  readonly title: string;
  readonly lines: readonly string[];
}

function containsPoint(target: HoverTooltipTarget, x: number, y: number): boolean {
  if (target.kind === 'rect') {
    const width = target.width ?? 0;
    const height = target.height ?? 0;
    return x >= target.x && x < target.x + width && y >= target.y && y < target.y + height;
  }
  const radius = target.radius ?? 0;
  const dx = x - target.x;
  const dy = y - target.y;
  return dx * dx + dy * dy <= radius * radius;
}

export function collectHoverTargetsAtPoint(
  targets: readonly HoverTooltipTarget[],
  x: number,
  y: number,
): HoverTooltipTarget[] {
  const hits: HoverTooltipTarget[] = [];
  const seen = new Set<string>();
  for (let i = targets.length - 1; i >= 0; i--) {
    const target = targets[i]!;
    if (!containsPoint(target, x, y)) continue;
    const signature = `${target.kind}:${target.x}:${target.y}:${target.width ?? ''}:${target.height ?? ''}:${
      target.radius ?? ''
    }:${target.title}:${target.lines.join('|')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    hits.push(target);
  }
  return hits;
}

export interface HoverTooltipContent {
  readonly title: string;
  readonly lines: readonly string[];
}

export function buildHoverTooltipContent(
  targets: readonly HoverTooltipTarget[],
): HoverTooltipContent {
  if (targets.length === 0) {
    return { title: '', lines: [] };
  }
  if (targets.length === 1) {
    const target = targets[0]!;
    return { title: target.title, lines: [...target.lines] };
  }
  const lines: string[] = [];
  for (const target of targets) {
    lines.push(`• ${target.title}`);
    for (const line of target.lines) {
      lines.push(`  ${line}`);
    }
  }
  return {
    title: `Overlapping regions (${targets.length})`,
    lines,
  };
}
