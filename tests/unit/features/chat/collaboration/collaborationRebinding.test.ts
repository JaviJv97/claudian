import type { CollaborationRoom } from '@/core/types';
import { findCollaborationRebindCandidates } from '@/features/chat/collaboration/collaborationRebinding';

const room: CollaborationRoom = {
  version: 1,
  id: 'room-1',
  title: 'Claude + Codex',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { providerId: 'claude', conversationId: 'claude-old' },
    { providerId: 'codex', conversationId: 'codex-old' },
  ],
  events: [],
};

describe('findCollaborationRebindCandidates', () => {
  it('repairs one missing participant when exactly one unlinked provider tab exists', () => {
    expect(findCollaborationRebindCandidates(room, [
      {
        tabId: 'claude-tab',
        providerId: 'claude',
        conversationId: 'claude-old',
        roomId: 'room-1',
      },
      {
        tabId: 'codex-tab',
        providerId: 'codex',
        conversationId: 'codex-new',
        roomId: null,
      },
    ])).toEqual([
      {
        participantId: 'codex',
        providerId: 'codex',
        previousConversationId: 'codex-old',
        conversationId: 'codex-new',
        tabId: 'codex-tab',
      },
    ]);
  });

  it('distinguishes two Claude participants by runtime profile', () => {
    const profiledRoom: CollaborationRoom = {
      ...room,
      participants: [
        {
          id: 'claude-personal',
          providerId: 'claude',
          runtimeProfileId: 'personal',
          conversationId: 'personal-old',
        },
        {
          id: 'claude-company',
          providerId: 'claude',
          runtimeProfileId: 'company',
          conversationId: 'company-old',
        },
      ],
    };

    expect(findCollaborationRebindCandidates(profiledRoom, [
      {
        tabId: 'personal-tab',
        providerId: 'claude',
        runtimeProfileId: 'personal',
        conversationId: 'personal-old',
        roomId: 'room-1',
      },
      {
        tabId: 'company-tab',
        providerId: 'claude',
        runtimeProfileId: 'company',
        conversationId: 'company-new',
        roomId: null,
      },
    ])).toEqual([expect.objectContaining({
      participantId: 'claude-company',
      conversationId: 'company-new',
    })]);
  });

  it('does not guess when multiple unlinked tabs could be the replacement', () => {
    expect(findCollaborationRebindCandidates(room, [
      {
        tabId: 'claude-tab',
        providerId: 'claude',
        conversationId: 'claude-old',
        roomId: 'room-1',
      },
      {
        tabId: 'codex-tab-1',
        providerId: 'codex',
        conversationId: 'codex-new-1',
        roomId: null,
      },
      {
        tabId: 'codex-tab-2',
        providerId: 'codex',
        conversationId: 'codex-new-2',
        roomId: null,
      },
    ])).toEqual([]);
  });

  it('does not replace a participant that is already open', () => {
    expect(findCollaborationRebindCandidates(room, [
      {
        tabId: 'claude-tab',
        providerId: 'claude',
        conversationId: 'claude-old',
        roomId: 'room-1',
      },
      {
        tabId: 'codex-tab',
        providerId: 'codex',
        conversationId: 'codex-old',
        roomId: 'room-1',
      },
    ])).toEqual([]);
  });
});
