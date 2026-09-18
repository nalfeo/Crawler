---
name: review-harness
description: >-
  Run Crawler's risk-based review process. Architectural or meaningfully risky
  changes receive one independent post-diff review; routine changes use tests and CI.
---

# Review Harness

Every implementation PR receives a fresh local Ducky review of the complete
diff with `codex review --uncommitted`. Fix every blocking and medium finding
before opening the PR, then rerun the affected checks. Use an additional independent review when a change is
architectural or carries meaningful correctness, security, data-loss,
determinism, or release risk. Routine, reversible changes otherwise rely on
focused tests and CI.

1. Run design review before an architectural change.
2. Complete and verify the diff.
3. Run local Ducky review on the complete diff and fix all blocking and medium
   findings.
4. If the risk trigger applies, obtain one additional independent review of the
   current diff and relevant callers and tests.
5. Fix valid findings and rerun affected checks.
6. A Codex/Ducky pass may be recorded in the PR description, a commit message,
   or a PR comment by stating that review passed and the change is okay to check in.

Do not create repository paperwork solely to prove review occurred.
