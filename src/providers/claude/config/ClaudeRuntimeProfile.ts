import * as os from 'os';
import * as path from 'path';

export const CLAUDE_RUNTIME_PROFILE_IDS = ['personal', 'company'] as const;
export type ClaudeRuntimeProfileId = typeof CLAUDE_RUNTIME_PROFILE_IDS[number];

export function resolveClaudeRuntimeProfileEnvironment(
  profileId?: string,
): Record<string, string> {
  if (profileId !== 'company') return {};
  return {
    CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-company'),
  };
}
