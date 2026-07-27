import {
  getAvailableReviewParticipantIds,
  resolveParticipantActivity,
} from '@/features/chat/collaboration/CollaborationTimeline';

describe('getAvailableReviewParticipantIds', () => {
  it('offers every other available account without collapsing same-provider profiles', () => {
    expect(getAvailableReviewParticipantIds(
      ['claude-personal', 'claude-company', 'codex', 'claude-company'],
      'codex',
      {
        'claude-personal': { mode: 'active' },
        'claude-company': { mode: 'preserve' },
      },
    )).toEqual(['claude-personal', 'claude-company']);
  });

  it('excludes the source account and unavailable reviewers', () => {
    expect(getAvailableReviewParticipantIds(
      ['claude-personal', 'claude-company', 'codex'],
      'claude-personal',
      { 'claude-company': { mode: 'unavailable' } },
    )).toEqual(['codex']);
  });
});

describe('resolveParticipantActivity', () => {
  it('shows the live deliberation stage while an agent is working', () => {
    expect(resolveParticipantActivity({
      isStreaming: true,
      needsAttention: false,
      phase: 'critique',
    })).toEqual({
      state: 'working',
      label: 'Working',
      stage: 'Critique',
    });
  });

  it('distinguishes queued work from an idle participant', () => {
    expect(resolveParticipantActivity({
      isStreaming: false,
      needsAttention: false,
      deliveryStatus: 'pending',
      phase: 'position',
    })).toEqual({
      state: 'queued',
      label: 'Queued',
      stage: 'Position',
    });
  });

  it('gives attention precedence over streaming state', () => {
    expect(resolveParticipantActivity({
      isStreaming: true,
      needsAttention: true,
      phase: 'verification',
    })).toEqual({
      state: 'attention',
      label: 'Needs attention',
      stage: 'Verification',
    });
  });

  it('uses a calm ready state after work completes', () => {
    expect(resolveParticipantActivity({
      isStreaming: false,
      needsAttention: false,
      deliveryStatus: 'completed',
    })).toEqual({
      state: 'ready',
      label: 'Ready',
      stage: null,
    });
  });
});
