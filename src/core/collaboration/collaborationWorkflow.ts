import type { CollaborationRoom } from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

function getIdentity(room: CollaborationRoom, participantId: string): string {
  const participant = room.participants.find(candidate => (
    getCollaborationParticipantId(candidate) === participantId
  ));
  return participant?.label ?? participantId;
}

export function buildCollaborationExecutionInstruction(
  room: CollaborationRoom,
  participantId: string,
  originalGoal: string,
  approvedSynthesis: string,
  activeParticipantLabels?: readonly string[],
  coverUnavailableAssignments = false,
): string {
  const identity = getIdentity(room, participantId);
  return [
    `Autonomous execution phase. You are ${identity}.`,
    'The user approved execution of the ratified plan. Work only within the original goal and the responsibility assigned to your room identity.',
    `Original goal:\n${originalGoal}`,
    `Approved synthesis:\n${approvedSynthesis}`,
    activeParticipantLabels?.length
      ? `Active executors for this run: ${activeParticipantLabels.join(', ')}.`
      : '',
    coverUnavailableAssignments
      ? 'Quota preservation removed one or more planned participants. In addition to your own assignment, cover any approved responsibility assigned to a participant who is not in the active-executor list.'
      : '',
    [
      'Execute your bounded assignment now.',
      'Do not perform another active participant’s assignment or restart deliberation.',
      'Preserve unrelated files and content.',
      'If blocked, report the exact blocker instead of expanding scope.',
      'Finish with: RESULT: COMPLETE or BLOCKED, followed by changed files, evidence, and remaining risks.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

export function buildCollaborationReviewInstruction(
  room: CollaborationRoom,
  participantId: string,
  originalGoal: string,
  approvedSynthesis: string,
  executionOutputs: string,
  availabilityAdaptation?: string,
): string {
  return [
    `Autonomous cross-review phase. You are ${getIdentity(room, participantId)}.`,
    `Original goal:\n${originalGoal}`,
    `Approved synthesis:\n${approvedSynthesis}`,
    availabilityAdaptation ? `Authorized availability adaptation:\n${availabilityAdaptation}` : '',
    `Attributed execution outputs:\n${executionOutputs}`,
    [
      'Review the other participants’ work against the original goal and approved plan.',
      'Do not edit files or repeat execution.',
      'Identify concrete errors, omissions, unsafe changes, and missing verification.',
      'Finish with: REVIEW: PASS or CHANGES_NEEDED, followed by concise evidence.',
      'Keep the response under 250 words.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

export function buildCollaborationVerificationInstruction(
  room: CollaborationRoom,
  participantId: string,
  originalGoal: string,
  approvedSynthesis: string,
  executionOutputs: string,
  reviewOutputs: string,
  availabilityAdaptation?: string,
): string {
  return [
    `Autonomous verification phase. You are ${getIdentity(room, participantId)}.`,
    `Original goal:\n${originalGoal}`,
    `Approved synthesis:\n${approvedSynthesis}`,
    availabilityAdaptation ? `Authorized availability adaptation:\n${availabilityAdaptation}` : '',
    `Execution outputs:\n${executionOutputs}`,
    `Cross-reviews:\n${reviewOutputs}`,
    [
      'Assess whether the evidence demonstrates that the approved plan is complete and safe.',
      'Run only non-destructive verification that is clearly within the original scope.',
      'Do not repair defects in this phase; report them for the human checkpoint.',
      'Begin with exactly CHECKPOINT: READY or NEEDS_CHANGES.',
      'Then list verification evidence, unresolved conflicts, and the recommended human decision.',
      'Keep the response under 300 words.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}
