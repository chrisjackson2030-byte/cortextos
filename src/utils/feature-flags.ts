import { readFileSync } from 'fs';

const FEATURE_FLAGS_PATH = '/Users/chrisjackson/cortextos/orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json';

/**
 * Resolve the flags file path. Defaults to the production jarvis-core path so
 * runtime behavior is unchanged. Tests (and only tests) may set
 * CTX_FEATURE_FLAGS_PATH to a temp file to drive flags deterministically without
 * touching the production flags file. When the override is absent, behavior is
 * byte-identical to before (read the hardcoded production path; all-false there).
 */
function flagsPath(): string {
  const override = process.env.CTX_FEATURE_FLAGS_PATH;
  return override && override.trim() ? override : FEATURE_FLAGS_PATH;
}

export function isFeatureEnabled(flag: string): boolean {
  try {
    const flags = JSON.parse(readFileSync(flagsPath(), 'utf-8')) as Record<string, unknown>;
    return flags[flag] === true;
  } catch {
    return false;
  }
}
