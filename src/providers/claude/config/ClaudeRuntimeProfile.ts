import { createHash } from 'crypto';
import * as os from 'os';
import * as path from 'path';

import { expandHomePath } from '../../../utils/path';
import { getClaudeProviderSettings } from '../settings';

export interface ClaudeRuntimeProfileBinding {
  runtimeProfileId: string;
  configDir: string;
  fingerprint: string;
}

export function resolveClaudeRuntimeProfileBinding(
  profileId?: string,
  settings?: Record<string, unknown>,
): ClaudeRuntimeProfileBinding | null {
  if (!profileId) return null;
  const profile = getClaudeProviderSettings(settings ?? {}).collaborationProfiles
    .find(candidate => candidate.id === profileId && candidate.enabled);
  if (!profile) return null;
  const configDir = path.resolve(expandHomePath(profile.configDir));
  return {
    runtimeProfileId: profile.id,
    configDir,
    fingerprint: createHash('sha256')
      .update(`${profile.id}\0${process.platform}\0${configDir}`)
      .digest('hex'),
  };
}

export function resolveClaudeRuntimeProfileEnvironment(
  profileId?: string,
  settings?: Record<string, unknown>,
): Record<string, string> {
  const binding = resolveClaudeRuntimeProfileBinding(profileId, settings);
  if (!binding) return {};
  const configDir = binding.configDir;
  if (path.resolve(configDir) === path.resolve(os.homedir(), '.claude')) return {};
  return {
    CLAUDE_CONFIG_DIR: configDir,
  };
}
