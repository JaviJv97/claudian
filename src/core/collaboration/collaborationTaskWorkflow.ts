import type {
  CollaborationRoom,
  CollaborationTaskEvidence,
  CollaborationWorkTask,
} from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

export interface CollaborationTaskReview {
  verdict: 'approve' | 'changes-needed';
  findings: string[];
}

function getIdentity(room: CollaborationRoom, participantId: string): string {
  const participant = room.participants.find(candidate => (
    getCollaborationParticipantId(candidate) === participantId
  ));
  return participant?.label ?? participantId;
}

function extractJsonBlock(content: string, name: string): unknown {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = content.match(new RegExp(`\`\`\`${escaped}\\s*\\n([\\s\\S]*?)\`\`\``, 'i'))?.[1];
  if (!block) throw new Error(`Response is missing the ${name} block`);
  try {
    return JSON.parse(block);
  } catch {
    throw new Error(`The ${name} block is not valid JSON`);
  }
}

export function buildCollaborationTaskExecutionInstruction(
  room: CollaborationRoom,
  task: CollaborationWorkTask,
): string {
  return [
    `Queue task execution. You are ${getIdentity(room, task.ownerId)}.`,
    `Task ${task.id}: ${task.title}`,
    task.description,
    `Allowed file scopes:\n${task.fileScopes.map(scope => `- ${scope}`).join('\n')}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
    `Required verification commands:\n${task.verificationCommands.map(
      command => `- ${command}`,
    ).join('\n')}`,
    [
      'Execute only this bounded task. Do not take another queue task.',
      'Do not edit files outside the allowed file scopes.',
      'Preserve unrelated work and re-read files immediately before editing.',
      'Run every required verification command. Report failures truthfully.',
      'If blocked, explain the blocker in the summary and mark its verification failed.',
      'End with exactly one fenced JSON block using this schema:',
      '```task-evidence',
      '{"summary":"what changed or why blocked","filesChanged":["path"],"acceptanceCriteriaMet":["exact criterion"],"verificationResults":[{"command":"exact command","status":"passed|failed","output":"concise result"}],"commitSha":"optional","knownLimitations":["item"]}',
      '```',
    ].join('\n'),
  ].join('\n\n');
}

export function parseCollaborationTaskEvidence(content: string): CollaborationTaskEvidence {
  const value = extractJsonBlock(content, 'task-evidence') as Partial<CollaborationTaskEvidence>;
  if (!value || typeof value !== 'object' || typeof value.summary !== 'string') {
    throw new Error('Task evidence needs a summary');
  }
  if (
    !Array.isArray(value.filesChanged)
    || !Array.isArray(value.acceptanceCriteriaMet)
    || !Array.isArray(value.verificationResults)
  ) {
    throw new Error('Task evidence is incomplete');
  }
  return {
    summary: value.summary,
    filesChanged: value.filesChanged.map(String),
    acceptanceCriteriaMet: value.acceptanceCriteriaMet.map(String),
    verificationResults: value.verificationResults.map(result => ({
      command: String(result.command ?? ''),
      status: result.status === 'passed' ? 'passed' : 'failed',
      output: result.output === undefined ? undefined : String(result.output),
    })),
    commitSha: value.commitSha === undefined ? undefined : String(value.commitSha),
    knownLimitations: Array.isArray(value.knownLimitations)
      ? value.knownLimitations.map(String)
      : [],
  };
}

export function buildCollaborationTaskReviewInstruction(
  room: CollaborationRoom,
  task: CollaborationWorkTask,
  evidence: CollaborationTaskEvidence,
): string {
  return [
    `Queue task review. You are ${getIdentity(room, task.reviewerId)}.`,
    `Task ${task.id}: ${task.title}\n${task.description}`,
    `Allowed file scopes:\n${task.fileScopes.map(scope => `- ${scope}`).join('\n')}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
    `Required verification commands:\n${task.verificationCommands.map(
      command => `- ${command}`,
    ).join('\n')}`,
    `Owner evidence:\n${JSON.stringify(evidence, null, 2)}`,
    [
      'Independently inspect the actual workspace state and verify the evidence.',
      'Do not edit files or repair findings during review.',
      'Approve only if every criterion is met, every required verification passed, and changes stayed within scope.',
      'End with exactly one fenced JSON block:',
      '```task-review',
      '{"verdict":"approve|changes-needed","findings":["specific finding"]}',
      '```',
    ].join('\n'),
  ].join('\n\n');
}

export function parseCollaborationTaskReview(content: string): CollaborationTaskReview {
  const value = extractJsonBlock(content, 'task-review') as Partial<CollaborationTaskReview>;
  if (value.verdict !== 'approve' && value.verdict !== 'changes-needed') {
    throw new Error('Task review has an invalid verdict');
  }
  return {
    verdict: value.verdict,
    findings: Array.isArray(value.findings) ? value.findings.map(String) : [],
  };
}
