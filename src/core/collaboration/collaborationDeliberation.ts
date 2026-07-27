import type {
  CollaborationDeliberationPhase,
  CollaborationEvent,
  CollaborationRoom,
} from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

export const DELIBERATION_PHASES: readonly CollaborationDeliberationPhase[] = [
  'position',
  'critique',
  'synthesis',
  'ratification',
];

export function buildDeliberationInstruction(
  room: CollaborationRoom,
  phase: CollaborationDeliberationPhase,
  originalPrompt: string,
  deliberationId: string,
): string {
  const events = room.events.filter(event => event.deliberationId === deliberationId);
  const visiblePhases: CollaborationDeliberationPhase[] = phase === 'position'
    ? []
    : phase === 'critique'
      ? ['position']
      : phase === 'synthesis'
        ? ['position', 'critique']
        : ['synthesis'];
  const attributed = events
    .filter(event => (
      event.authorId !== 'user'
      && event.authorId !== 'system'
      && event.deliberationPhase
      && visiblePhases.includes(event.deliberationPhase)
    ))
    .map(event => {
      const participant = room.participants.find(candidate => (
        getCollaborationParticipantId(candidate) === event.authorId
      ));
      return `[${participant?.label ?? event.authorId}] (${event.deliberationPhase}): ${event.content}`;
    }).join('\n\n');
  const task = phase === 'position'
    ? 'Give your independent position. Do not assume or invent any other participant’s view.'
    : phase === 'critique'
      ? 'Critique specific claims from the independent positions. State concrete agreement and dissent with attribution.'
      : phase === 'synthesis'
        ? 'Propose one synthesis grounded in the attributed positions and critiques. Preserve unresolved objections; do not claim consensus.'
        : 'Evaluate the proposed synthesis. Begin with exactly APPROVE or OBJECT, then give a concise reason. APPROVE means you accept the synthesis as the shared recommendation.';
  return [
    `Deliberation phase: ${phase}.`,
    `Original user question:\n${originalPrompt}`,
    attributed ? `Authenticated outputs from independently running participant sessions:\n${attributed}` : '',
    task,
  ].filter(Boolean).join('\n\n');
}

export function evaluateDeliberationConsensus(
  events: readonly CollaborationEvent[],
  deliberationId: string,
  requiredParticipantIds: readonly string[],
): { approved: boolean; approvals: string[]; objections: string[] } {
  const ratifications = events.filter(event => (
    event.deliberationId === deliberationId
    && event.deliberationPhase === 'ratification'
    && requiredParticipantIds.includes(String(event.authorId))
  ));
  const approvals = ratifications
    .filter(event => /^APPROVE\b/i.test(event.content.trim()))
    .map(event => String(event.authorId));
  const objections = ratifications
    .filter(event => !/^APPROVE\b/i.test(event.content.trim()))
    .map(event => String(event.authorId));
  return {
    approved: requiredParticipantIds.every(id => approvals.includes(id)) && objections.length === 0,
    approvals,
    objections,
  };
}
