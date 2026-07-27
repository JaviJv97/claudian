import {
  createCollaborationMemberships,
  getCollaborationParticipantId,
  hasExplicitCollaborationRecipient,
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

  it('recognizes only actual room recipients as explicit mentions', () => {
    expect(hasExplicitCollaborationRecipient(
      'Please ask @claude',
      ['claude', 'codex'],
    )).toBe(true);
    expect(hasExplicitCollaborationRecipient(
      'Please ask @all',
      ['claude', 'codex'],
    )).toBe(true);
    expect(hasExplicitCollaborationRecipient(
      'This note mentions @outsider, who is not an agent',
      ['claude', 'codex'],
    )).toBe(false);
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
      recipientContent: Object.fromEntries(
        recipientIds.map(providerId => [providerId, content]),
      ),
    });
  });

  it('preserves non-routing mentions in the provider prompt', () => {
    expect(resolveCollaborationTurn(
      'Ask @codex, then @claude',
      ['claude', 'codex'],
    )).toEqual({
      recipientIds: ['claude', 'codex'],
      content: 'Ask @codex, then @claude',
      recipientContent: {
        claude: 'Ask @codex, then @claude',
        codex: 'Ask @codex, then @claude',
      },
    });
  });

  it('routes addressed blocks only to their named participants', () => {
    const message = [
      'Use only your assigned file.',
      '@claude: create Claude-Test.md',
      'Include a checklist.',
      '@codex: create Codex-Test.md',
      'Include a checklist.',
    ].join('\n');

    expect(resolveCollaborationTurn(message, ['claude', 'codex'])).toEqual({
      content: message,
      recipientIds: ['claude', 'codex'],
      recipientContent: {
        claude: 'Use only your assigned file.\ncreate Claude-Test.md\nInclude a checklist.',
        codex: 'Use only your assigned file.\ncreate Codex-Test.md\nInclude a checklist.',
      },
    });
  });

  it('strips an optional colon from a single leading directive', () => {
    expect(resolveCollaborationTurn(
      '@claude: create Claude-Test.md',
      ['claude', 'codex'],
    )).toEqual({
      content: 'create Claude-Test.md',
      recipientIds: ['claude'],
      recipientContent: {
        claude: 'create Claude-Test.md',
      },
    });
  });

  it('routes two independently identified Claude participants', () => {
    expect(resolveCollaborationTurn(
      '@claude-personal: review tone\n@claude-company: review policy\n@codex: implement',
      ['claude-personal', 'claude-company', 'codex'],
    )).toEqual({
      content: '@claude-personal: review tone\n@claude-company: review policy\n@codex: implement',
      recipientIds: ['claude-personal', 'claude-company', 'codex'],
      recipientContent: {
        'claude-personal': 'review tone',
        'claude-company': 'review policy',
        codex: 'implement',
      },
    });
  });

  it('falls back to provider identity for legacy participants', () => {
    expect(getCollaborationParticipantId({
      providerId: 'claude',
    })).toBe('claude');
  });
});
