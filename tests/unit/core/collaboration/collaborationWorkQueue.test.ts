import {
  approveCollaborationWorkQueue,
  findCollaborationTaskScopeConflicts,
  parseCollaborationTaskGraph,
  setCollaborationWorkQueuePaused,
  transitionCollaborationTask,
  validateCollaborationWorkQueue,
} from '@/core/collaboration/collaborationWorkQueue';
import type { CollaborationWorkQueue } from '@/core/types';

const participants = ['personal', 'company', 'codex'];

function queue(): CollaborationWorkQueue {
  return {
    version: 1,
    status: 'draft',
    sourceDeliberationId: 'delib-1',
    createdAt: 10,
    updatedAt: 10,
    tasks: [
      {
        id: 'TASK-001',
        title: 'Implement queue',
        description: 'Build the core.',
        status: 'draft',
        ownerId: 'codex',
        reviewerId: 'company',
        dependsOn: [],
        fileScopes: ['src/core/**'],
        acceptanceCriteria: ['Queue persists'],
        verificationCommands: ['npm test'],
        risk: 'medium',
        attempts: 0,
        maxAttempts: 2,
        createdAt: 10,
        updatedAt: 10,
      },
      {
        id: 'TASK-002',
        title: 'Review UI',
        description: 'Inspect the queue UI.',
        status: 'draft',
        ownerId: 'company',
        reviewerId: 'personal',
        dependsOn: ['TASK-001'],
        fileScopes: ['src/features/**'],
        acceptanceCriteria: ['Review recorded'],
        verificationCommands: ['npm test'],
        risk: 'low',
        attempts: 0,
        maxAttempts: 2,
        createdAt: 10,
        updatedAt: 10,
      },
    ],
  };
}

describe('collaboration work queue', () => {
  it('parses the explicit task-graph block without relying on surrounding prose', () => {
    const parsed = parseCollaborationTaskGraph([
      'Recommended plan.',
      '```task-graph',
      JSON.stringify({
        tasks: [{
          id: 'TASK-001',
          title: 'Build it',
          description: 'Implement the feature.',
          ownerId: 'codex',
          reviewerId: 'company',
          dependsOn: [],
          fileScopes: ['src/**'],
          acceptanceCriteria: ['Tests pass'],
          verificationCommands: ['npm test'],
          risk: 'low',
        }],
      }),
      '```',
      'Additional explanation.',
    ].join('\n'), 'delib-1', 25);

    expect(parsed.tasks[0]).toMatchObject({
      id: 'TASK-001',
      status: 'draft',
      ownerId: 'codex',
      maxAttempts: 2,
    });
    expect(parsed.createdAt).toBe(25);
  });

  it('approves a valid graph and derives ready versus blocked states', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);

    expect(approved.status).toBe('approved');
    expect(approved.tasks.map(task => task.status)).toEqual(['ready', 'blocked']);
  });

  it('pauses and resumes without mutating individual task states', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);
    const paused = setCollaborationWorkQueuePaused(approved, true, 21);
    const resumed = setCollaborationWorkQueuePaused(paused, false, 22);

    expect(paused.status).toBe('paused');
    expect(resumed.status).toBe('approved');
    expect(resumed.tasks.map(task => task.status)).toEqual(['ready', 'blocked']);
  });

  it('rejects unknown dependencies, cycles, and same-person review', () => {
    const invalid = queue();
    invalid.tasks[0].dependsOn = ['TASK-002'];
    invalid.tasks[0].reviewerId = 'codex';

    expect(validateCollaborationWorkQueue(invalid, participants)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('must differ'),
        expect.stringContaining('cycle'),
      ]),
    );
  });

  it('detects overlapping scopes among concurrently running tasks', () => {
    const candidate = queue();
    candidate.tasks[0].status = 'running';
    candidate.tasks[1].status = 'running';
    candidate.tasks[1].fileScopes = ['src/core/collaboration/**'];

    expect(findCollaborationTaskScopeConflicts(candidate)).toEqual([
      { leftTaskId: 'TASK-001', rightTaskId: 'TASK-002', scope: 'src/core' },
    ]);
  });

  it('requires complete passing evidence before a reviewer can mark a task done', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);
    const running = transitionCollaborationTask(approved, 'TASK-001', 'running', {
      actorId: 'codex',
      now: 21,
    });
    const review = transitionCollaborationTask(running, 'TASK-001', 'review', {
      actorId: 'codex',
      now: 22,
      evidence: {
        summary: 'Implemented persistence.',
        filesChanged: ['src/core/queue.ts'],
        acceptanceCriteriaMet: ['Queue persists'],
        verificationResults: [{ command: 'npm test', status: 'failed' }],
      },
    });

    expect(() => transitionCollaborationTask(review, 'TASK-001', 'done', {
      actorId: 'company',
      now: 23,
    })).toThrow('passing verification evidence');

    review.tasks[0].evidence!.verificationResults[0].status = 'passed';
    const done = transitionCollaborationTask(review, 'TASK-001', 'done', {
      actorId: 'company',
      now: 24,
    });
    expect(done.tasks.map(task => task.status)).toEqual(['done', 'ready']);
  });

  it('rejects owner evidence that claims files outside the task scope', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);
    const running = transitionCollaborationTask(approved, 'TASK-001', 'running', {
      actorId: 'codex',
      now: 21,
    });

    expect(() => transitionCollaborationTask(running, 'TASK-001', 'review', {
      actorId: 'codex',
      now: 22,
      evidence: {
        summary: 'Changed settings.',
        filesChanged: ['src/features/settings.ts'],
        acceptanceCriteriaMet: ['Queue persists'],
        verificationResults: [{ command: 'npm test', status: 'passed' }],
      },
    })).toThrow('outside its allowed file scopes');
  });

  it('recovers an interrupted running task through failed and respects retry budget', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);
    const running = transitionCollaborationTask(approved, 'TASK-001', 'running', {
      actorId: 'codex',
      now: 21,
    });
    const failed = transitionCollaborationTask(running, 'TASK-001', 'failed', {
      actorId: 'system',
      now: 22,
    });
    const ready = transitionCollaborationTask(failed, 'TASK-001', 'ready', {
      actorId: 'codex',
      now: 23,
    });
    const secondRun = transitionCollaborationTask(ready, 'TASK-001', 'running', {
      actorId: 'codex',
      now: 24,
    });
    const secondFailure = transitionCollaborationTask(secondRun, 'TASK-001', 'failed', {
      actorId: 'system',
      now: 25,
    });

    expect(() => transitionCollaborationTask(secondFailure, 'TASK-001', 'ready', {
      actorId: 'codex',
      now: 26,
    })).toThrow('exhausted its retry budget');
  });
});
