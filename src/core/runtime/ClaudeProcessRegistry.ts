import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

const MAX_PROCESS_GROUPS = 6;
const WARNING_RSS_BYTES = 3 * 1024 ** 3;
const PAUSE_RSS_BYTES = 4 * 1024 ** 3;
const CRITICAL_RSS_BYTES = 5 * 1024 ** 3;
const WATCHDOG_INTERVAL_MS = 30_000;

export type ClaudeProcessHealth = 'healthy' | 'warning' | 'paused' | 'critical';

interface TrackedClaudeProcess {
  child: ChildProcess;
  createdAt: number;
  groupId: number;
  rootExited: boolean;
  shutdownRequestedAt?: number;
}

export interface ClaudeProcessRegistrySnapshot {
  activeGroups: number;
  backgroundWorkPaused: boolean;
  health: ClaudeProcessHealth;
  oldestGroupAgeMs: number;
  residentBytes: number | null;
  terminatingGroups: number;
}

type SnapshotListener = (snapshot: ClaudeProcessRegistrySnapshot) => void;

/**
 * Renderer-local ownership boundary for every Claude process spawned by Claudian.
 * It deliberately knows nothing about unrelated terminal Claude sessions.
 */
export class ClaudeProcessRegistry {
  private static readonly records = new Map<number, TrackedClaudeProcess>();
  private static readonly listeners = new Set<SnapshotListener>();
  private static watchdogInterval: number | null = null;
  private static lastSnapshot: ClaudeProcessRegistrySnapshot = {
    activeGroups: 0,
    backgroundWorkPaused: false,
    health: 'healthy',
    oldestGroupAgeMs: 0,
    residentBytes: 0,
    terminatingGroups: 0,
  };

  static assertCanSpawn(): void {
    this.pruneExitedGroups();
    const snapshot = this.refresh();
    if (snapshot.health === 'critical') {
      throw new Error(
        'Claude runtime safety limit reached: plugin-owned processes exceed 5 GiB. '
        + 'Close idle Claude tabs or run “Clean up stopped Claude runtimes” before retrying.',
      );
    }
    if (snapshot.activeGroups >= MAX_PROCESS_GROUPS) {
      throw new Error(
        `Claude runtime safety limit reached (${MAX_PROCESS_GROUPS} process groups). `
        + 'Close an idle Claude tab before starting another runtime.',
      );
    }
  }

  static register(child: ChildProcess): void {
    if (typeof child.pid !== 'number') return;
    const groupId = child.pid;
    this.records.set(groupId, {
      child,
      createdAt: Date.now(),
      groupId,
      rootExited: false,
    });
    child.once('exit', () => {
      const record = this.records.get(groupId);
      if (!record) return;
      record.rootExited = true;
      window.setTimeout(() => {
        this.pruneExitedGroups();
        this.refresh();
      }, 2_500);
    });
    this.ensureWatchdog();
    this.refresh();
  }

  static markShutdownRequested(child: ChildProcess): void {
    if (typeof child.pid !== 'number') return;
    const record = this.records.get(child.pid);
    if (record) {
      record.shutdownRequestedAt = Date.now();
      this.refresh();
    }
  }

  static isBackgroundWorkPaused(): boolean {
    return this.refresh().backgroundWorkPaused;
  }

  static getSnapshot(): ClaudeProcessRegistrySnapshot {
    return this.refresh();
  }

  static describe(): string {
    const snapshot = this.refresh();
    const resident = snapshot.residentBytes === null
      ? 'unavailable'
      : `${(snapshot.residentBytes / 1024 ** 2).toFixed(0)} MiB`;
    return [
      `Health: ${snapshot.health}`,
      `Plugin-owned Claude groups: ${snapshot.activeGroups}/${MAX_PROCESS_GROUPS}`,
      `Groups shutting down: ${snapshot.terminatingGroups}`,
      `Resident memory: ${resident}`,
      `Oldest group age: ${Math.round(snapshot.oldestGroupAgeMs / 60_000)} min`,
      `Automatic background work: ${snapshot.backgroundWorkPaused ? 'paused' : 'enabled'}`,
    ].join('\n');
  }

