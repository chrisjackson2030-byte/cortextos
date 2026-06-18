import { readFileSync } from 'fs';

const FEATURE_FLAGS_PATH = '/Users/chrisjackson/cortextos/orgs/main/agents/jarvis/state/jarvis-core/feature-flags.json';

export function isFeatureEnabled(flag: string): boolean {
  try {
    const flags = JSON.parse(readFileSync(FEATURE_FLAGS_PATH, 'utf-8')) as Record<string, unknown>;
    return flags[flag] === true;
  } catch {
    return false;
  }
}
