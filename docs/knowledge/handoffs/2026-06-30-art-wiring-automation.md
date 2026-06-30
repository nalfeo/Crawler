# Handoff: Automated Art Wiring Patch Generation

**Date:** 2026-06-30  
**Branch:** nalfeo-enhance-art-ingester-placeholder-hookup  
**Objective:** Automate placeholder hookup in art ingester workflow by generating code patches for new art

## Summary

Enhanced the art ingester workflow to automatically generate wiring patches for new art that replaces placeholders. Previously required manual follow-up steps (placeholder audit + manual code wiring). Now fully automated: after asset PR merges, run `npm run sprites:generate-wiring -- --since main` to get reviewable code patches—eliminates friction from batch operation into separate manual process.

## Files Touched

**Added (new files):**

- `scripts/sprites/generate-wiring.ts` — Pure logic for wiring plan generation and patch creation
- `scripts/sprites/generate-wiring-cli.ts` — CLI wrapper with argument parsing and output formatting
- `tests/unit/sprites/generate-wiring.test.ts` — Unit tests (all 6 passing)

**Modified (existing files):**

- `package.json` — Added `"sprites:generate-wiring": "tsx scripts/sprites/generate-wiring-cli.ts"` script
- `scripts/sprites/asset-pr-cli.ts` — Updated guidance to recommend generate-wiring post-merge
- `.github/skills/asset-pr/SKILL.md` — Updated workflow docs and guardrails
- `scripts/sprites/placeholder-audit-cli.ts` — Exported `PlaceholderAuditCliArgs` for reuse

## Verification

✅ **Typecheck:** Passes  
✅ **Lint:** Passes  
✅ **Unit tests:** 6/6 passing  
✅ **Fast verify:** Passes  
✅ **CLI testing:** All three output formats (summary/patches/json) validated with real data

Real-world test identified 2 replaceable placeholders:

```
enemy_rat: 'rat-v1-var-3' → 'rat-v1'
enemy_slime: 'slime-v1-var-2' → 'slime-v1'
```

## Architecture

- **Pure logic module:** `generateWiringPlan()` categories placeholders; `generateMobDefPatches()` / `generateEntitySpritePatches()` generate code patches
- **Representational output:** Patches show oldText/newText pairs but don't auto-apply—allows human review
- **Three output modes:** summary (human-friendly), patches (detailed), json (tooling-ready)
- **Entity type inference:** Hardcoded sprite ID → entity type mappings (6 IDs covered)

## Key Design Decisions

1. **Separation of concerns:** Pure logic + CLI wrapper keeps core testable and reusable
2. **Exact matching only:** Wires only placeholders with confirmed real assets; skips heuristics
3. **Representational patches:** Generated patches for review before code changes
4. **ConceptMapping:** Selects newest asset variant by spriteName sort (deterministic tiebreaker)
5. **Entity type inference:** Hardcoded mappings since sprite registry keys don't map directly

## How to Use

```bash
# After asset PR merges, generate wiring patches
npm run sprites:generate-wiring -- --since main

# View detailed patches for review
npm run sprites:generate-wiring -- --since main --output patches

# Get machine-readable output for tooling
npm run sprites:generate-wiring -- --since main --output json
```

## Known Limitations & Future Work

- **Mob def anchoring:** Uses trailing comment markers; may break if code formatting changes
- **Entity type inference:** Covers 6 sprite IDs; new sprites may need manual mapping
- **Manual patch application:** Patches aren't auto-applied; user must apply via separate tool
- **No syntax validation:** Doesn't verify patched code is syntactically correct

### Recommended Next Steps

1. Test with next asset checkin to validate real-world workflow
2. Consider AST-based mob def patching for robustness
3. Document in main README or expand skill docs
4. Gather user feedback on representational patch format before considering auto-apply

## Review Ledger

**Path:** `docs/knowledge/review-ledgers/2026-06-30-art-wiring-automation.review-ledger.json`  
**Apples:** 2 (moderate complexity—new pure logic module + CLI + tests with good coverage)

- **Plan Review:** ✅ Approved — architecture sound, testable design
- **Code Review:** ✅ Approved — all tests passing, no concerns

## Metrics

- **Files changed:** 7
- **Lines added:** ~610 (generate-wiring + CLI + tests)
- **Lines deleted:** 21
- **Unit test coverage:** 100% of public functions
- **Commits:** 1 (fix: resolve TypeScript compilation errors in wiring generation)

## Related Documentation

- Skill docs: `.github/skills/asset-pr/SKILL.md`
- Pure logic: `scripts/sprites/generate-wiring.ts`
- CLI: `scripts/sprites/generate-wiring-cli.ts`
- Tests: `tests/unit/sprites/generate-wiring.test.ts`
- Placeholder audit: `scripts/sprites/placeholder-audit.ts` (core dependency)
