import type { CollaborationRoom } from '@/core/types';
import { getLatestRetryableDeliveries } from '@/features/chat/collaboration/collaborationRecovery';

function createRoom(): CollaborationRoom {
  return {
    version: 1,
    id: 'room-1',
    title: 'Claude + Codex',
    createdAt: 1,
    updatedAt: 1,
    participants: [],
    events: [
      {
        id: 'event-1',
        kind: 'message',
        authorId: 'user',
        recipientIds: ['claude', 'codex'],
        content: 'Compare',
        createdAt: 2,
        delivery: {
          claude: { status: 'cancelled' },
          codex: { status: 'completed' },
        },
      },
    ],
  };
}

describe('getLatestRetryableDeliveries', () => {
  it('returns failed and cancelled deliveries from the latest user turn', () => {
    const room = createRoom();
    room.events[0].delivery.codex = {
      status: 'failed',
      error: 'Unavailable',
    };

    expect(getLatestRetryableDeliveries(room)).toEqual([
      {
        providerId: 'claude',
        status: 'cancelled',
        content: 'Compare',
        eventId: 'event-1',
      },
      {
        providerId: 'codex',
        status: 'failed',
        content: 'Compare',
        eventId: 'event-1',
      },
    ]);
  });

  it('hides recovery when a newer user turn has no retryable delivery', () => {
    const room = createRoom();
    room.events.push({
      id: 'event-2',
      kind: 'message',
      authorId: 'user',
      recipientIds: ['claude'],
      content: 'Retry',
      createdAt: 3,
      delivery: {
        claude: { status: 'streaming' },
      },
    });

    expect(getLatestRetryableDeliveries(room)).toEqual([]);
  });

  it('ignores assistant events after the latest user turn', () => {
    const room = createRoom();
    room.events.push({
      id: 'event-2',
      kind: 'message',
      authorId: 'codex',
      recipientIds: ['user'],
      content: 'Completed response',
      createdAt: 3,
      delivery: {},
    });

    expect(getLatestRetryableDeliveries(room)).toHaveLength(1);
  });

  it('retries with the failed participant’s addressed content', () => {
    const room = createRoom();
    room.events[0].content = '@claude: inspect A\n@codex: inspect B';
    room.events[0].recipientContent = {
      claude: 'inspect A',
      codex: 'inspect B',
    };

    expect(getLatestRetryableDeliveries(room)[0].content).toBe('inspect A');
  });
});
