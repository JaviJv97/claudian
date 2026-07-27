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
  participantId?: string,
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
    ? 'Give your independent position. Do not assume or invent any other participant’s view. Keep your response under 300 words.'
    : phase === 'critique'
      ? 'Critique specific claims from the independent positions. State concrete agreement and dissent with attribution. Do not restate entire positions. Keep your response under 300 words.'
      : phase === 'synthesis'
        ? 'Propose one actionable synthesis grounded in the attributed positions and critiques. Preserve unresolved objections; do not claim consensus. Assign a bounded responsibility to each named participant. Keep your response under 400 words.'
        : [
          'Evaluate the proposed synthesis without proposing a different process.',
          'Respond in this exact format:',
          'VERDICT: APPROVE or OBJECT',
          'BLOCKING_OBJECTIONS: NONE or a concise blocking objection',
          'CONCERNS: NONE or concise non-blocking concerns',
          'REASON: one concise sentence',
          'APPROVE means you accept the synthesis as the shared recommendation. Keep the entire response under 120 words.',
        ].join('\n');
  const participant = participantId
    ? room.participants.find(candidate => (
      getCollaborationParticipantId(candidate) === participantId
    ))
    : undefined;
  return [
    `Deliberation phase: ${phase}.`,
    participant
      ? `You are ${participant.label ?? participantId}. This is your room identity. Do not refer to this identity as a separate participant.`
      : '',
    `Original user question:\n${originalPrompt}`,
    attributed ? `Authenticated outputs from independently running participant sessions:\n${attributed}` : '',
    task,
  ].filter(Boolean).join('\n\n');
}

export function evaluateDeliberationConsensus(
  events: readonly CollaborationEvent[],
  deliberationId: string,
  requiredParticipantIds: readonly string[],
): {
  approved: boolean;
  approvals: string[];
  objections: string[];
  concerns: string[];
  missing: string[];
} {
  const ratifications = events.filter(event => (
    event.deliberationId === deliberationId
    && event.deliberationPhase === 'ratification'
    && requiredParticipantIds.includes(String(event.authorId))
  ));
  const getVerdict = (content: string): 'approve' | 'object' | null => {
    const normalized = content
      .trim()
      .replace(/^[#>*_`\s-]+/, '')
      .replace(/[*_`]/g, '');
    const match = normalized.match(/^(?:VERDICT\s*:\s*)?(APPROVE|OBJECT)\b/i);
    return match?.[1].toLowerCase() === 'approve'
      ? 'approve'
      : match?.[1].toLowerCase() === 'object'
        ? 'object'
        : null;
  };
  const hasBlockingObjection = (content: string): boolean => {
    const blocking = content.match(/BLOCKING_OBJECTIONS\s*:\s*([^\n]+)/i)?.[1].trim();
    return Boolean(blocking && !/^NONE\b/i.test(blocking));
  };
  const approvals = ratifications
    .filter(event => (
      getVerdict(event.content) === 'approve'
      && !hasBlockingObjection(event.content)
    ))
    .map(event => String(event.authorId));
  const objections = ratifications
    .filter(event => (
      getVerdict(event.content) !== 'approve'
      || hasBlockingObjection(event.content)
    ))
    .map(event => String(event.authorId));
  const concerns = ratifications
    .filter((event) => {
      if (getVerdict(event.content) !== 'approve') return false;
      const explicit = event.content.match(/CONCERNS\s*:\s*([^\n]+)/i)?.[1].trim();
      if (explicit) return !/^NONE\b/i.test(explicit);
      const prose = event.content.replace(/BLOCKING_OBJECTIONS\s*:[^\n]*/ig, '');
      return /\b(?:concerns?|objections?|non-blocking)\b/i.test(prose);
    })
    .map(event => String(event.authorId));
  const present = new Set(ratifications.map(event => String(event.authorId)));
  const missing = requiredParticipantIds.filter(id => !present.has(id));
  return {
    approved: requiredParticipantIds.every(id => approvals.includes(id))
      && objections.length === 0
      && missing.length === 0,
    approvals,
    objections,
    concerns,
    missing,
  };
}
