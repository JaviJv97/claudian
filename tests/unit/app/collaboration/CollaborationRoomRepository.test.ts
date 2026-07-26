import { CollaborationRoomRepository } from '@/app/collaboration/CollaborationRoomRepository';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

function createAdapter(): jest.Mocked<VaultFileAdapter> & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: jest.fn(async path => files.has(path)),
    read: jest.fn(async path => {
      const value = files.get(path);
      if (value === undefined) throw new Error('missing');
      return value;
    }),
    write: jest.fn(async (path, content) => {
      files.set(path, content);
    }),
    delete: jest.fn(async path => {
      files.delete(path);
    }),
    listFiles: jest.fn(async folder => (
      [...files.keys()].filter(path => path.startsWith(`${folder}/`))
    )),
  } as unknown as jest.Mocked<VaultFileAdapter> & { files: Map<string, string> };
}

describe('CollaborationRoomRepository', () => {
  it('creates and reloads a durable room', async () => {
    const adapter = createAdapter();
    const repository = new CollaborationRoomRepository(adapter);

    const room = await repository.create({
      id: 'room-1',
      title: 'Claude + Codex',
      participants: [
        { providerId: 'claude', conversationId: 'conversation-claude' },
        { providerId: 'codex', conversationId: 'conversation-codex' },
      ],
      now: 100,
    });

    expect(await repository.get(room.id)).toEqual(room);
    expect(adapter.write).toHaveBeenCalledWith(
      '.claudian/rooms/room-1.json',
      expect.stringContaining('"version": 1'),
    );
  });

  it('appends events without dropping earlier events', async () => {
    const repository = new CollaborationRoomRepository(createAdapter());
    await repository.create({
      id: 'room-1',
      title: 'Room',
      participants: [
        { providerId: 'claude', conversationId: 'conversation-claude' },
      ],
      now: 100,
    });

    await Promise.all([
      repository.appendEvent('room-1', {
        id: 'event-1',
        kind: 'message',
        authorId: 'user',
        recipientIds: ['claude'],
        content: 'First',
        createdAt: 101,
        delivery: { claude: { status: 'pending' } },
      }),
      repository.appendEvent('room-1', {
        id: 'event-2',
        kind: 'message',
        authorId: 'claude',
        recipientIds: ['user'],
        content: 'Second',
        createdAt: 102,
        delivery: {},
      }),
    ]);

    const room = await repository.get('room-1');
    expect(room?.events.map(event => event.id)).toEqual(['event-1', 'event-2']);
    expect(room?.updatedAt).toBe(102);
  });

  it('updates one participant delivery without replacing the others', async () => {
    const repository = new CollaborationRoomRepository(createAdapter());
    await repository.create({
      id: 'room-1',
      title: 'Room',
      participants: [
        { providerId: 'claude', conversationId: 'conversation-claude' },
        { providerId: 'codex', conversationId: 'conversation-codex' },
      ],
      now: 100,
    });
    await repository.appendEvent('room-1', {
      id: 'event-1',
      kind: 'message',
      authorId: 'user',
      recipientIds: ['claude', 'codex'],
      content: 'Compare',
      createdAt: 101,
      delivery: {
        claude: { status: 'pending' },
        codex: { status: 'pending' },
      },
    });

    await repository.updateDelivery('room-1', 'event-1', 'claude', {
      status: 'completed',
      completedAt: 110,
    });

    const event = (await repository.get('room-1'))?.events[0];
    expect(event?.delivery).toEqual({
      claude: { status: 'completed', completedAt: 110 },
      codex: { status: 'pending' },
    });
  });

  it('rebinds one participant conversation without changing room history', async () => {
    const repository = new CollaborationRoomRepository(createAdapter());
    await repository.create({
      id: 'room-1',
      title: 'Room',
      participants: [
        { providerId: 'claude', conversationId: 'conversation-claude' },
        { providerId: 'codex', conversationId: 'conversation-codex-old' },
      ],
      now: 100,
    });
    await repository.appendEvent('room-1', {
      id: 'event-1',
      kind: 'message',
      authorId: 'user',
      recipientIds: ['codex'],
      content: 'Inspect this',
      createdAt: 101,
      delivery: { codex: { status: 'completed' } },
    });

    await repository.updateParticipantConversation(
      'room-1',
      'codex',
      'conversation-codex-new',
      110,
    );

    const room = await repository.get('room-1');
    expect(room?.participants).toEqual([
      { providerId: 'claude', conversationId: 'conversation-claude' },
      { providerId: 'codex', conversationId: 'conversation-codex-new' },
    ]);
    expect(room?.events.map(event => event.id)).toEqual(['event-1']);
    expect(room?.updatedAt).toBe(110);
  });

  it('archives and reopens a room without losing its history', async () => {
    const repository = new CollaborationRoomRepository(createAdapter());
    await repository.create({
      id: 'room-1',
      title: 'Room',
      participants: [
        { id: 'claude-personal', providerId: 'claude', conversationId: 'conversation-claude' },
        { id: 'codex', providerId: 'codex', conversationId: 'conversation-codex' },
      ],
      now: 100,
    });

    const archived = await repository.archive('room-1', 110);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(110);

    const reopened = await repository.reopen('room-1', 120);
    expect(reopened.status).toBe('active');
    expect(reopened.archivedAt).toBeUndefined();
    expect(reopened.participants).toHaveLength(2);
    expect(reopened.updatedAt).toBe(120);
  });

  it('lists rooms newest first and includes archived rooms', async () => {
    const repository = new CollaborationRoomRepository(createAdapter());
    await repository.create({ id: 'older', title: 'Older', participants: [], now: 100 });
    await repository.create({ id: 'newer', title: 'Newer', participants: [], now: 200 });
    await repository.archive('older', 300);

    expect((await repository.list()).map(room => [room.id, room.status])).toEqual([
      ['older', 'archived'],
      ['newer', 'active'],
    ]);
  });

  it('replaces one participant atomically while preserving the room-local identity', async () => {
    const repository = new CollaborationRoomRepository(createAdapter());
    await repository.create({
      id: 'room-1',
      title: 'Room',
      participants: [
        {
          id: 'claude-company',
          providerId: 'claude',
          runtimeProfileId: 'company',
          label: 'Claude Company',
          conversationId: 'conversation-old',
        },
        { id: 'codex', providerId: 'codex', conversationId: 'conversation-codex' },
      ],
      now: 100,
    });

    const room = await repository.replaceParticipant('room-1', 'claude-company', {
      id: 'claude-work',
      providerId: 'claude',
      runtimeProfileId: 'work',
      label: 'Claude Work',
      conversationId: 'conversation-new',
    }, 110);

    expect(room.participants).toEqual([
      {
        id: 'claude-work',
        providerId: 'claude',
        runtimeProfileId: 'work',
        label: 'Claude Work',
        conversationId: 'conversation-new',
      },
      { id: 'codex', providerId: 'codex', conversationId: 'conversation-codex' },
    ]);
    expect(room.updatedAt).toBe(110);
  });

  it('persists discussion mode and participant transcript cursors', async () => {
    const repository = new CollaborationRoomRepository(createAdapter());
    await repository.create({
      id: 'room-1',
      title: 'Room',
      participants: [
        { id: 'claude', providerId: 'claude', conversationId: 'conversation-claude' },
        { id: 'codex', providerId: 'codex', conversationId: 'conversation-codex' },
      ],
      now: 100,
    });

    await repository.updateDiscussionMode('room-1', 'round-table', 110);
    const room = await repository.updateParticipantCursor(
      'room-1',
      'claude',
      'event-2',
      120,
    );

    expect(room.discussionMode).toBe('round-table');
    expect(room.participantLastSeenEventIds).toEqual({ claude: 'event-2' });
    expect(room.updatedAt).toBe(120);
  });

  it.each(['', '../escape', 'nested/room', '/absolute'])(
    'rejects unsafe room id %p',
    async (id) => {
      const repository = new CollaborationRoomRepository(createAdapter());
      await expect(repository.get(id)).rejects.toThrow('Invalid collaboration room id');
    },
  );
});
