import {
  buildDeliberationInstruction,
  evaluateDeliberationConsensus,
} from '@/core/collaboration/collaborationDeliberation';
import type { CollaborationEvent, CollaborationRoom } from '@/core/types';

const room: CollaborationRoom = {
  version: 1,
  id: 'room-1',
  title: 'Review',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { id: 'personal', providerId: 'claude', label: 'Claude Personal', conversationId: 'a' },
    { id: 'company', providerId: 'claude', label: 'Claude Company', conversationId: 'b' },
    { id: 'codex', providerId: 'codex', label: 'Codex', conversationId: 'c' },
  ],
  events: [],
};

describe('collaboration deliberation', () => {
  it('keeps the position phase independent', () => {
    const instruction = buildDeliberationInstruction(
      room,
      'position',
      'Choose a design',
      'd-1',
      'company',
    );

    expect(instruction).toContain('You are Claude Company');
    expect(instruction).toContain('Give your independent position');
    expect(instruction).toContain('Keep your response under 300 words');
  });

  it('requires a machine-readable, independently reviewed task graph in synthesis', () => {
    const instruction = buildDeliberationInstruction(
      room,
      'synthesis',
      'Build the feature',
      'd-1',
      'codex',
    );

    expect(instruction).toContain('```task-graph');
    expect(instruction).toContain('"ownerId"');
    expect(instruction).toContain('ownerId and reviewerId must differ');
    expect(instruction).toContain('personal, company, codex');
  });

  it('exposes account-specific resource policy to the synthesizer', () => {
    const resourceRoom: CollaborationRoom = structuredClone(room);
    resourceRoom.participants[0].resourcePolicy = {
      mode: 'preserve',
      weeklyUsagePercent: 97,
    };
    resourceRoom.participants[1].resourcePolicy = { mode: 'active' };

    const instruction = buildDeliberationInstruction(
      resourceRoom,
      'synthesis',
      'Build the feature',
      'd-1',
      'codex',
    );

    expect(instruction).toContain('personal: preserve · 97% week');
    expect(instruction).toContain('Do not assign unavailable participants');
    expect(instruction).toContain('Avoid preserve participants');
    expect(instruction).toContain('at or above 90% weekly usage');
  });

  it('requires explicit unanimous approval and preserves objections', () => {
    const events = [
      ['personal', 'APPROVE Good synthesis'],
      ['company', 'OBJECT Missing evidence'],
      ['codex', 'APPROVE'],
    ].map(([authorId, content], index) => ({
      id: `event-${index}`,
      kind: 'message',
      authorId,
      recipientIds: ['user'],
      content,
      createdAt: index,
      delivery: {},
      deliberationId: 'd-1',
      deliberationPhase: 'ratification',
    })) as CollaborationEvent[];

    expect(evaluateDeliberationConsensus(events, 'd-1', ['personal', 'company', 'codex']))
      .toEqual({
        approved: false,
        approvals: ['personal', 'codex'],
        objections: ['company'],
        concerns: [],
        missing: [],
      });
  });

  it('accepts markdown-formatted structured approval without treating concerns as objections', () => {
    const events = [
      ['personal', '**VERDICT: APPROVE**\nBLOCKING_OBJECTIONS: NONE\nCONCERNS: Needs monitoring'],
      ['company', '**APPROVE.**\nThe previously discussed objections are non-blocking.'],
      ['codex', 'VERDICT: APPROVE\nBLOCKING_OBJECTIONS: NONE'],
    ].map(([authorId, content], index) => ({
      id: `event-${index}`,
      kind: 'message',
      authorId,
      recipientIds: ['user'],
      content,
      createdAt: index,
      delivery: {},
      deliberationId: 'd-2',
      deliberationPhase: 'ratification',
    })) as CollaborationEvent[];

    expect(evaluateDeliberationConsensus(events, 'd-2', ['personal', 'company', 'codex']))
      .toEqual({
        approved: true,
        approvals: ['personal', 'company', 'codex'],
        objections: [],
        concerns: ['personal', 'company'],
        missing: [],
      });
  });

  it('treats a declared blocking objection as authoritative over APPROVE', () => {
    const events = [{
      id: 'event-1',
      kind: 'message',
      authorId: 'personal',
      recipientIds: ['user'],
      content: 'VERDICT: APPROVE\nBLOCKING_OBJECTIONS: Missing safety evidence',
      createdAt: 1,
      delivery: {},
      deliberationId: 'd-3',
      deliberationPhase: 'ratification',
    }] as CollaborationEvent[];

    expect(evaluateDeliberationConsensus(events, 'd-3', ['personal']))
      .toMatchObject({
        approved: false,
        approvals: [],
        objections: ['personal'],
      });
  });
});
