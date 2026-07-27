import { CollaborationCoordinator } from '@/core/collaboration/CollaborationCoordinator';
import type {
  CollaborationEvent,
  CollaborationRoom,
} from '@/core/types';

function createRoom(): CollaborationRoom {
  return {
    version: 1,
    id: 'room-1',
    title: 'Room',
    createdAt: 1,
    updatedAt: 1,
    participants: [
      { providerId: 'claude', conversationId: 'conversation-claude' },
      { providerId: 'codex', conversationId: 'conversation-codex' },
    ],
    events: [],
  };
}

function createStorage(room: CollaborationRoom) {
  return {
    create: jest.fn(),
    get: jest.fn().mockResolvedValue(room),
    appendEvent: jest.fn(async (_roomId: string, event: CollaborationEvent) => {
      room.events.push(structuredClone(event));
      return room;
    }),
    updateDelivery: jest.fn(async (
      _roomId: string,
      eventId: string,
      providerId: string,
      delivery: unknown,
    ) => {
      const event = room.events.find(candidate => candidate.id === eventId)!;
      event.delivery[providerId] = delivery as never;
      return room;
    }),
  };
}

describe('CollaborationCoordinator', () => {
  it('persists autonomous workflow metadata on phase events', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-workflow',
      now: () => 10,
    });

    const turn = await coordinator.send(room, {
      content: 'Autonomous execution phase',
      recipientIds: ['claude'],
      eventAuthorId: 'system',
      eventKind: 'system',
      eventMetadata: {
        workflow: {
          id: 'workflow-1',
          deliberationId: 'deliberation-1',
          phase: 'execution',
        },
      },
      dispatch: async () => ({}),
    });
    await turn.completion;

    expect(room.events[0].workflow).toEqual({
      id: 'workflow-1',
      deliberationId: 'deliberation-1',
      phase: 'execution',
    });
  });

  it('dispatches recipients concurrently and records independent completion', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const resolvers = new Map<string, () => void>();
    const dispatch = jest.fn((participant: { providerId: string }) => (
      new Promise<{ providerMessageId: string }>((resolve) => {
        resolvers.set(participant.providerId, () => resolve({
          providerMessageId: `${participant.providerId}-message`,
        }));
      })
    ));
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: (() => {
        let now = 10;
        return () => now++;
      })(),
    });

    const turn = await coordinator.send(room, {
      content: 'Compare',
      recipientIds: ['claude', 'codex'],
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(storage.appendEvent).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({
        delivery: {
          claude: { status: 'pending' },
          codex: { status: 'pending' },
        },
      }),
    );

    resolvers.get('claude')!();
    resolvers.get('codex')!();
    await turn.completion;

    expect(room.events[0].delivery.claude).toEqual(expect.objectContaining({
      status: 'completed',
      providerMessageId: 'claude-message',
    }));
    expect(room.events[0].delivery.codex).toEqual(expect.objectContaining({
      status: 'completed',
      providerMessageId: 'codex-message',
    }));
  });

  it('dispatches recipients sequentially and prepares each prompt after the prior response', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const order: string[] = [];
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });

    const turn = await coordinator.send(room, {
      content: 'Discuss',
      recipientIds: ['claude', 'codex'],
      strategy: 'sequential',
      prepareContent: async participant => (
        `${participant.providerId}:${order.join(',') || 'first'}`
      ),
      dispatch: async (participant, request) => {
        order.push(`${participant.providerId}:${request.content}`);
        return {};
      },
    });
    await turn.completion;

    expect(order).toEqual([
      'claude:claude:first',
      'codex:codex:claude:claude:first',
    ]);
  });

  it('keeps later sequential recipients pending until their turn begins', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    let releaseFirst!: () => void;
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });
    const turn = await coordinator.send(room, {
      content: 'Discuss',
      recipientIds: ['claude', 'codex'],
      strategy: 'sequential',
      dispatch: participant => participant.providerId === 'claude'
        ? new Promise(resolve => { releaseFirst = () => resolve({}); })
        : Promise.resolve({}),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(room.events[0].delivery.claude.status).toBe('streaming');
    expect(room.events[0].delivery.codex.status).toBe('pending');

    releaseFirst();
    await turn.completion;
    expect(room.events[0].delivery.codex.status).toBe('completed');
  });

  it('keeps deliveries separate for two participants from the same provider', async () => {
    const room = createRoom();
    room.participants = [
      {
        id: 'claude-personal',
        providerId: 'claude',
        conversationId: 'personal-conversation',
      },
      {
        id: 'claude-company',
        providerId: 'claude',
        conversationId: 'company-conversation',
      },
    ];
    const storage = createStorage(room);
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });

    const turn = await coordinator.send(room, {
      content: 'Compare',
      recipientIds: ['claude-personal', 'claude-company'],
      dispatch: async participant => ({
        providerMessageId: `${participant.id}-message`,
      }),
    });
    await turn.completion;

    expect(room.events[0].delivery).toEqual({
      'claude-personal': expect.objectContaining({
        status: 'completed',
        providerMessageId: 'claude-personal-message',
      }),
      'claude-company': expect.objectContaining({
        status: 'completed',
        providerMessageId: 'claude-company-message',
      }),
    });
  });

  it('copies image attachments into the durable user event', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });
    const attachment = {
      id: 'image-1',
      name: 'diagram.png',
      mediaType: 'image/png' as const,
      data: 'aW1hZ2U=',
      size: 5,
    };

    const turn = await coordinator.send(room, {
      content: 'Review this diagram',
      recipientIds: ['claude'],
      attachments: [attachment],
      dispatch: async () => ({}),
    });
    await turn.completion;

    expect(room.events[0].attachments).toEqual([attachment]);
    expect(room.events[0].attachments).not.toBe(turn.event.attachments);
  });

  it('dispatches participant-specific content while preserving shared display text', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });
    const dispatch = jest.fn().mockResolvedValue({});

    const turn = await coordinator.send(room, {
      content: '@claude: inspect A\n@codex: inspect B',
      recipientIds: ['claude', 'codex'],
      recipientContent: {
        claude: 'inspect A',
        codex: 'inspect B',
      },
      dispatch,
    });
    await turn.completion;

    expect(turn.event.content).toBe('@claude: inspect A\n@codex: inspect B');
    expect(turn.event.recipientContent).toEqual({
      claude: 'inspect A',
      codex: 'inspect B',
    });
    expect(dispatch.mock.calls.map(call => [
      call[0].providerId,
      call[1].content,
    ])).toEqual([
      ['claude', 'inspect A'],
      ['codex', 'inspect B'],
    ]);
  });

  it('preserves a successful delivery when another participant fails', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });

    const turn = await coordinator.send(room, {
      content: 'Compare',
      recipientIds: ['claude', 'codex'],
      dispatch: async ({ providerId }) => {
        if (providerId === 'codex') throw new Error('Codex unavailable');
        return {};
      },
    });
    await turn.completion;

    expect(room.events[0].delivery.claude.status).toBe('completed');
    expect(room.events[0].delivery.codex).toEqual(expect.objectContaining({
      status: 'failed',
      error: 'Codex unavailable',
    }));
  });

  it('records a conflict when dispatch reports a changed shared file', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });

    const turn = await coordinator.send(room, {
      content: 'Edit Shared.md',
      recipientIds: ['claude'],
      dispatch: async () => ({
        providerMessageId: 'claude-message',
        conflictFiles: ['Shared.md'],
      }),
    });
    await turn.completion;

    expect(room.events[0].delivery.claude).toEqual(expect.objectContaining({
      status: 'conflict',
      providerMessageId: 'claude-message',
      conflictFiles: ['Shared.md'],
    }));
  });

  it('cancels only the selected participant', async () => {
    const room = createRoom();
    const storage = createStorage(room);
    const coordinator = new CollaborationCoordinator({
      storage,
      generateId: () => 'event-1',
      now: () => 10,
    });
    const dispatch = jest.fn((_participant, _request, signal: AbortSignal) => (
      new Promise<Record<string, never>>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        if (_participant.providerId === 'codex') resolve({});
      })
    ));

    const turn = await coordinator.send(room, {
      content: 'Compare',
      recipientIds: ['claude', 'codex'],
      dispatch,
    });
    expect(coordinator.cancel('room-1', 'event-1', 'claude')).toBe(true);
    await turn.completion;

    expect(room.events[0].delivery.claude.status).toBe('cancelled');
    expect(room.events[0].delivery.codex.status).toBe('completed');
    expect(coordinator.cancel('room-1', 'event-1', 'claude')).toBe(false);
  });
});
