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
    expect(buildDeliberationInstruction(room, 'position', 'Choose a design', 'd-1'))
      .toContain('Give your independent position');
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
      });
  });
});
