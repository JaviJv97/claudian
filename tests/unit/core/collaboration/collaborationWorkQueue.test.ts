import {
  approveCollaborationWorkQueue,
  approveCompletedCollaborationWorkQueue,
  findCollaborationTaskScopeConflicts,
  getRecommendedCollaborationWorkTask,
  isCollaborationPathInTaskScope,
  parseCollaborationTaskGraph,
  setCollaborationWorkQueuePaused,
  transitionCollaborationTask,
  updateCollaborationDraftTaskAssignment,
  updateCollaborationDraftTaskContract,
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

  it('normalizes missing and duplicate generated task IDs', () => {
    const task = {
      title: 'Build it',
      description: 'Implement.',
      ownerId: 'codex',
      reviewerId: 'company',
      dependsOn: [],
      fileScopes: ['src/**'],
      acceptanceCriteria: ['Passes'],
      verificationCommands: ['npm test'],
      risk: 'low',
    };
    const parsed = parseCollaborationTaskGraph([
      '```task-graph',
      JSON.stringify({
        tasks: [
          { ...task, id: 'TASK-001' },
          { ...task, id: 'TASK-001', title: 'Review it', dependsOn: ['TASK-001'] },
          { ...task, id: '', title: 'Document it' },
        ],
      }),
      '```',
    ].join('\n'), 'delib-1', 25);

    expect(parsed.tasks.map(candidate => candidate.id)).toEqual([
      'TASK-001',
      'TASK-002',
      'TASK-003',
    ]);
    expect(new Set(parsed.tasks.map(candidate => candidate.id))).toHaveProperty('size', 3);
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

  it('lets in-flight work reach review while new scheduling is paused', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);
    const running = transitionCollaborationTask(approved, 'TASK-001', 'running', {
      actorId: 'codex',
      now: 21,
    });
    const paused = setCollaborationWorkQueuePaused(running, true, 22);
    const review = transitionCollaborationTask(paused, 'TASK-001', 'review', {
      actorId: 'codex',
      now: 23,
      evidence: {
        summary: 'Implemented.',
        filesChanged: ['src/core/queue.ts'],
        acceptanceCriteriaMet: ['Queue persists'],
        verificationResults: [{ command: 'npm test', status: 'passed' }],
      },
    });

    expect(review.status).toBe('paused');
    expect(review.tasks[0].status).toBe('review');
    const freshPaused = setCollaborationWorkQueuePaused(approved, true, 24);
    expect(() => transitionCollaborationTask(freshPaused, 'TASK-001', 'running', {
      actorId: 'codex',
      now: 24,
    })).toThrow('scheduling is paused');
  });

  it('lets a human reassign a draft task while preserving independent review', () => {
    const updated = updateCollaborationDraftTaskAssignment(
      queue(),
      'TASK-001',
      'company',
      'personal',
      participants,
      20,
    );

    expect(updated.tasks[0]).toMatchObject({
      ownerId: 'company',
      reviewerId: 'personal',
      updatedAt: 20,
    });
    expect(() => updateCollaborationDraftTaskAssignment(
      updated,
      'TASK-001',
      'company',
      'company',
      participants,
    )).toThrow('must differ');
  });

  it('lets a human repair a draft task contract before approval', () => {
    const updated = updateCollaborationDraftTaskContract(queue(), 'TASK-001', {
      title: 'Persist queue atomically',
      description: 'Persist the queue atomically.',
      dependsOn: [],
      fileScopes: ['src/core/**', 'tests/unit/core/**'],
      acceptanceCriteria: ['Queue survives restart', 'Stale writes fail'],
      verificationCommands: ['npm run typecheck', 'npm test'],
      risk: 'high',
      maxAttempts: 3,
    }, 20);

    expect(updated.tasks[0]).toMatchObject({
      description: 'Persist the queue atomically.',
      title: 'Persist queue atomically',
      fileScopes: ['src/core/**', 'tests/unit/core/**'],
      risk: 'high',
      maxAttempts: 3,
      updatedAt: 20,
    });
    expect(() => updateCollaborationDraftTaskContract(updated, 'TASK-001', {
      verificationCommands: [],
    })).toThrow('verification command');
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

  it('rejects destructive verification commands and scopes outside the workspace', () => {
    const unsafe = queue();
    unsafe.tasks[0].verificationCommands = ['rm -rf build'];
    unsafe.tasks[0].fileScopes = ['../shared/**'];

    expect(validateCollaborationWorkQueue(unsafe, participants)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('unsafe file scope'),
        expect.stringContaining('destructive verification command'),
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

  it('matches concrete workspace paths against bounded task scopes', () => {
    expect(isCollaborationPathInTaskScope(
      'src/core/collaboration/queue.ts',
      ['src/core/**'],
    )).toBe(true);
    expect(isCollaborationPathInTaskScope(
      'src/features/chat.ts',
      ['src/core/**'],
    )).toBe(false);
    expect(isCollaborationPathInTaskScope('package.json', ['package.json'])).toBe(true);
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

  it('archives stale evidence before a retry starts', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);
    approved.tasks[0].status = 'failed';
    approved.tasks[0].attempts = 1;
    approved.tasks[0].evidence = {
      summary: 'First attempt failed review.',
      filesChanged: ['src/core/old.ts'],
      acceptanceCriteriaMet: [],
      verificationResults: [{ command: 'npm test', status: 'failed' }],
    };
    const ready = transitionCollaborationTask(approved, 'TASK-001', 'ready', {
      actorId: 'codex',
      now: 21,
    });
    const running = transitionCollaborationTask(ready, 'TASK-001', 'running', {
      actorId: 'codex',
      now: 22,
    });

    expect(running.tasks[0].evidence).toBeUndefined();
    expect(running.tasks[0].evidenceHistory).toHaveLength(1);
    expect(running.tasks[0].attempts).toBe(2);
  });

  it('keeps final human approval distinct from reviewer completion', () => {
    const completed = queue();
    completed.status = 'completed';
    completed.tasks = completed.tasks.map(task => ({ ...task, status: 'done' }));

    const accepted = approveCompletedCollaborationWorkQueue(completed, 30);

    expect(accepted.status).toBe('completed');
    expect(accepted.completionApprovedAt).toBe(30);
  });

  it('recommends a low-risk ready task without consuming protected accounts', () => {
    const approved = approveCollaborationWorkQueue(queue(), participants, 20);
    approved.tasks.push({
      ...approved.tasks[0],
      id: 'TASK-003',
      title: 'Safe task',
      ownerId: 'company',
      reviewerId: 'codex',
      risk: 'low',
      status: 'ready',
    });

    expect(getRecommendedCollaborationWorkTask(approved, {
      codex: { mode: 'active', weeklyUsagePercent: 20 },
      company: { mode: 'active', weeklyUsagePercent: 1 },
      personal: { mode: 'preserve', weeklyUsagePercent: 97 },
    })?.id).toBe('TASK-003');

    approved.tasks[0].status = 'blocked';
    approved.tasks[2].ownerId = 'personal';
    expect(getRecommendedCollaborationWorkTask(approved, {
      codex: { mode: 'active', weeklyUsagePercent: 20 },
      company: { mode: 'active', weeklyUsagePercent: 1 },
      personal: { mode: 'preserve', weeklyUsagePercent: 97 },
    })).toBeUndefined();

    approved.tasks[2].ownerId = 'company';
    approved.tasks[2].risk = 'high';
    expect(getRecommendedCollaborationWorkTask(approved, {
      codex: { mode: 'active', weeklyUsagePercent: 20 },
      company: { mode: 'active', weeklyUsagePercent: 1 },
      personal: { mode: 'active', weeklyUsagePercent: 1 },
    })).toBeUndefined();
  });
});
