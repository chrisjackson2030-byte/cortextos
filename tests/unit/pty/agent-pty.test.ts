import { describe, it, expect, vi } from 'vitest';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

// The skip is emitted as `--permission-mode bypassPermissions` (equivalent to
// --dangerously-skip-permissions but without the CC 2.1+ interactive prompt that
// would hang a headless daemon agent). These helpers assert on that flag PAIR.
function skipsPermissions(args: string[]): boolean {
  const i = args.indexOf('--permission-mode');
  return i !== -1 && args[i + 1] === 'bypassPermissions';
}

describe('AgentPTY permission-skip toggle (--permission-mode bypassPermissions)', () => {
  it('skips permissions by default (back-compat: skip stays ON)', () => {
    expect(skipsPermissions(argsFor({}))).toBe(true);
  });

  it('skips when dangerously_skip_permissions is explicitly true', () => {
    expect(skipsPermissions(argsFor({ dangerously_skip_permissions: true }))).toBe(true);
  });

  it('does NOT skip when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(skipsPermissions(argsFor({ dangerously_skip_permissions: false }))).toBe(false);
  });

  it('skips when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(skipsPermissions(argsFor({ dangerously_skip_permissions: undefined }))).toBe(true);
  });

  it('fails safe (keeps the skip) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip.
      expect(skipsPermissions(argsFor({ dangerously_skip_permissions: 'false' as any }))).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
