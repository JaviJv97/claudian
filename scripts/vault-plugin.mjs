#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ARTIFACTS = ['main.js', 'manifest.json', 'styles.css'];
const SCAN_SKIP_NAMES = new Set([
  '.cache',
  '.git',
  'AppData',
  'node_modules',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.claudian-tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function getDefaultRegistryPaths({
  appDataDir,
  homeDir,
  platform = process.platform,
  env = process.env,
}) {
  if (appDataDir) {
    return [path.join(appDataDir, 'obsidian', 'obsidian.json')];
  }
  if (platform === 'win32' && env.APPDATA) {
    return [path.join(env.APPDATA, 'obsidian', 'obsidian.json')];
  }
  if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    return [path.join(configHome, 'obsidian', 'obsidian.json')];
  }
  if (platform === 'darwin') {
    return [path.join(homeDir, 'Library', 'Application Support', 'obsidian', 'obsidian.json')];
  }
  return [];
}

function getRegisteredVaults(registryPaths) {
  const vaults = [];
  for (const registryPath of registryPaths) {
    if (!fs.existsSync(registryPath)) {
      continue;
    }
    const registry = readJson(registryPath);
    vaults.push(...Object.entries(registry.vaults ?? {})
      .filter(([, entry]) => typeof entry?.path === 'string')
      .map(([registryId, entry]) => ({
        path: path.resolve(entry.path),
        registryId,
        registered: true,
        open: entry.open === true,
      })));
  }
  return vaults;
}

function scanForVaults(rootPath) {
  const vaults = [];
  const pending = [path.resolve(rootPath)];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    if (entries.some(entry => entry.isDirectory() && entry.name === '.obsidian')) {
      vaults.push(currentPath);
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.obsidian' || SCAN_SKIP_NAMES.has(entry.name)) {
        continue;
      }
      pending.push(path.join(currentPath, entry.name));
    }
  }

  return vaults;
}

