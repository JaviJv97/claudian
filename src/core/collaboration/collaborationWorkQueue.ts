import type {
  CollaborationTaskEvidence,
  CollaborationTaskStatus,
  CollaborationWorkQueue,
  CollaborationWorkTask,
} from '../types';

interface TaskGraphInput {
  tasks?: Array<Partial<CollaborationWorkTask>>;
}

export interface CollaborationTaskTransitionOptions {
  actorId: string;
  now?: number;
  evidence?: CollaborationTaskEvidence;
}

export interface CollaborationTaskScopeConflict {
  leftTaskId: string;
  rightTaskId: string;
  scope: string;
}

function normalizeScope(scope: string): string {
  return scope.replace(/\\/g, '/').replace(/\/?\*.*$/, '').replace(/\/+$/, '');
}

function scopesOverlap(left: string, right: string): string | null {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  if (!normalizedLeft || !normalizedRight) return null;
  if (
    normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`)
  ) {
    return normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  }
  return null;
}

function fileMatchesScope(path: string, scope: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  const normalized = scope.replace(/\\/g, '/').replace(/^\.?\//, '');
  const prefix = normalizeScope(normalized);
  if (!prefix) return false;
  if (normalized.includes('*')) {
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  return normalizedPath === prefix;
}

export function parseCollaborationTaskGraph(
  content: string,
  sourceDeliberationId: string,
  now = Date.now(),
): CollaborationWorkQueue {
  const block = content.match(/```task-graph\s*\n([\s\S]*?)```/i)?.[1];
  if (!block) throw new Error('The synthesis does not contain a task-graph block');
  let parsed: TaskGraphInput;
  try {
    parsed = JSON.parse(block) as TaskGraphInput;
  } catch {
    throw new Error('The synthesis task graph is not valid JSON');
  }
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('The synthesis task graph has no tasks');
  }
  const tasks = parsed.tasks.map((input, index): CollaborationWorkTask => ({
    id: String(input.id ?? `TASK-${String(index + 1).padStart(3, '0')}`),
    title: String(input.title ?? '').trim(),
    description: String(input.description ?? '').trim(),
    status: 'draft',
    ownerId: String(input.ownerId ?? '').trim(),
    reviewerId: String(input.reviewerId ?? '').trim(),
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.map(String) : [],
    fileScopes: Array.isArray(input.fileScopes) ? input.fileScopes.map(String) : [],
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria)
      ? input.acceptanceCriteria.map(String)
      : [],
    verificationCommands: Array.isArray(input.verificationCommands)
      ? input.verificationCommands.map(String)
      : [],
    risk: input.risk === 'high' || input.risk === 'medium' ? input.risk : 'low',
    attempts: 0,
    maxAttempts: Number.isInteger(input.maxAttempts) && Number(input.maxAttempts) > 0
      ? Number(input.maxAttempts)
      : 2,
    createdAt: now,
    updatedAt: now,
  }));
  return {
    version: 1,
    status: 'draft',
    sourceDeliberationId,
    createdAt: now,
    updatedAt: now,
    tasks,
  };
}

export function validateCollaborationWorkQueue(
  queue: CollaborationWorkQueue,
  participantIds: readonly string[],
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const task of queue.tasks) {
    if (!task.id || ids.has(task.id)) errors.push(`Task id ${task.id || '(empty)'} must be unique`);
    ids.add(task.id);
    if (!task.title) errors.push(`${task.id} needs a title`);
    if (!participantIds.includes(task.ownerId)) errors.push(`${task.id} has an unknown owner`);
    if (!participantIds.includes(task.reviewerId)) errors.push(`${task.id} has an unknown reviewer`);
    if (task.ownerId === task.reviewerId) errors.push(`${task.id} owner and reviewer must differ`);
    if (task.fileScopes.length === 0) errors.push(`${task.id} needs at least one file scope`);
    if (task.acceptanceCriteria.length === 0) {
      errors.push(`${task.id} needs at least one acceptance criterion`);
    }
    if (task.verificationCommands.length === 0) {
      errors.push(`${task.id} needs at least one verification command`);
    }
  }
  for (const task of queue.tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) errors.push(`${task.id} has unknown dependency ${dependency}`);
      if (dependency === task.id) errors.push(`${task.id} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(queue.tasks.map(task => [task.id, task]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cyclic = (byId.get(id)?.dependsOn ?? []).some(dependency => (
      byId.has(dependency) && visit(dependency)
    ));
    visiting.delete(id);
    visited.add(id);
    return cyclic;
  };
  if (queue.tasks.some(task => visit(task.id))) errors.push('Task dependency graph contains a cycle');
  return [...new Set(errors)];
}

function synchronizeDependencyStates(queue: CollaborationWorkQueue): void {
  const byId = new Map(queue.tasks.map(task => [task.id, task]));
  for (const task of queue.tasks) {
    if (!['draft', 'ready', 'blocked'].includes(task.status)) continue;
    task.status = task.dependsOn.every(id => byId.get(id)?.status === 'done')
      ? 'ready'
      : 'blocked';
  }
  if (queue.tasks.length > 0 && queue.tasks.every(task => (
    task.status === 'done' || task.status === 'cancelled'
  ))) {
    queue.status = 'completed';
  }
}

export function approveCollaborationWorkQueue(
  queue: CollaborationWorkQueue,
  participantIds: readonly string[],
  now = Date.now(),
): CollaborationWorkQueue {
  const errors = validateCollaborationWorkQueue(queue, participantIds);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  const approved = structuredClone(queue);
  now = Math.max(now, queue.updatedAt + 1);
  approved.status = 'approved';
  approved.approvedAt = now;
  approved.updatedAt = now;
  synchronizeDependencyStates(approved);
  return approved;
}

export function setCollaborationWorkQueuePaused(
  queue: CollaborationWorkQueue,
  paused: boolean,
  now = Date.now(),
): CollaborationWorkQueue {
  if (queue.status === 'draft' || queue.status === 'completed') {
    throw new Error(`Cannot ${paused ? 'pause' : 'resume'} a ${queue.status} queue`);
  }
  const updated = structuredClone(queue);
  now = Math.max(now, queue.updatedAt + 1);
  updated.status = paused ? 'paused' : 'approved';
  updated.updatedAt = now;
  return updated;
}

export function findCollaborationTaskScopeConflicts(
  queue: CollaborationWorkQueue,
): CollaborationTaskScopeConflict[] {
  const active = queue.tasks.filter(task => task.status === 'running');
  const conflicts: CollaborationTaskScopeConflict[] = [];
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      for (const leftScope of active[leftIndex].fileScopes) {
        for (const rightScope of active[rightIndex].fileScopes) {
          const scope = scopesOverlap(leftScope, rightScope);
          if (scope) {
            conflicts.push({
              leftTaskId: active[leftIndex].id,
              rightTaskId: active[rightIndex].id,
              scope,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

function requireEvidence(task: CollaborationWorkTask): CollaborationTaskEvidence {
  const evidence = task.evidence;
  if (
    !evidence?.summary.trim()
    || !task.acceptanceCriteria.every(criterion => evidence.acceptanceCriteriaMet.includes(criterion))
    || !task.verificationCommands.every(command => evidence.verificationResults.some(result => (
      result.command === command && result.status === 'passed'
    )))
  ) {
    throw new Error(`${task.id} needs complete passing verification evidence`);
  }
  return evidence;
}

export function transitionCollaborationTask(
  queue: CollaborationWorkQueue,
  taskId: string,
  nextStatus: CollaborationTaskStatus,
  options: CollaborationTaskTransitionOptions,
): CollaborationWorkQueue {
  if (queue.status !== 'approved') throw new Error('The work queue is not approved');
  const updated = structuredClone(queue);
  const task = updated.tasks.find(candidate => candidate.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const allowed: Partial<Record<CollaborationTaskStatus, CollaborationTaskStatus[]>> = {
    ready: ['running', 'cancelled'],
    running: ['review', 'failed', 'cancelled'],
    review: ['done', 'failed', 'running'],
    failed: ['ready', 'cancelled'],
  };
  if (!allowed[task.status]?.includes(nextStatus)) {
    throw new Error(`Cannot transition ${task.id} from ${task.status} to ${nextStatus}`);
  }
  if (nextStatus === 'running' && options.actorId !== task.ownerId) {
    throw new Error(`Only ${task.ownerId} can run ${task.id}`);
  }
  if (nextStatus === 'review') {
    if (options.actorId !== task.ownerId) throw new Error(`Only ${task.ownerId} can submit ${task.id}`);
    if (!options.evidence) throw new Error(`${task.id} needs execution evidence`);
    const outsideScope = options.evidence.filesChanged.filter(path => (
      !task.fileScopes.some(scope => fileMatchesScope(path, scope))
    ));
    if (outsideScope.length > 0) {
      throw new Error(
        `${task.id} reported files outside its allowed file scopes: ${outsideScope.join(', ')}`,
      );
    }
    task.evidence = structuredClone(options.evidence);
  }
  if (nextStatus === 'done') {
    if (options.actorId !== task.reviewerId) {
      throw new Error(`Only ${task.reviewerId} can approve ${task.id}`);
    }
    requireEvidence(task).completedAt = options.now ?? Date.now();
  }
  if (nextStatus === 'running') {
    const conflicts = updated.tasks.filter(candidate => candidate.status === 'running')
      .flatMap(candidate => task.fileScopes
        .flatMap(scope => candidate.fileScopes.map(other => scopesOverlap(scope, other)))
        .filter((scope): scope is string => scope !== null));
    if (conflicts.length > 0) throw new Error(`${task.id} overlaps an active file scope`);
    task.attempts += 1;
  }
  if (nextStatus === 'ready' && task.attempts >= task.maxAttempts) {
    throw new Error(`${task.id} has exhausted its retry budget`);
  }
  const now = Math.max(options.now ?? Date.now(), queue.updatedAt + 1);
  task.status = nextStatus;
  task.updatedAt = now;
  updated.updatedAt = now;
  synchronizeDependencyStates(updated);
  return updated;
}
