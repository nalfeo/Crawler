---
name: review-harness
description: >-
  Run Crawler's risk-based review process. Architectural or meaningfully risky
  changes receive one independent post-diff review; routine changes use tests and CI.
---

# Review Harness

Use independent review when a change is architectural or carries meaningful
correctness, security, data-loss, determinism, or release risk. Routine,
reversible changes rely on focused tests and CI.

1. Run design review before an architectural change.
2. Complete and verify the diff.
3. If the risk trigger applies, obtain one independent review of the current diff
   and relevant callers and tests.
4. Fix valid findings and rerun affected checks.
5. Keep review evidence in native PR reviews and threads.

Do not create repository paperwork solely to prove review occurred.
