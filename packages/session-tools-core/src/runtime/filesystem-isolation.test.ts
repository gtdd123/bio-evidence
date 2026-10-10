import { describe, it, expect } from 'bun:test';
import { buildDarwinSandboxProfile } from './filesystem-isolation.ts';
import { resolve } from 'node:path';

describe('buildDarwinSandboxProfile', () => {
  it('includes session subpath write allow', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session');
    const escapedPath = resolve('/tmp/craft-session').replace(/\\/g, '\\\\');
    expect(profile).toContain(`(allow file-write* (subpath "${escapedPath}"))`);
    expect(profile).not.toContain('(deny network*)');
  });

  it('includes deny network when requested', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session', { includeNetworkDeny: true });
    expect(profile).toContain('(deny network*)');
  });
});
