import {
  createPortableCollaborationRoom,
  parsePortableCollaborationRoom,
} from '@/core/collaboration/portableCollaborationRoom';
import type { CollaborationRoom } from '@/core/types';

function createRoom(): CollaborationRoom {
  return {
    version: 1,
    id: 'room-local',
    title: 'Portable room',
    status: 'active',
    discussionMode: 'deliberation',
    routing: {
      selection: 'auto',
      defaultMode: 'round-table',
      roundTable: {
        participantOrder: ['codex'],
        startingParticipantId: 'codex',
        cycles: 2,
        rotateStarter: false,
      },
      synthesizerParticipantId: 'codex',
    },
    participantLastSeenEventIds: { codex: 'event-1' },
    createdAt: 10,
    updatedAt: 20,
    participants: [{
      id: 'codex',
      providerId: 'codex',
      label: 'Codex',
      conversationId: '019f-native-session',
      resourcePolicy: {
        mode: 'active',
        weeklyUsagePercent: 30,
        quotaSnapshot: {
          source: 'provider',
          fetchedAt: 20,
          windows: [],
        },
      },
    }],
    events: [{
      id: 'event-1',
      kind: 'message',
      authorId: 'user',
      recipientIds: ['codex'],
      content: 'Continue from ${HIGHLANDER_REPO}/README.md',
      createdAt: 15,
      delivery: {
        codex: {
          status: 'completed',
          providerMessageId: 'provider-secret-identity',
        },
      },
      attachments: [{
        id: 'attachment-1',
        name: 'reference.png',
        mediaType: 'image/png',
        data: 'base64-private-image',
        size: 128,
      }],
    }],
  };
}

describe('portable collaboration rooms', () => {
  it('removes machine-local session identity, quota telemetry, and attachment data', () => {
    const portable = createPortableCollaborationRoom(createRoom(), {
      exportedAt: 30,
      archiveSessionIds: ['home-pc-multiagent-room'],
    });

    expect(portable.participants).toEqual([{
      id: 'codex',
      providerId: 'codex',
      label: 'Codex',
      resourceMode: 'active',
    }]);
    expect(portable.events[0].delivery.codex).toEqual({ status: 'completed' });
    expect(portable.events[0].attachments).toEqual([{
      id: 'attachment-1',
      name: 'reference.png',
      mediaType: 'image/png',
      size: 128,
    }]);
    expect(JSON.stringify(portable)).not.toContain('019f-native-session');
    expect(JSON.stringify(portable)).not.toContain('provider-secret-identity');
    expect(JSON.stringify(portable)).not.toContain('base64-private-image');
    expect(JSON.stringify(portable)).not.toContain('quotaSnapshot');
  });

  it('round-trips a valid package and rejects credential-like fields', () => {
    const portable = createPortableCollaborationRoom(createRoom(), { exportedAt: 30 });

    expect(parsePortableCollaborationRoom(JSON.stringify(portable))).toEqual(portable);
    expect(() => parsePortableCollaborationRoom(JSON.stringify({
      ...portable,
      accessToken: 'do-not-import',
    }))).toThrow('credential-like field');
  });

  it('imports legacy schema version 1 and exports routing in version 2', () => {
    const portable = createPortableCollaborationRoom(createRoom(), { exportedAt: 30 });
    expect(portable.schemaVersion).toBe(2);
    expect(portable.routing?.roundTable.cycles).toBe(2);

    const legacy = {
      ...portable,
      schemaVersion: 1,
      routing: undefined,
    };
    expect(parsePortableCollaborationRoom(JSON.stringify(legacy))).toMatchObject({
      schemaVersion: 1,
      discussionMode: 'deliberation',
    });
    expect(() => parsePortableCollaborationRoom(JSON.stringify({
      ...portable,
      schemaVersion: 3,
    }))).toThrow('invalid or unsupported');
  });

  it('records machine-local path references without rejecting historical content', () => {
    const room = createRoom();
    room.events[0].content = 'Read /home/javierj/private/file.md and C:\\Work\\handoff.md';

    const portable = createPortableCollaborationRoom(room, { exportedAt: 30 });

    expect(portable.machineLocalReferences).toEqual([
      '/home/javierj/private/file.md',
      'C:\\Work\\handoff.md',
    ]);
  });

  it('does not carry provider unavailability to another machine', () => {
    const room = createRoom();
    room.participants[0].resourcePolicy = { mode: 'unavailable' };

    expect(createPortableCollaborationRoom(room).participants[0].resourceMode)
      .toBeUndefined();
  });

  it('rejects invalid runtime modes from untrusted portable JSON', () => {
    const portable = createPortableCollaborationRoom(createRoom());
    expect(() => parsePortableCollaborationRoom(JSON.stringify({
      ...portable,
      discussionMode: 'surprise-mode',
    }))).toThrow('invalid or unsupported');
    expect(() => parsePortableCollaborationRoom(JSON.stringify({
      ...portable,
      participants: [{ ...portable.participants[0], resourceMode: 'always-run' }],
    }))).toThrow('invalid or unsupported');
  });

  it('accepts legacy unavailability without carrying machine health forward', () => {
    const portable = createPortableCollaborationRoom(createRoom());
    const parsed = parsePortableCollaborationRoom(JSON.stringify({
      ...portable,
      schemaVersion: 1,
      routing: undefined,
      participants: [{ ...portable.participants[0], resourceMode: 'unavailable' }],
    }));

    expect(parsed.participants[0].resourceMode).toBeUndefined();
  });
});
