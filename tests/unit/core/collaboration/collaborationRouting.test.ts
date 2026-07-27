import {
  normalizeCollaborationRoutingSettings,
  resolveCollaborationEffectiveRoute,
} from '@/core/collaboration/collaborationRouting';

describe('collaboration routing', () => {
  const participants = ['a', 'b', 'c'];

  it('normalizes legacy and invalid room settings against current membership', () => {
    expect(normalizeCollaborationRoutingSettings({
      selection: 'auto',
      defaultMode: 'round-table',
      roundTable: {
        participantOrder: ['c', 'missing', 'c'],
        startingParticipantId: 'missing',
        cycles: 99,
        rotateStarter: false,
      },
      facilitatorParticipantId: 'missing',
      synthesizerParticipantId: 'b',
    }, participants)).toEqual({
      selection: 'auto',
      defaultMode: 'round-table',
      roundTable: {
        participantOrder: ['c', 'a', 'b'],
        cycles: 5,
        rotateStarter: false,
      },
      synthesizerParticipantId: 'b',
    });
  });

  it('defensively normalizes malformed imported routing data', () => {
    expect(normalizeCollaborationRoutingSettings({
      selection: 'invalid',
      defaultMode: 'unknown',
      roundTable: {
        participantOrder: 'not-an-array',
        cycles: 'many',
        rotateStarter: 'yes',
      },
    } as never, participants)).toEqual({
      selection: 'manual',
      defaultMode: 'round-table',
      roundTable: {
        participantOrder: participants,
        cycles: 1,
        rotateStarter: false,
      },
    });
  });

  it('derives fixed and rotating cycle orders without changing roster order', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'manual',
      defaultMode: 'round-table',
      roundTable: {
        participantOrder: ['a', 'b', 'c'],
        startingParticipantId: 'b',
        cycles: 3,
        rotateStarter: true,
      },
    }, participants);

    expect(resolveCollaborationEffectiveRoute({
      content: 'Review this in sequence',
      eligibleParticipantIds: participants,
      explicitRecipientIds: participants,
      explicitRecipients: false,
      sharedReferencedFiles: [],
      settings,
    }).cycleOrders).toEqual([
      ['b', 'c', 'a'],
      ['c', 'a', 'b'],
      ['a', 'b', 'c'],
    ]);
  });

  it('gives explicit recipients and explicit mode precedence over auto routing', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'auto',
      defaultMode: 'round-table',
      roundTable: { participantOrder: participants, cycles: 2, rotateStarter: false },
    }, participants);

    expect(resolveCollaborationEffectiveRoute({
      content: 'Reach consensus',
      explicitMode: 'parallel',
      explicitRecipientIds: ['b'],
      explicitRecipients: true,
      eligibleParticipantIds: participants,
      sharedReferencedFiles: [],
      settings,
    })).toMatchObject({
      mode: 'parallel',
      source: 'explicit',
      recipientIds: ['b'],
      cycles: 1,
    });
  });

  it('routes known explicit recipients as mentioned-only before auto intent rules', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'auto',
      defaultMode: 'round-table',
      roundTable: { participantOrder: participants, cycles: 2, rotateStarter: false },
    }, participants);

    expect(resolveCollaborationEffectiveRoute({
      content: 'Challenge positions and reach consensus',
      explicitRecipientIds: ['b'],
      explicitRecipients: true,
      eligibleParticipantIds: participants,
      sharedReferencedFiles: [],
      settings,
    })).toMatchObject({
      mode: 'mentioned-only',
      source: 'explicit',
      recipientIds: ['b'],
      cycles: 1,
    });
  });

  it.each([
    ['Have each agent give an independent comparison', 'parallel'],
    ['Review the previous answer, then build on it', 'round-table'],
    ['Challenge the positions and reach a final consensus', 'deliberation'],
  ] as const)('auto-routes %s to %s', (content, mode) => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'auto',
      defaultMode: 'round-table',
      roundTable: { participantOrder: participants, cycles: 2, rotateStarter: false },
    }, participants);

    expect(resolveCollaborationEffectiveRoute({
      content,
      explicitRecipientIds: participants,
      explicitRecipients: false,
      eligibleParticipantIds: participants,
      sharedReferencedFiles: [],
      settings,
    }).mode).toBe(mode);
  });

  it('forces shared-file work to sequential routing with an explanation', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'auto',
      defaultMode: 'parallel',
      roundTable: { participantOrder: participants, cycles: 1, rotateStarter: false },
    }, participants);
    const route = resolveCollaborationEffectiveRoute({
      content: 'Each agent edit [[Report]] independently',
      explicitRecipientIds: participants,
      explicitRecipients: false,
      eligibleParticipantIds: participants,
      sharedReferencedFiles: ['Report.md'],
      settings,
    });

    expect(route.mode).toBe('round-table');
    expect(route.reasons.join(' ')).toMatch(/shared file/i);
  });

  it('keeps the shared-file safety override in manual rooms', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'manual',
      defaultMode: 'parallel',
      roundTable: { participantOrder: participants, cycles: 1, rotateStarter: false },
    }, participants);

    expect(resolveCollaborationEffectiveRoute({
      content: 'Update [[Report]]',
      explicitRecipientIds: participants,
      explicitRecipients: false,
      eligibleParticipantIds: participants,
      sharedReferencedFiles: ['Report.md'],
      settings,
    })).toMatchObject({
      mode: 'round-table',
      source: 'deterministic',
    });
  });

  it('uses the configured default when auto routing finds no strong signal', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'auto',
      defaultMode: 'parallel',
      roundTable: { participantOrder: participants, cycles: 1, rotateStarter: false },
    }, participants);
    const route = resolveCollaborationEffectiveRoute({
      content: 'Please review this request',
      explicitRecipientIds: participants,
      explicitRecipients: false,
      eligibleParticipantIds: participants,
      sharedReferencedFiles: [],
      settings,
    });

    expect(route).toMatchObject({ mode: 'parallel', source: 'default' });
    expect(route.reasons.join(' ')).toMatch(/room default/i);
  });

  it('warns when an explicit parallel route touches shared files', () => {
    const settings = normalizeCollaborationRoutingSettings(undefined, participants, 'parallel');
    const route = resolveCollaborationEffectiveRoute({
      content: 'Update the report',
      explicitMode: 'parallel',
      explicitRecipientIds: participants,
      explicitRecipients: false,
      eligibleParticipantIds: participants,
      sharedReferencedFiles: ['Report.md'],
      settings,
    });

    expect(route.mode).toBe('parallel');
    expect(route.warnings.join(' ')).toMatch(/conflicts/i);
  });

  it('degrades automatic deliberation when only one participant is eligible', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'auto',
      defaultMode: 'deliberation',
      roundTable: { participantOrder: participants, cycles: 1, rotateStarter: false },
    }, participants);
    const route = resolveCollaborationEffectiveRoute({
      content: 'Challenge the position and reach consensus',
      explicitRecipientIds: ['a'],
      explicitRecipients: false,
      eligibleParticipantIds: ['a'],
      sharedReferencedFiles: [],
      settings,
    });

    expect(route.mode).toBe('parallel');
    expect(route.warnings.join(' ')).toMatch(/at least two/i);
  });

  it('does not assign an ineligible configured role to a turn', () => {
    const settings = normalizeCollaborationRoutingSettings({
      selection: 'manual',
      defaultMode: 'parallel',
      roundTable: { participantOrder: participants, cycles: 1, rotateStarter: false },
      facilitatorParticipantId: 'c',
      synthesizerParticipantId: 'b',
    }, participants);
    const route = resolveCollaborationEffectiveRoute({
      content: 'Ask a',
      explicitRecipientIds: ['a'],
      explicitRecipients: true,
      eligibleParticipantIds: ['a'],
      sharedReferencedFiles: [],
      settings,
    });

    expect(route.facilitatorParticipantId).toBeUndefined();
    expect(route.synthesizerParticipantId).toBeUndefined();
    expect(route.warnings).toHaveLength(2);
  });
});
