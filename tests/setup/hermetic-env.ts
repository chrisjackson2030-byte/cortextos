/**
 * tests/setup/hermetic-env.ts
 *
 * Global vitest setup: strip any ambient CTX_* environment variables that leak
 * in when `npm test` is run from inside a live cortextOS agent shell (the
 * daemon exports CTX_FRAMEWORK_ROOT / CTX_AGENT_DIR / CTX_PROJECT_ROOT / etc.
 * pointing at the LIVE install).
 *
 * Why this exists: several suites rely on a clean env —
 *   - src/utils/env.ts `resolveEnv` refuses to run when a fixture overrides
 *     CTX_FRAMEWORK_ROOT but CTX_AGENT_DIR/CTX_PROJECT_ROOT are inherited from
 *     the parent shell (the #313 sandbox/live-leak guard). Integration tests
 *     that spawn `dist/cli.js` with `{ ...process.env, CTX_FRAMEWORK_ROOT: fixture }`
 *     would otherwise carry the live CTX_AGENT_DIR and hit the guard.
 *   - src/bus/hooks.ts and src/hooks/hook-crash-alert.ts branch on whether
 *     CTX_FRAMEWORK_ROOT is set (PATH-unaware execFile hardening). Their unit
 *     tests assert the documented "unset in unit tests" legacy branch.
 *
 * Clearing every CTX_* key at setup makes the suite hermetic and deterministic
 * regardless of the shell it is launched from — identical to a clean CI shell.
 * No test relies on an ambient CTX_* value being preset (tests that need one set
 * it themselves in their own beforeEach, which runs AFTER this module loads).
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) {
    delete process.env[key];
  }
}
