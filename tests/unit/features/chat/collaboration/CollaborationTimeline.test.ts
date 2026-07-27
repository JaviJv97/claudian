import {
  resolveParticipantActivity,
} from '@/features/chat/collaboration/CollaborationTimeline';

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
