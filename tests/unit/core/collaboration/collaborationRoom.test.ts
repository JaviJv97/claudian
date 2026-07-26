import {
  createCollaborationMemberships,
  resolveCollaborationRecipients,
  resolveCollaborationTurn,
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

  it.each([
    ['@claude review this', ['claude'], 'review this'],
    ['  @codex   implement this', ['codex'], 'implement this'],
    ['@all compare approaches', ['claude', 'codex'], 'compare approaches'],
    ['No explicit recipient', ['claude', 'codex'], 'No explicit recipient'],
  ])('resolves and removes a leading routing directive from %s', (
    message,
    recipientIds,
    content,
  ) => {
    expect(resolveCollaborationTurn(message, ['claude', 'codex'])).toEqual({
      recipientIds,
      content,
    });
  });

  it('preserves non-routing mentions in the provider prompt', () => {
    expect(resolveCollaborationTurn(
      'Ask @codex, then @claude',
      ['claude', 'codex'],
    )).toEqual({
      recipientIds: ['claude', 'codex'],
      content: 'Ask @codex, then @claude',
    });
  });
});
