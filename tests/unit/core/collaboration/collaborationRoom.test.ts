import {
  createCollaborationMemberships,
  resolveCollaborationRecipients,
} from '@/core/collaboration/collaborationRoom';

describe('collaboration rooms', () => {
  it('links every participant to the same room and conversation map', () => {
    const memberships = createCollaborationMemberships(
      'room-1',
      {
        claude: 'claude-conversation',
        codex: 'codex-conversation',
      },
    );

    expect(memberships.claude).toEqual({
      roomId: 'room-1',
      participantId: 'claude',
      conversationIds: {
        claude: 'claude-conversation',
        codex: 'codex-conversation',
      },
    });
    expect(memberships.codex).toEqual({
      roomId: 'room-1',
      participantId: 'codex',
      conversationIds: {
        claude: 'claude-conversation',
        codex: 'codex-conversation',
      },
    });
  });

  it.each([
    ['@claude review this', ['claude']],
    ['@codex implement this', ['codex']],
    ['@all compare approaches', ['claude', 'codex']],
    ['No explicit recipient', ['claude', 'codex']],
    ['Ask @codex, then @claude', ['claude', 'codex']],
  ])('routes %s to %j', (message, expected) => {
    expect(resolveCollaborationRecipients(message, ['claude', 'codex'])).toEqual(expected);
  });

  it('matches mentions as complete names only', () => {
    expect(resolveCollaborationRecipients(
      'The @claudette example is unrelated',
      ['claude', 'codex'],
    )).toEqual(['claude', 'codex']);
  });
});