  static cleanupStoppedGroups(): number {
    let signalled = 0;
    for (const record of this.records.values()) {
      if (!record.rootExited && record.shutdownRequestedAt === undefined) continue;
      if (!this.isProcessGroupAlive(record.groupId)) continue;
      try {
        process.kill(-record.groupId, 'SIGKILL');
        signalled += 1;
      } catch {
        // It exited between the liveness check and signal.
      }
    }
    this.pruneExitedGroups();
    this.refresh();
    return signalled;
  }

  static terminateAll(): void {
    for (const record of this.records.values()) {
      record.shutdownRequestedAt = Date.now();
      try {
        record.child.kill('SIGTERM');
      } catch {
        // Continue draining the remaining plugin-owned groups.
      }
    }
    this.refresh();
  }

  static subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.refresh());
    return () => this.listeners.delete(listener);
  }

  /** Test-only reset for the renderer-global registry. */
  static resetForTests(): void {
    if (this.watchdogInterval !== null) {
      window.clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    this.records.clear();
    this.listeners.clear();
    this.lastSnapshot = {
      activeGroups: 0,
      backgroundWorkPaused: false,
      health: 'healthy',
      oldestGroupAgeMs: 0,
      residentBytes: 0,
      terminatingGroups: 0,
    };
  }

  private static ensureWatchdog(): void {
    if (this.watchdogInterval !== null) return;
    this.watchdogInterval = window.setInterval(() => {
      this.pruneExitedGroups();
      this.refresh();
    }, WATCHDOG_INTERVAL_MS);
  }

  private static refresh(): ClaudeProcessRegistrySnapshot {
    const now = Date.now();
    const residentBytes = this.readTrackedResidentBytes();
    const activeGroups = this.records.size;
    const terminatingGroups = Array.from(this.records.values())
      .filter(record => record.rootExited || record.shutdownRequestedAt !== undefined).length;
    const oldestCreatedAt = activeGroups > 0
      ? Math.min(...Array.from(this.records.values()).map(record => record.createdAt))
      : now;
    const health: ClaudeProcessHealth = residentBytes !== null && residentBytes >= CRITICAL_RSS_BYTES
      ? 'critical'
      : residentBytes !== null && residentBytes >= PAUSE_RSS_BYTES
        ? 'paused'
        : residentBytes !== null && residentBytes >= WARNING_RSS_BYTES
          ? 'warning'
          : 'healthy';
    const snapshot: ClaudeProcessRegistrySnapshot = {
      activeGroups,
      backgroundWorkPaused: health === 'paused' || health === 'critical',
      health,
      oldestGroupAgeMs: Math.max(0, now - oldestCreatedAt),
      residentBytes,
      terminatingGroups,
    };
    const changed = JSON.stringify(snapshot) !== JSON.stringify(this.lastSnapshot);
    this.lastSnapshot = snapshot;
    if (changed) {
      for (const listener of this.listeners) listener(snapshot);
    }
    return snapshot;
  }

  private static pruneExitedGroups(): void {
    for (const [groupId, record] of this.records) {
      if (record.rootExited && !this.isProcessGroupAlive(groupId)) {
        this.records.delete(groupId);
      }
    }
    if (this.records.size === 0 && this.watchdogInterval !== null) {
      window.clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  private static isProcessGroupAlive(groupId: number): boolean {
    if (process.platform === 'win32') {
      return this.records.get(groupId)?.child.exitCode === null;
    }
    try {
      process.kill(-groupId, 0);
      return true;
    } catch {
      return false;
    }
  }

  private static readTrackedResidentBytes(): number | null {
    if (process.platform !== 'linux') return null;
    const trackedGroups = new Set(this.records.keys());
    if (trackedGroups.size === 0) return 0;
    try {
      const pageSize = 4096;
      let residentPages = 0;
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/u.test(entry)) continue;
        const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        if (closeParen < 0) continue;
        const fields = stat.slice(closeParen + 2).split(' ');
        const processGroupId = Number(fields[2]);
        if (!trackedGroups.has(processGroupId)) continue;
        const statm = fs.readFileSync(`/proc/${entry}/statm`, 'utf8').split(' ');
        residentPages += Number(statm[1]) || 0;
      }
      return residentPages * pageSize;
    } catch {
      return null;
    }
  }
}
