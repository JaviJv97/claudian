import {
  buildCollaborationTaskExecutionInstruction,
  buildCollaborationTaskReviewInstruction,
  parseCollaborationTaskEvidence,
  parseCollaborationTaskReview,
} from '@/core/collaboration/collaborationTaskWorkflow';
import type { CollaborationRoom, CollaborationWorkTask } from '@/core/types';

const room: CollaborationRoom = {
  version: 1,
  id: 'room-1',
  title: 'Build',
  createdAt: 1,
  updatedAt: 1,
  participants: [
    { id: 'codex', providerId: 'codex', label: 'Codex', conversationId: 'a' },
    { id: 'company', providerId: 'claude', label: 'Claude Company', conversationId: 'b' },
  ],
  events: [],
};

const task: CollaborationWorkTask = {
  id: 'TASK-001',
  title: 'Persist queue',
  description: 'Add durable storage.',
  status: 'ready',
  ownerId: 'codex',
  reviewerId: 'company',
  dependsOn: [],
  fileScopes: ['src/core/**'],
  acceptanceCriteria: ['Queue survives restart'],
  verificationCommands: ['npm test'],
  risk: 'medium',
  attempts: 0,
  maxAttempts: 2,
  createdAt: 1,
  updatedAt: 1,
};

describe('collaboration task workflow protocol', () => {
  it('builds a bounded owner instruction with exact evidence schema', () => {
    const prompt = buildCollaborationTaskExecutionInstruction(room, task);

    expect(prompt).toContain('You are Codex');
    expect(prompt).toContain('src/core/**');
    expect(prompt).toContain('Do not edit files outside');
    expect(prompt).toContain('```task-evidence');
    expect(prompt).toContain('npm test');
  });

  it('parses evidence independently from surrounding prose', () => {
    const evidence = parseCollaborationTaskEvidence([
      'Work complete.',
      '```task-evidence',
      JSON.stringify({
        summary: 'Added persistence.',
        filesChanged: ['src/core/queue.ts'],
        acceptanceCriteriaMet: ['Queue survives restart'],
        verificationResults: [{ command: 'npm test', status: 'passed', output: '10 passed' }],
        knownLimitations: [],
      }),
      '```',
    ].join('\n'));

    expect(evidence.verificationResults[0]).toMatchObject({
      command: 'npm test',
      status: 'passed',
    });
  });

  it('gives the reviewer the contract and evidence without edit authority', () => {
    const prompt = buildCollaborationTaskReviewInstruction(room, task, {
      summary: 'Added persistence.',
      filesChanged: ['src/core/queue.ts'],
      acceptanceCriteriaMet: ['Queue survives restart'],
      verificationResults: [{ command: 'npm test', status: 'passed' }],
    });

    expect(prompt).toContain('You are Claude Company');
    expect(prompt).toContain('Do not edit files');
    expect(prompt).toContain('```task-review');
  });

  it('parses an explicit reviewer verdict and preserves findings', () => {
    expect(parseCollaborationTaskReview([
      '```task-review',
      '{"verdict":"changes-needed","findings":["Missing restart test"]}',
      '```',
    ].join('\n'))).toEqual({
      verdict: 'changes-needed',
      findings: ['Missing restart test'],
    });
  });
});
