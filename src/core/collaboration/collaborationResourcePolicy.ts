import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../runtime/types';
import type {
  CollaborationParticipantResourcePolicy,
  CollaborationQuotaHistoryPoint,
  CollaborationRoom,
} from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const QUOTA_SNAPSHOT_STALE_MS = 15 * 60 * 1_000;
export const QUOTA_HISTORY_SAMPLE_MS = 30 * 60 * 1_000;
export const QUOTA_HISTORY_LIMIT = 336;
export const QUOTA_PRESERVE_THRESHOLD_PERCENT = 90;

export interface QuotaRoutingRecommendation {
  mode: 'preserve';
  reason: string;
  utilizationPercent: number;
}

export function isQuotaSnapshotStale(
  snapshot: ProviderQuotaSnapshot | undefined,
  now = Date.now(),
): boolean {
  return !snapshot || now - snapshot.fetchedAt > QUOTA_SNAPSHOT_STALE_MS;
}

export function getQuotaRoutingRecommendation(
  policy: CollaborationParticipantResourcePolicy | undefined,
  now = Date.now(),
): QuotaRoutingRecommendation | null {
  if (!policy || policy.mode !== 'active' || isQuotaSnapshotStale(policy.quotaSnapshot, now)) {
    return null;
  }
  const weekly = policy.quotaSnapshot?.windows.find(window => (
    window.id === 'seven-day' || window.id === 'secondary'
  ));
  if (!weekly || weekly.utilizationPercent < QUOTA_PRESERVE_THRESHOLD_PERCENT) return null;
  return {
    mode: 'preserve',
    utilizationPercent: weekly.utilizationPercent,
    reason: `Weekly usage is ${weekly.utilizationPercent}%. Preserve this participant for explicit mentions.`,
  };
}

function sameQuotaWindows(
  left: readonly ProviderQuotaWindow[],
  right: readonly ProviderQuotaWindow[],
): boolean {
  return JSON.stringify(left.map(window => [window.id, window.utilizationPercent, window.resetsAt]))
    === JSON.stringify(right.map(window => [window.id, window.utilizationPercent, window.resetsAt]));
}

export function appendQuotaHistory(
  history: readonly CollaborationQuotaHistoryPoint[] | undefined,
  sample: CollaborationQuotaHistoryPoint,
  options: { sampleIntervalMs?: number; limit?: number } = {},
): CollaborationQuotaHistoryPoint[] {
  const next = [...(history ?? [])];
  const previous = next.at(-1);
  const sampleIntervalMs = options.sampleIntervalMs ?? QUOTA_HISTORY_SAMPLE_MS;
  if (
    previous
    && sample.fetchedAt - previous.fetchedAt < sampleIntervalMs
    && sameQuotaWindows(previous.windows, sample.windows)
  ) {
    next[next.length - 1] = sample;
  } else {
    next.push(sample);
  }
  return next.slice(-(options.limit ?? QUOTA_HISTORY_LIMIT));
}

export interface QuotaProjection {
  projectedEndPercent: number;
  exhaustionAt?: number;
}

export function getQuotaProjection(
  window: ProviderQuotaWindow,
  now = Date.now(),
): QuotaProjection | null {
  if (!window.resetsAt || window.utilizationPercent <= 0 || window.resetsAt <= now) return null;
  const duration = window.id === 'five-hour'
    ? 5 * 60 * 60 * 1_000
    : window.id === 'seven-day'
      ? 7 * 24 * 60 * 60 * 1_000
      : null;
  if (!duration) return null;
  const startedAt = window.resetsAt - duration;
  const elapsed = now - startedAt;
  if (elapsed <= 0) return null;
  const projectedEndPercent = Math.round(
    window.utilizationPercent * (duration / elapsed),
  );
  const exhaustionAt = startedAt + elapsed * (100 / window.utilizationPercent);
  return {
    projectedEndPercent,
    ...(exhaustionAt > now && exhaustionAt < window.resetsAt ? { exhaustionAt } : {}),
  };
}

export function getRoutableCollaborationParticipantIds(
  room: CollaborationRoom,
  content: string,
  autonomousWorkflow: boolean,
): string[] {
  return room.participants.flatMap((participant) => {
    const participantId = getCollaborationParticipantId(participant);
    const mode = participant.resourcePolicy?.mode ?? 'active';
    if (mode === 'unavailable' || mode === 'muted') return [];
    if (autonomousWorkflow) return mode === 'active' ? [participantId] : [];
    const explicitlyMentioned = new RegExp(
      `(^|\\s)@${escapeRegExp(participantId)}\\b`,
      'i',
    ).test(content);
    return mode === 'active' || explicitlyMentioned ? [participantId] : [];
  });
}

export function getUnavailableMentionedParticipantIds(
  room: CollaborationRoom,
  content: string,
): string[] {
  return room.participants.flatMap((participant) => {
    const participantId = getCollaborationParticipantId(participant);
    return participant.resourcePolicy?.mode === 'unavailable'
      && new RegExp(`(^|\\s)@${escapeRegExp(participantId)}\\b`, 'i').test(content)
      ? [participantId]
      : [];
  });
}

export function getPreservedMentionedParticipantIds(
  room: CollaborationRoom,
  content: string,
): string[] {
  return room.participants.flatMap((participant) => {
    const participantId = getCollaborationParticipantId(participant);
    return participant.resourcePolicy?.mode === 'preserve'
      && new RegExp(`(^|\\s)@${escapeRegExp(participantId)}\\b`, 'i').test(content)
      ? [participantId]
      : [];
  });
}

export function getMutedMentionedParticipantIds(
  room: CollaborationRoom,
  content: string,
): string[] {
  return room.participants.flatMap((participant) => {
    const participantId = getCollaborationParticipantId(participant);
    return participant.resourcePolicy?.mode === 'muted'
      && new RegExp(`(^|\\s)@${escapeRegExp(participantId)}\\b`, 'i').test(content)
      ? [participantId]
      : [];
  });
}

export function isReadOnlyCollaborationPlan(content: string): boolean {
  const normalized = content
    .replace(/\bdo not (?:edit|write|create|modify|delete)\b/ig, '')
    .replace(/\bwithout (?:editing|writing|creating|modifying|deleting)\b/ig, '')
    .replace(/\bno (?:file )?(?:edits|writes|changes|modifications|deletions)\b/ig, '');
  return /\b(?:read[- ]only|research|inspect|analy[sz]e|review|report|verify)\b/i
    .test(content)
    && !/\b(?:edit|write|create|modify|delete|implement|fix)\b/i.test(normalized);
}
