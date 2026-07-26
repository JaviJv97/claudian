import * as os from 'os';
import * as path from 'path';

import { expandHomePath } from '../../../utils/path';
import { getClaudeProviderSettings } from '../settings';

export function resolveClaudeRuntimeProfileEnvironment(
  profileId?: string,
  settings?: Record<string, unknown>,
): Record<string, string> {
  if (!profileId) return {};
  const profile = getClaudeProviderSettings(settings ?? {}).collaborationProfiles
    .find(candidate => candidate.id === profileId && candidate.enabled);
  if (!profile) return {};
  const configDir = expandHomePath(profile.configDir);
  if (path.resolve(configDir) === path.resolve(os.homedir(), '.claude')) return {};
  return {
    CLAUDE_CONFIG_DIR: configDir,
  };
}
