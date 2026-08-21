import { describe, expect, it } from 'vitest';
import type {
  ConceptAudit,
  PlaceholderAuditReport,
} from '../../../scripts/sprites/placeholder-audit.js';
import { generateWiringPlan } from '../../../scripts/sprites/generate-wiring.js';

/**
 * Build a test ConceptAudit with real assets for a concept.
 */
function conceptAudit(
  concept: string,
  placeholderKind: 'mob-def' | 'sprite-registry' | 'manifest',
  placeholderId: string,
  briefId: string,
): ConceptAudit {
  return {
    concept,
    placeholders: [
      {
        kind: placeholderKind,
        id: placeholderId,
        detail: `placeholder-${placeholderId}`,
      },
    ],
    realAssets: [
      {
        briefId,
        spriteName: `${briefId}-var-0`,
        assetPath: `generated/${briefId}/var-0.png`,
        isNew: true,
      },
    ],
  };
}

/**
 * Build a test audit report.
 */
function auditReport(replaceable: readonly ConceptAudit[]): PlaceholderAuditReport {
  return {
    replaceable,
    newContent: [],
    placeholderOnly: [],
    relatedSuggestions: [],
    concepts: replaceable,
    scopedToNew: true,
    counts: {
      concepts: replaceable.length,
      replaceable: replaceable.length,
      newRealAssets: replaceable.length,
      newReplaceable: replaceable.length,
      placeholderOnly: 0,
      relatedSuggestions: 0,
    },
  };
}

describe('generateWiringPlan', () => {
  it('generates no patches when there are no replaceable placeholders', () => {
    const report = auditReport([]);
    const plan = generateWiringPlan(report);
    expect(plan.patches).toHaveLength(0);
    expect(plan.replaceableCount).toBe(0);
  });

  it('skips manifest-only placeholders', () => {
    const report = auditReport([
      conceptAudit('iron-sword', 'manifest', 'iron-sword-placeholder', 'iron-sword-v1'),
    ]);
    const plan = generateWiringPlan(report);
    expect(plan.patches).toHaveLength(0);
    expect(plan.manifestOnly).toHaveLength(1);
    expect(plan.needsWiring).toHaveLength(0);
  });

  it('skips mob-def patches until block-aware anchoring is implemented', () => {
    const report = auditReport([conceptAudit('slime', 'mob-def', 'slime-mob', 'slime')]);
    const plan = generateWiringPlan(report);
    expect(plan.patches).toHaveLength(0);
    expect(plan.needsWiring).toHaveLength(1);
  });

  it('generates sprite-registry patches using manifest texture keys', () => {
    const report = auditReport([conceptAudit('rat', 'sprite-registry', 'enemy.rat', 'rat')]);
    const plan = generateWiringPlan(report);
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0]?.newText).toContain('rat-var-0');
    expect(plan.needsWiring).toHaveLength(1);
  });

  it('includes summary text in the plan', () => {
    const report = auditReport([
      conceptAudit('slime', 'mob-def', 'slime-mob', 'slime'),
      conceptAudit('gem', 'manifest', 'gem-placeholder', 'gem-v1'),
    ]);
    const plan = generateWiringPlan(report);
    expect(plan.summary).toContain('Wiring Plan Summary');
    expect(plan.summary).toContain('Replaceable placeholders found: 2');
    expect(plan.summary).toContain('Manifest-only');
    expect(plan.summary).toContain('Need wiring');
  });

  it('categorizes placeholders correctly', () => {
    const report = auditReport([
      conceptAudit('slime', 'mob-def', 'slime-mob', 'slime'),
      conceptAudit('rat', 'sprite-registry', 'enemy.rat', 'rat'),
      conceptAudit('gem', 'manifest', 'gem-placeholder', 'gem-v1'),
    ]);
    const plan = generateWiringPlan(report);
    expect(plan.replaceableCount).toBe(3);
    expect(plan.manifestOnly).toHaveLength(1);
    expect(plan.needsWiring).toHaveLength(2);
  });
});
