import type { ChildProcess } from 'node:child_process';

import { ClaudeProcessRegistry } from '@/core/runtime/ClaudeProcessRegistry';

interface MockChild {
  child: ChildProcess;
  exit: () => void;
}

function createMockChild(pid: number): MockChild {
  let exitListener: (() => void) | undefined;
  const child = {
    exitCode: null,
    kill: jest.fn().mockReturnValue(true),
    once: jest.fn((event: string, listener: () => void) => {
      if (event === 'exit') exitListener = listener;
      return child;
    }),
    pid,
  } as unknown as ChildProcess;
  return {
    child,
    exit: () => {
      Object.defineProperty(child, 'exitCode', { value: 0 });
      exitListener?.();
    },
  };
}

describe('ClaudeProcessRegistry', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    ClaudeProcessRegistry.resetForTests();
  });

  afterEach(() => {
    ClaudeProcessRegistry.resetForTests();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    jest.useRealTimers();
  });

  it('blocks a seventh concurrent plugin-owned Claude process group', () => {
    for (let index = 0; index < 6; index += 1) {
      ClaudeProcessRegistry.assertCanSpawn();
      ClaudeProcessRegistry.register(createMockChild(10_000 + index).child);
    }

    expect(() => ClaudeProcessRegistry.assertCanSpawn())
      .toThrow('Claude runtime safety limit reached (6 process groups)');
  });

  it('stays bounded across 100 create and confirmed-exit cycles', () => {
    for (let index = 0; index < 100; index += 1) {
      ClaudeProcessRegistry.assertCanSpawn();
      const mock = createMockChild(20_000 + index);
      ClaudeProcessRegistry.register(mock.child);
      mock.exit();
      jest.advanceTimersByTime(2_500);
      expect(ClaudeProcessRegistry.getSnapshot().activeGroups).toBe(0);
    }
  });

  it('terminates only processes registered by this plugin', () => {
    const first = createMockChild(30_001);
    const second = createMockChild(30_002);
    ClaudeProcessRegistry.register(first.child);
    ClaudeProcessRegistry.register(second.child);

    ClaudeProcessRegistry.terminateAll();

    expect(first.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(second.child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ClaudeProcessRegistry.getSnapshot().terminatingGroups).toBe(2);
  });
});
