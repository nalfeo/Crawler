# Dependency Upgrade Procedure

## Why versions are pinned

All direct dependencies, devDependencies, optionalDependencies, and overrides in
`package.json` must use **exact version strings** (e.g. `"4.1.0"`, not `"^4.1.0"`).

**The problem this solves:** Microsoft's internal npm proxy enforces a mandatory
seven-day quarantine before a newly published package version is mirrored. If a
dependency uses a semver range (e.g. `^4.1.0`) and an unrelated `npm install
--package-lock-only` runs after a new release lands, the lockfile can advance to
the new version before the proxy mirrors it. The next `npm ci` then fails with a
false 404, blocking local work and open PRs—even for commits that have nothing to
do with dependencies.

Exact versions prevent this by ensuring that no direct package version can advance
without an explicit, intentional edit to `package.json`.

> **Scope note:** Exact top-level pinning guards against _direct_ dependency drift.
> Transitive dependency versions are locked by `package-lock.json` separately, but
> upstream package ranges may still allow transitive churn. The exact-deps policy
> is the primary control for the direct layer; the lockfile is the control for
> transitives.

## Enforcement

A blocking CI check (`npm run security:exact-deps`) rejects any PR that introduces
a semver range in a direct dependency. The check is also included in
`npm run security:check` for local runs.

`.npmrc` at the repo root sets `save-exact=true` so that `npm install <pkg>` and
`npm install --save-dev <pkg>` always write an exact version to `package.json`
by default.

Every dependency PR also has to pass two independent lockfile controls:

- `npm run security:lock-integrity` rejects lockfile-only changes and rejects any
  newly selected package version published within the seven-day proxy quarantine.
- CI runs a cacheless `npm ci --ignore-scripts` on dependency changes. The normal
  CI setup also runs `npm ci` on every job instead of treating a cached
  `node_modules` tree as proof that the lockfile is installable.

## How to intentionally upgrade a dependency

Follow this procedure to bump a direct dependency to a newer version:

1. **Confirm the version is available on the Microsoft proxy.** Wait at least
   seven days after the target version's npm publish date before attempting to
   install it. Check https://www.npmjs.com/package/<pkg> for the publish date.

2. **Edit `package.json` directly.** Change the version field for the target
   package to the new exact version string (no `^` or `~`):

   ```json
   "typescript": "6.1.0"
   ```

3. **Update the lockfile:**

   ```sh
   npm install --package-lock-only
   ```

   This regenerates `package-lock.json` without touching `node_modules`.

4. **Verify the installation works locally:**

   ```sh
   npm ci
   npm run verify:fast
   ```

5. **Open a dedicated dependency-upgrade PR.** Mixing a version bump with
   unrelated code changes makes it harder to bisect regressions. Keep dependency
   upgrades in their own PR with a clear description of what changed and why.

6. **Check for advisory vulnerabilities:**
   ```sh
   npm run security:audit
   ```

The cold install and lock-integrity checks must both pass before merge. If the
registry proxy has not mirrored the target release, wait until the reported
eligible date rather than bypassing the check.

## How to add a new dependency

1. Use `npm install <pkg>@<exact-version>` (the `save-exact=true` in `.npmrc`
   ensures the exact version is written to `package.json`).

2. Confirm the package is trusted. Add it to `TRUSTED_PACKAGES` or `TRUSTED_SCOPES`
   in `scripts/agent/security/check-deps.ts` with a comment explaining the
   publisher, license, and use-case. See the existing entries for examples.

3. Run `npm run security:check` to confirm no new audit findings and the version
   is exact.

4. Open a PR. The `security:exact-deps` CI step will reject non-exact versions
   automatically.

## How to temporarily allow a non-exact specifier

In rare cases (e.g. a workspace alias, a git-URL dep, or a local `file:` path),
a non-exact specifier may be unavoidable. Add an exemption entry to the
`EXACT_VERSION_EXEMPTIONS` array in `scripts/agent/security/check-exact-deps.mjs`:

```js
const EXACT_VERSION_EXEMPTIONS = [
  {
    field: 'dependencies',
    name: 'my-workspace-pkg',
    version: 'workspace:*',
    reason: 'workspace alias — must use workspace:*',
  },
];
```

Each entry must include:

- `field`: the package.json field path (`"dependencies"`, `"devDependencies"`,
  `"overrides"`, or a nested override path like `"overrides/parent"`)
- `name`: the exact package name
- `version`: the **exact specifier string** that is permitted (e.g. `"workspace:*"`,
  `"file:../local"`)
- `reason`: a short explanation of why an exact pin is not used

**Important:** The exemption is bound to the specific `(field, name, version)` triple.
A later change to a different specifier on the same entry (e.g. accidentally
introducing `"^1.2.3"`) will still be flagged as a violation. This prevents the
exemption from silently covering unintended range introductions.

Exemptions are subject to review and should be minimized.

## Upgrading npm audit exceptions

If `npm run security:audit` reports a blocked advisory that is already
temporarily excepted in `scripts/agent/security/npm-audit.mjs`, you may need to
extend the `expiresOn` date if the patched release still has not been mirrored.
Update only after confirming the advisory remains unpatched or the mirror is still
pending.
