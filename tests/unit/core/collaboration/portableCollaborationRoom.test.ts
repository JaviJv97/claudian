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

  it('records machine-local path references without rejecting historical content', () => {
    const room = createRoom();
    room.events[0].content = 'Read /home/javierj/private/file.md and C:\\Work\\handoff.md';

    const portable = createPortableCollaborationRoom(room, { exportedAt: 30 });

    expect(portable.machineLocalReferences).toEqual([
      '/home/javierj/private/file.md',
      'C:\\Work\\handoff.md',
    ]);
  });
});
