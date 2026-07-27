import { buildCollaborationPrompt } from '@/core/collaboration/collaborationTranscript';
import type { CollaborationRoom } from '@/core/types';

function createRoom(): CollaborationRoom {
  return {
    version: 1,
    id: 'room-1',
    title: 'Architecture review',
    discussionMode: 'round-table',
    participantLastSeenEventIds: { codex: 'agent-1' },
    createdAt: 1,
    updatedAt: 5,
    participants: [
      { id: 'claude-personal', providerId: 'claude', label: 'Claude Personal', conversationId: 'a' },
      { id: 'claude-company', providerId: 'claude', label: 'Claude Company', conversationId: 'b' },
      { id: 'codex', providerId: 'codex', label: 'Codex', conversationId: 'c' },
    ],
    events: [
      {
        id: 'user-1',
        kind: 'message',
        authorId: 'user',
        recipientIds: ['claude'],
        content: 'Initial question',
        createdAt: 2,
        delivery: {},
      },
      {
        id: 'agent-1',
        kind: 'message',
        authorId: 'codex',
        recipientIds: ['user'],
        content: 'My earlier answer',
        createdAt: 3,
        delivery: {},
      },
      {
        id: 'agent-2',
        kind: 'message',
        authorId: 'claude-personal',
        recipientIds: ['user'],
        content: 'A new proposal',
        createdAt: 4,
        delivery: {},
      },
      {
        id: 'user-2',
        kind: 'message',
        authorId: 'user',
        recipientIds: ['codex'],
        content: 'What do you think?',
        createdAt: 5,
        delivery: {},
      },
    ],
  };
}

describe('buildCollaborationPrompt', () => {
  it('includes unseen participant responses and identifies every room member', () => {
    const prompt = buildCollaborationPrompt(createRoom(), 'codex', 'What do you think?', {
      currentEventId: 'user-2',
    });

    expect(prompt).toContain('Claude Personal, Claude Company, Codex');
    expect(prompt).toContain('[Claude Personal]: A new proposal');
    expect(prompt).not.toContain('My earlier answer');
    expect(prompt).toContain('Latest message from the user:\nWhat do you think?');
  });

  it('bounds old transcript context while preserving the latest message', () => {
    const room = createRoom();
    room.participantLastSeenEventIds = {};
    room.events[0].content = 'x'.repeat(500);

    const prompt = buildCollaborationPrompt(room, 'codex', 'Latest', {
      currentEventId: 'user-2',
      maxTranscriptChars: 120,
    });

    expect(prompt.length).toBeLessThan(900);
    expect(prompt).toContain('Latest message from the user:\nLatest');
    expect(prompt).toContain('Earlier shared context was omitted');
  });
});
