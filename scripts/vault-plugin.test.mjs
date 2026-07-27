import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverVaults, installPlugin } from './vault-plugin.mjs';

function makeTemporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-vault-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function makeBuild(sourcePath) {
  writeJson(path.join(sourcePath, 'manifest.json'), {
    id: 'realclaudian',
    name: 'Claudian',
    version: '2.0.41',
  });
  fs.writeFileSync(path.join(sourcePath, 'main.js'), 'new main');
  fs.writeFileSync(path.join(sourcePath, 'styles.css'), 'new styles');
}

test('discovers registered vaults and optionally includes unregistered vaults', t => {
  const rootPath = makeTemporaryDirectory(t);
  const appDataPath = path.join(rootPath, 'AppData', 'Roaming');
  const registeredPath = path.join(rootPath, 'Documents', 'Registered');
  const unregisteredPath = path.join(rootPath, 'Documents', 'Unregistered');
  fs.mkdirSync(path.join(registeredPath, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(unregisteredPath, '.obsidian'), { recursive: true });
  writeJson(path.join(appDataPath, 'obsidian', 'obsidian.json'), {
    vaults: {
      registered: { path: registeredPath, open: true },
    },
  });

  assert.deepEqual(
    discoverVaults({ appDataDir: appDataPath, homeDir: rootPath }).map(vault => vault.path),
    [registeredPath],
  );
  assert.deepEqual(
    discoverVaults({
      appDataDir: appDataPath,
      homeDir: rootPath,
      includeUnregistered: true,
    }).map(vault => vault.path),
    [registeredPath, unregisteredPath],
  );
});

test('discovers Linux vaults from XDG_CONFIG_HOME', t => {
  const rootPath = makeTemporaryDirectory(t);
  const configPath = path.join(rootPath, 'xdg-config');
  const vaultPath = path.join(rootPath, 'vault');
  fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });
  writeJson(path.join(configPath, 'obsidian', 'obsidian.json'), {
    vaults: {
      linux: { path: vaultPath, open: true },
    },
  });

  const vaults = discoverVaults({
    homeDir: rootPath,
    platform: 'linux',
    env: { XDG_CONFIG_HOME: configPath },
  });

  assert.deepEqual(vaults.map(vault => vault.path), [vaultPath]);
});

test('discovers Linux vaults from the default home config directory', t => {
  const rootPath = makeTemporaryDirectory(t);
  const vaultPath = path.join(rootPath, 'vault');
  fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });
  writeJson(path.join(rootPath, '.config', 'obsidian', 'obsidian.json'), {
    vaults: {
      linux: { path: vaultPath },
    },
  });

  const vaults = discoverVaults({
    homeDir: rootPath,
    platform: 'linux',
    env: {},
  });

  assert.deepEqual(vaults.map(vault => vault.path), [vaultPath]);
});

test('installs and enables the plugin while preserving settings', t => {
  const rootPath = makeTemporaryDirectory(t);
  const sourcePath = path.join(rootPath, 'source');
  const vaultPath = path.join(rootPath, 'vault');
  const pluginPath = path.join(vaultPath, '.obsidian', 'plugins', 'realclaudian');
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.mkdirSync(pluginPath, { recursive: true });
  makeBuild(sourcePath);
  fs.writeFileSync(path.join(pluginPath, 'data.json'), '{"preserve":true}');
  fs.writeFileSync(path.join(pluginPath, 'main.js'), 'old main');
  fs.writeFileSync(path.join(pluginPath, 'styles.css'), 'old styles');
  writeJson(path.join(pluginPath, 'manifest.json'), {
    id: 'realclaudian',
    version: '2.0.40',
  });
  writeJson(path.join(vaultPath, '.obsidian', 'community-plugins.json'), ['dataview']);

  const result = installPlugin({
    sourcePath,
    vaultPath,
    now: new Date('2026-07-27T18:00:00.000Z'),
  });

  assert.equal(fs.readFileSync(path.join(pluginPath, 'main.js'), 'utf8'), 'new main');
  assert.equal(fs.readFileSync(path.join(pluginPath, 'data.json'), 'utf8'), '{"preserve":true}');
  assert.deepEqual(
    readJson(path.join(vaultPath, '.obsidian', 'community-plugins.json')),
    ['dataview', 'realclaudian'],
  );
  assert.equal(
    fs.readFileSync(path.join(result.backupPath, 'main.js'), 'utf8'),
    'old main',
  );
});

test('installs into the manifest id directory for a new vault', t => {
  const rootPath = makeTemporaryDirectory(t);
  const sourcePath = path.join(rootPath, 'source');
  const vaultPath = path.join(rootPath, 'vault');
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.mkdirSync(path.join(vaultPath, '.obsidian', 'plugins'), { recursive: true });
  makeBuild(sourcePath);

  const result = installPlugin({ sourcePath, vaultPath });

  assert.equal(path.basename(result.pluginPath), 'realclaudian');
  assert.equal(result.enabled, true);
  assert.equal(fs.existsSync(path.join(result.pluginPath, 'main.js')), true);
});

test('initializes an explicitly selected content-only vault', t => {
  const rootPath = makeTemporaryDirectory(t);
  const sourcePath = path.join(rootPath, 'source');
  const vaultPath = path.join(rootPath, 'content-only-vault');
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.mkdirSync(vaultPath, { recursive: true });
  fs.writeFileSync(path.join(vaultPath, '00 - Start Here.md'), '# Project');
  makeBuild(sourcePath);

  assert.throws(
    () => installPlugin({ sourcePath, vaultPath }),
    /Pass --initialize/,
  );

  const result = installPlugin({ sourcePath, vaultPath, initialize: true });

  assert.equal(result.enabled, true);
  assert.equal(fs.existsSync(path.join(vaultPath, '.obsidian')), true);
  assert.equal(fs.existsSync(path.join(result.pluginPath, 'main.js')), true);
});

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
