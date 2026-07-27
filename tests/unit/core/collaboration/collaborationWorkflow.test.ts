import {
  buildCollaborationExecutionInstruction,
  buildCollaborationReviewInstruction,
  buildCollaborationVerificationInstruction,
} from '@/core/collaboration/collaborationWorkflow';
import type { CollaborationRoom } from '@/core/types';

const room: CollaborationRoom = {
  version: 1,
  id: 'room-1',
  title: 'Three agents',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { id: 'personal', providerId: 'claude', label: 'Claude Personal', conversationId: 'a' },
    { id: 'company', providerId: 'claude', label: 'Claude Company', conversationId: 'b' },
    { id: 'codex', providerId: 'codex', label: 'Codex', conversationId: 'c' },
  ],
  events: [],
};

describe('collaborationWorkflow', () => {
  it('scopes execution to the participant identity and approved synthesis', () => {
    const prompt = buildCollaborationExecutionInstruction(
      room,
      'company',
      'Investigate the watchlist',
      'Claude Company inspects local sources.',
      ['Claude Company', 'Codex'],
      true,
    );

    expect(prompt).toContain('You are Claude Company');
    expect(prompt).toContain('Claude Company inspects local sources.');
    expect(prompt).toContain('Do not perform another active participant’s assignment');
    expect(prompt).toContain('cover any approved responsibility');
  });

  it('makes review read-only and verification checkpoint-oriented', () => {
    const review = buildCollaborationReviewInstruction(
      room,
      'personal',
      'goal',
      'plan',
      '[Codex]: findings',
      'Claude Company is authorized to cover preserved assignments.',
    );
    expect(review).toContain('Do not edit files');
    expect(review).toContain('Authorized availability adaptation');
    const verification = buildCollaborationVerificationInstruction(
      room,
      'codex',
      'goal',
      'plan',
      'execution',
      'reviews',
      'Claude Company is authorized to cover preserved assignments.',
    );
    expect(verification).toContain('CHECKPOINT: READY or NEEDS_CHANGES');
    expect(verification).toContain('Authorized availability adaptation');
  });
});