export function discoverVaults({
  appDataDir,
  homeDir = os.homedir(),
  includeUnregistered = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  const registryPaths = getDefaultRegistryPaths({
    appDataDir,
    homeDir,
    platform,
    env,
  });
  const registeredVaults = getRegisteredVaults(registryPaths);
  const vaultMap = new Map(
    registeredVaults.map(vault => [path.normalize(vault.path).toLowerCase(), vault]),
  );

  if (includeUnregistered) {
    for (const vaultPath of scanForVaults(homeDir)) {
      const key = path.normalize(vaultPath).toLowerCase();
      if (!vaultMap.has(key)) {
        vaultMap.set(key, {
          path: vaultPath,
          registered: false,
          open: false,
        });
      }
    }
  }

  return [...vaultMap.values()].sort((left, right) => {
    if (left.open !== right.open) {
      return left.open ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });
}

export function inspectVault(vaultPath, pluginId) {
  const resolvedVaultPath = path.resolve(vaultPath);
  const configPath = path.join(resolvedVaultPath, '.obsidian');
  const pluginPath = path.join(configPath, 'plugins', pluginId);
  const manifestPath = path.join(pluginPath, 'manifest.json');
  const communityPluginsPath = path.join(configPath, 'community-plugins.json');
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  let enabledPlugins = [];

  if (fs.existsSync(communityPluginsPath)) {
    try {
      const parsed = readJson(communityPluginsPath);
      enabledPlugins = Array.isArray(parsed) ? parsed : [];
    } catch {
      enabledPlugins = [];
    }
  }

  return {
    path: resolvedVaultPath,
    configPath,
    pluginPath,
    installed: manifest !== null,
    enabled: enabledPlugins.includes(pluginId),
    version: manifest?.version ?? null,
  };
}

function makeBackup(pluginPath, configPath, pluginId, timestamp) {
  const existingArtifacts = PLUGIN_ARTIFACTS.filter(fileName =>
    fs.existsSync(path.join(pluginPath, fileName)));
  if (existingArtifacts.length === 0) {
    return null;
  }

  const backupPath = path.join(
    configPath,
    'plugin-backups',
    `${pluginId}-${timestamp.replaceAll(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(backupPath, { recursive: true });
  for (const fileName of existingArtifacts) {
    fs.copyFileSync(path.join(pluginPath, fileName), path.join(backupPath, fileName));
  }
  return backupPath;
}

export function installPlugin({
  sourcePath,
  vaultPath,
  enable = true,
  dryRun = false,
  initialize = false,
  now = new Date(),
}) {
  const resolvedSourcePath = path.resolve(sourcePath);
  const manifestPath = path.join(resolvedSourcePath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Plugin manifest not found: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath);
  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    throw new Error('Plugin manifest must contain a non-empty id.');
  }

  for (const fileName of PLUGIN_ARTIFACTS) {
    const artifactPath = path.join(resolvedSourcePath, fileName);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Plugin build artifact not found: ${artifactPath}`);
    }
  }

  const vault = inspectVault(vaultPath, manifest.id);
  if (!fs.existsSync(vault.configPath)) {
    if (!initialize) {
      throw new Error(
        `Obsidian configuration directory not found: ${vault.configPath}. `
        + 'Pass --initialize to create it for an explicitly selected vault.',
      );
    }
    if (!fs.existsSync(vault.path) || !fs.statSync(vault.path).isDirectory()) {
      throw new Error(`Vault directory not found: ${vault.path}`);
    }
  }

  if (dryRun) {
    return {
      ...vault,
      pluginId: manifest.id,
      version: manifest.version,
      backupPath: null,
      dryRun: true,
      initialize,
    };
  }

  fs.mkdirSync(vault.configPath, { recursive: true });
  fs.mkdirSync(vault.pluginPath, { recursive: true });
  const backupPath = makeBackup(
    vault.pluginPath,
    vault.configPath,
    manifest.id,
    now.toISOString(),
  );

  for (const fileName of PLUGIN_ARTIFACTS) {
    const destinationPath = path.join(vault.pluginPath, fileName);
    const temporaryPath = `${destinationPath}.claudian-tmp`;
    fs.copyFileSync(path.join(resolvedSourcePath, fileName), temporaryPath);
    fs.renameSync(temporaryPath, destinationPath);
  }

  if (enable) {
    const communityPluginsPath = path.join(vault.configPath, 'community-plugins.json');
    let enabledPlugins = [];
    if (fs.existsSync(communityPluginsPath)) {
      const parsed = readJson(communityPluginsPath);
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected a JSON array in ${communityPluginsPath}`);
      }
      enabledPlugins = parsed;
    }
    if (!enabledPlugins.includes(manifest.id)) {
      writeJsonAtomic(communityPluginsPath, [...enabledPlugins, manifest.id]);
    }
  }

  return {
    ...inspectVault(vaultPath, manifest.id),
    pluginId: manifest.id,
    version: manifest.version,
    backupPath,
    dryRun: false,
  };
}

function parseArguments(args) {
  const options = {
    includeUnregistered: false,
    dryRun: false,
    enable: true,
    registered: false,
    initialize: false,
    vaultPaths: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--include-unregistered') {
      options.includeUnregistered = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--no-enable') {
      options.enable = false;
    } else if (argument === '--registered') {
      options.registered = true;
    } else if (argument === '--initialize') {
      options.initialize = true;
    } else if (argument === '--vault') {
      index += 1;
      if (!args[index]) {
        throw new Error('--vault requires a path.');
      }
      options.vaultPaths.push(args[index]);
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.vaultPaths.push(argument);
    }
  }

  return options;
}

function formatStatus(vault, pluginId) {
  const state = inspectVault(vault.path, pluginId);
  const installation = state.installed ? `installed ${state.version}` : 'not installed';
  const enabled = state.enabled ? 'enabled' : 'disabled';
  const source = vault.registered ? (vault.open ? 'registered, open' : 'registered') : 'unregistered';
  return `${vault.path}\n  ${source}; ${installation}; ${enabled}`;
}

function run() {
  const scriptPath = fileURLToPath(import.meta.url);
  const sourcePath = path.resolve(path.dirname(scriptPath), '..');
  const command = process.argv[2] ?? 'list';
  const options = parseArguments(process.argv.slice(3));
  const manifest = readJson(path.join(sourcePath, 'manifest.json'));

  if (command === 'list') {
    const vaults = discoverVaults({ includeUnregistered: options.includeUnregistered });
    process.stdout.write(`${vaults.map(vault => formatStatus(vault, manifest.id)).join('\n')}\n`);
    return;
  }

  if (command !== 'install') {
    throw new Error(`Unknown command: ${command}. Use "list" or "install".`);
  }

  let vaultPaths = options.vaultPaths;
  if (options.registered) {
    vaultPaths = discoverVaults().map(vault => vault.path);
  }
  if (vaultPaths.length === 0) {
    throw new Error('Specify a vault path or pass --registered.');
  }

  for (const vaultPath of vaultPaths) {
    const result = installPlugin({
      sourcePath,
      vaultPath,
      enable: options.enable,
      dryRun: options.dryRun,
      initialize: options.initialize,
    });
    const action = result.dryRun ? 'Would install' : 'Installed';
    process.stdout.write(`${action} ${result.pluginId} ${result.version} in ${result.path}\n`);
    if (result.backupPath) {
      process.stdout.write(`Backup: ${result.backupPath}\n`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
