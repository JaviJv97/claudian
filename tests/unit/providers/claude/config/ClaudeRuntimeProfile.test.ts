import * as os from 'os';
import * as path from 'path';

import { resolveClaudeRuntimeProfileEnvironment } from '@/providers/claude/config/ClaudeRuntimeProfile';

describe('resolveClaudeRuntimeProfileEnvironment', () => {
  it('uses the normal Claude home for the personal profile', () => {
    expect(resolveClaudeRuntimeProfileEnvironment('personal')).toEqual({});
  });

  it('isolates the company profile in its own Claude config directory', () => {
    expect(resolveClaudeRuntimeProfileEnvironment('company')).toEqual({
      CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-company'),
    });
  });

  it('does not invent an environment for unknown profiles', () => {
    expect(resolveClaudeRuntimeProfileEnvironment('unknown')).toEqual({});
  });
});
