import {
  getPreservedMentionedParticipantIds,
  getRoutableCollaborationParticipantIds,
  getUnavailableMentionedParticipantIds,
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
});
