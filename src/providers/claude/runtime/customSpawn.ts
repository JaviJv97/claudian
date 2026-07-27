import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { type ChildProcess, spawn } from 'child_process';

import { ClaudeProcessRegistry } from '../../../core/runtime/ClaudeProcessRegistry';
import { cliPathRequiresNode, findNodeExecutable } from '../../../utils/env';
import {
  resolveWindowsCmdShimSpawnSpec,
  terminateSpawnedProcess,
  type WindowsCmdShimSpawnSpec,
} from '../../../utils/windowsCmdShim';

const FORCE_KILL_DELAY_MS = 2_000;

export function createCustomSpawnFunction(
  enhancedPath: string
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    let { command } = options;
    let { args } = options;
    const { cwd, env, signal } = options;
    const shouldPipeStderr = !!env?.DEBUG_CLAUDE_AGENT_SDK;

    // The SDK only routes some script extensions through `node`; normalize the
    // remaining Node-backed paths here before Electron spawns with shell=false.
    if (command === 'node' || cliPathRequiresNode(command)) {
      const nodeFullPath = findNodeExecutable(enhancedPath);
      if (command === 'node') {
        if (nodeFullPath) {
          command = nodeFullPath;
        }
      } else {
        args = [command, ...args];
        command = nodeFullPath ?? 'node';
      }
    }

    const resolvedSpawnSpec = resolveWindowsCmdShimSpawnSpec({ args, command });
    const usePosixProcessGroup = process.platform !== 'win32';
    ClaudeProcessRegistry.assertCanSpawn();

    // Do not pass `signal` directly to spawn() — Obsidian's Electron runtime
    // uses a different realm for AbortSignal, causing `instanceof EventTarget`
    // checks inside Node's internals to fail. Handle abort manually instead.
    const child = spawn(resolvedSpawnSpec.command, resolvedSpawnSpec.args, {
      cwd,
      env: env,
      stdio: ['pipe', 'pipe', shouldPipeStderr ? 'pipe' : 'ignore'],
      windowsHide: true,
      // Claude launches MCP servers and other helpers. A dedicated POSIX process
      // group lets runtime cleanup terminate the complete tree instead of only
      // dropping the top-level CLI process.
      ...(usePosixProcessGroup ? { detached: true } : {}),
      ...(resolvedSpawnSpec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    installTreeAwareKill(child, resolvedSpawnSpec, usePosixProcessGroup);
    ClaudeProcessRegistry.register(child);

    if (signal) {
      const killChild = (): void => {
        ClaudeProcessRegistry.markShutdownRequested(child);
        child.kill('SIGTERM');
        scheduleForcedKill(child);
      };
      if (signal.aborted) {
        killChild();
      } else {
        signal.addEventListener('abort', killChild, { once: true });
        child.once('exit', () => signal.removeEventListener('abort', killChild));
      }
    }

    if (shouldPipeStderr && child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', () => {});
    }

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to create process streams');
    }

    return child as unknown as SpawnedProcess;
  };
}

function installTreeAwareKill(
  child: ChildProcess,
  spawnSpec: WindowsCmdShimSpawnSpec,
  usePosixProcessGroup: boolean,
): void {
  if (!spawnSpec.killProcessTree && !usePosixProcessGroup) {
    return;
  }

  const originalKill = child.kill.bind(child);
  const callOriginalKill = (signal?: NodeJS.Signals | number): boolean =>
    originalKill(signal);
  const killableChild = {
    get pid(): number | undefined {
      return child.pid;
    },
    kill: callOriginalKill,
  };

  child.kill = ((signal?: NodeJS.Signals | number): boolean => {
    ClaudeProcessRegistry.markShutdownRequested(child);
    if (usePosixProcessGroup && typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return callOriginalKill(signal);
      }
    }
    return terminateSpawnedProcess(killableChild, signal, spawn, spawnSpec);
  });
}

function scheduleForcedKill(child: ChildProcess): void {
  window.setTimeout(() => {
    // Retry the process-group kill even if the top-level Claude process has
    // already exited: an MCP descendant may still be keeping the group alive.
    child.kill('SIGKILL');
  }, FORCE_KILL_DELAY_MS);
}
