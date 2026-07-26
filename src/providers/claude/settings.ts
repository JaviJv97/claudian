import { getProviderConfig, setProviderConfig } from '../../core/providers/providerConfig';
import { getProviderEnvironmentVariables } from '../../core/providers/providerEnvironment';
import type { HostnameCliPaths } from '../../core/types/settings';
import {
  getHostnameKey,
  getLegacyHostnameKey,
  migrateLegacyHostnameKeyedMap,
} from '../../utils/env';
import {
  type ClaudeModelEnvironmentType,
  isClaudeModelEnvironmentType,
} from './modelTiers';

export const CLAUDE_SAFE_MODES = ['acceptEdits', 'auto', 'default'] as const;
export type ClaudeSafeMode = typeof CLAUDE_SAFE_MODES[number];
export type ClaudeSettingSource = 'user' | 'project' | 'local';

export interface ClaudeCollaborationProfile {
  id: string;
  label: string;
  configDir: string;
  enabled: boolean;
}

export const DEFAULT_CLAUDE_COLLABORATION_PROFILES: readonly ClaudeCollaborationProfile[] =
  Object.freeze([
    Object.freeze({
      id: 'personal',
      label: 'Claude Personal',
      configDir: '~/.claude',
      enabled: true,
    }),
    Object.freeze({
      id: 'company',
      label: 'Claude Company',
      configDir: '~/.claude-company',
      enabled: true,
    }),
  ]);

export interface ClaudeProviderSettings {
  safeMode: ClaudeSafeMode;
  cliPath: string;
  cliPathsByHost: HostnameCliPaths;
  loadUserSettings: boolean;
  enableChrome: boolean;
  enableBangBash: boolean;
  customModels: string;
  lastModel: string;
  modelEnvironmentType: ClaudeModelEnvironmentType | '';
  titleModelEnvironmentType: ClaudeModelEnvironmentType | '';
  environmentVariables: string;
  environmentHash: string;
  collaborationProfiles: ClaudeCollaborationProfile[];
}

export const DEFAULT_CLAUDE_PROVIDER_SETTINGS: Readonly<ClaudeProviderSettings> = Object.freeze({
  safeMode: 'acceptEdits',
  cliPath: '',
  cliPathsByHost: {},
  loadUserSettings: true,
  enableChrome: false,
  enableBangBash: false,
  customModels: '',
  lastModel: 'haiku',
  modelEnvironmentType: '',
  titleModelEnvironmentType: '',
  environmentVariables: '',
  environmentHash: '',
  collaborationProfiles: DEFAULT_CLAUDE_COLLABORATION_PROFILES.map(profile => ({ ...profile })),
});

const SAFE_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeClaudeCollaborationProfiles(
  value: unknown,
): ClaudeCollaborationProfile[] {
  if (!Array.isArray(value)) {
    return DEFAULT_CLAUDE_COLLABORATION_PROFILES.map(profile => ({ ...profile }));
  }
  const seen = new Set<string>();
  const profiles: ClaudeCollaborationProfile[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    const configDir = typeof entry.configDir === 'string' ? entry.configDir.trim() : '';
    if (!SAFE_PROFILE_ID_PATTERN.test(id) || seen.has(id) || !label || !configDir) continue;
    seen.add(id);
    profiles.push({ id, label, configDir, enabled: entry.enabled !== false });
  }
  return profiles;
}

function normalizeHostnameCliPaths(value: unknown): HostnameCliPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: HostnameCliPaths = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim()) {
      result[key] = entry.trim();
    }
  }
  return result;
}

function normalizeClaudeSafeMode(value: unknown): ClaudeSafeMode | undefined {
  return (CLAUDE_SAFE_MODES as readonly unknown[]).includes(value)
    ? value as ClaudeSafeMode
    : undefined;
}

function normalizeClaudeModelEnvironmentType(
  value: unknown,
): ClaudeModelEnvironmentType | '' {
  return typeof value === 'string' && isClaudeModelEnvironmentType(value)
    ? value
    : '';
}

export function getClaudeProviderSettings(
  settings: Record<string, unknown>,
): ClaudeProviderSettings {
  const config = getProviderConfig(settings, 'claude');
  const normalizedCliPathsByHost = normalizeHostnameCliPaths(
    config.cliPathsByHost ?? settings.claudeCliPathsByHost,
  );
  const cliPathsByHost = Object.keys(normalizedCliPathsByHost).length > 0
    ? migrateLegacyHostnameKeyedMap(
      normalizedCliPathsByHost,
      getHostnameKey(),
      getLegacyHostnameKey(),
    )
    : normalizedCliPathsByHost;

  return {
    safeMode: normalizeClaudeSafeMode(config.safeMode)
      ?? normalizeClaudeSafeMode(settings.claudeSafeMode)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.safeMode,
    cliPath: (config.cliPath as string | undefined)
      ?? (settings.claudeCliPath as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.cliPath,
    cliPathsByHost,
    loadUserSettings: (config.loadUserSettings as boolean | undefined)
      ?? (settings.loadUserClaudeSettings as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.loadUserSettings,
    enableChrome: (config.enableChrome as boolean | undefined)
      ?? (settings.enableChrome as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableChrome,
    enableBangBash: (config.enableBangBash as boolean | undefined)
      ?? (settings.enableBangBash as boolean | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.enableBangBash,
    customModels: (config.customModels as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.customModels,
    lastModel: (config.lastModel as string | undefined)
      ?? (settings.lastClaudeModel as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.lastModel,
    modelEnvironmentType: normalizeClaudeModelEnvironmentType(config.modelEnvironmentType),
    titleModelEnvironmentType: normalizeClaudeModelEnvironmentType(
      config.titleModelEnvironmentType,
    ),
    environmentVariables: (config.environmentVariables as string | undefined)
      ?? getProviderEnvironmentVariables(settings, 'claude')
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentVariables,
    environmentHash: (config.environmentHash as string | undefined)
      ?? (settings.lastEnvHash as string | undefined)
      ?? DEFAULT_CLAUDE_PROVIDER_SETTINGS.environmentHash,
    collaborationProfiles: normalizeClaudeCollaborationProfiles(config.collaborationProfiles),
  };
}

export function resolveClaudeSettingSources(
  loadUserSettings: boolean,
): ClaudeSettingSource[] {
  return loadUserSettings
    ? ['user', 'project', 'local']
    : ['project', 'local'];
}

export function updateClaudeProviderSettings(
  settings: Record<string, unknown>,
  updates: Partial<ClaudeProviderSettings>,
): ClaudeProviderSettings {
  const current = getClaudeProviderSettings(settings);
  const next = {
    ...current,
    ...updates,
    safeMode: 'safeMode' in updates
      ? normalizeClaudeSafeMode(updates.safeMode) ?? current.safeMode
      : current.safeMode,
    collaborationProfiles: 'collaborationProfiles' in updates
      ? normalizeClaudeCollaborationProfiles(updates.collaborationProfiles)
      : current.collaborationProfiles,
  };
  setProviderConfig(settings, 'claude', next);
  return next;
}
