import {
  appendQuotaHistory,
  getPreservedMentionedParticipantIds,
  getQuotaProjection,
  getQuotaRoutingRecommendation,
  getRoutableCollaborationParticipantIds,
  getUnavailableMentionedParticipantIds,
  isQuotaSnapshotStale,
  isReadOnlyCollaborationPlan,
} from '@/core/collaboration/collaborationResourcePolicy';
import type { CollaborationRoom } from '@/core/types';

const room = {
  participants: [
    { id: 'personal', resourcePolicy: { mode: 'preserve' } },
    { id: 'company', resourcePolicy: { mode: 'active' } },
    { id: 'codex', resourcePolicy: { mode: 'unavailable' } },
  ],
} as CollaborationRoom;

describe('collaborationResourcePolicy', () => {
  it('preserves quota on group turns but allows an explicit mention', () => {
    expect(getRoutableCollaborationParticipantIds(room, 'Ask everyone', false))
      .toEqual(['company']);
    expect(getRoutableCollaborationParticipantIds(room, '@personal please verify', false))
      .toEqual(['personal', 'company']);
  });

  it('uses only active participants for autonomous workflows', () => {
    expect(getRoutableCollaborationParticipantIds(
      room,
      '@personal execute the plan',
      true,
    )).toEqual(['company']);
  });

  it('identifies explicit mentions that must not fall through to other agents', () => {
    expect(getUnavailableMentionedParticipantIds(room, '@codex answer this'))
      .toEqual(['codex']);
  });

  it('identifies an explicit preserve-mode quota override', () => {
    expect(getPreservedMentionedParticipantIds(room, '@personal answer this'))
      .toEqual(['personal']);
  });

  it('recognizes explicit no-edit research as safe for parallel execution', () => {
    expect(isReadOnlyCollaborationPlan(
      'Read-only task: inspect the note and report evidence. Do not edit any files.',
    )).toBe(true);
    expect(isReadOnlyCollaborationPlan('Inspect and fix the note.')).toBe(false);
  });

  it('recommends preserving an active participant above the weekly threshold', () => {
    expect(getQuotaRoutingRecommendation({
      mode: 'active',
      quotaSnapshot: {
        source: 'provider',
        fetchedAt: 1_000,
        windows: [
          { id: 'five-hour', label: '5 hour', utilizationPercent: 12 },
          { id: 'seven-day', label: '7 day', utilizationPercent: 94 },
        ],
      },
    }, 2_000)).toEqual({
      mode: 'preserve',
      reason: 'Weekly usage is 94%. Preserve this participant for explicit mentions.',
      utilizationPercent: 94,
    });
  });

  it('does not override an existing manual or unavailable routing decision', () => {
    expect(getQuotaRoutingRecommendation({
      mode: 'preserve',
      weeklyUsagePercent: 96,
    }, 2_000)).toBeNull();
    expect(getQuotaRoutingRecommendation({
      mode: 'unavailable',
      quotaSnapshot: {
        source: 'provider',
        fetchedAt: 1_000,
        windows: [{ id: 'seven-day', label: '7 day', utilizationPercent: 99 }],
      },
    }, 2_000)).toBeNull();
  });

  it('marks old provider snapshots stale', () => {
    expect(isQuotaSnapshotStale({ source: 'provider', fetchedAt: 1, windows: [] }, 900_002))
      .toBe(true);
  });

  it('keeps bounded quota history and replaces unchanged samples inside the sampling interval', () => {
    const first = {
      fetchedAt: 1_000,
      windows: [{ id: 'seven-day', label: '7 day', utilizationPercent: 10 }],
    };
    const unchanged = {
      fetchedAt: 2_000,
      windows: [{ id: 'seven-day', label: '7 day', utilizationPercent: 10 }],
    };
    const changed = {
      fetchedAt: 3_000,
      windows: [{ id: 'seven-day', label: '7 day', utilizationPercent: 11 }],
    };
    expect(appendQuotaHistory([first], unchanged, { sampleIntervalMs: 5_000 }))
      .toEqual([unchanged]);
    expect(appendQuotaHistory([first], changed, { sampleIntervalMs: 5_000 }))
      .toEqual([first, changed]);
  });

  it('projects end-of-window usage and exhaustion from elapsed window pace', () => {
    const hour = 60 * 60 * 1_000;
    const now = 4 * hour;
    expect(getQuotaProjection({
      id: 'five-hour',
      label: '5 hour',
      utilizationPercent: 90,
      resetsAt: 5 * hour,
    }, now)).toEqual({
      projectedEndPercent: 113,
      exhaustionAt: expect.any(Number),
    });
  });
});
