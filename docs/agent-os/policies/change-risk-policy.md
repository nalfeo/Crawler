# Change Risk Policy

Use independent review when a change is architectural or carries meaningful
correctness, security, data-loss, determinism, or release risk. Routine,
reversible changes rely on focused tests and CI.

When independent review is warranted, request it after the complete diff is
ready, address valid findings, and keep the evidence in native pull-request
reviews and threads. Architectural changes also receive design review before
implementation and record durable decisions in an ADR when appropriate.

Do not create estimates, scores, calibration records, review ledgers, or other
repository artifacts solely to prove that review occurred.
