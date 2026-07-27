import type { DiffLine, DiffStats } from '../../../core/types/diff';

export interface CollaborationProposalHunk {
  id: string;
  oldStart: number;
  oldLines: string[];
  newLines: string[];
  diffLines: DiffLine[];
}

export interface CollaborationProposalReview {
  hunks: CollaborationProposalHunk[];
  stats: DiffStats;
}

type LineOperation = {
  type: DiffLine['type'];
  text: string;
};

const MAX_LCS_CELLS = 1_000_000;

function createLineOperations(oldLines: string[], newLines: string[]): LineOperation[] {
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return [
      ...oldLines.map(text => ({ type: 'delete' as const, text })),
      ...newLines.map(text => ({ type: 'insert' as const, text })),
    ];
  }

  const lengths = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(newLines.length + 1),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lengths[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lengths[oldIndex + 1][newIndex], lengths[oldIndex][newIndex + 1]);
    }
  }

  const operations: LineOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({ type: 'equal', text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1]) {
      operations.push({ type: 'delete', text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      operations.push({ type: 'insert', text: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    operations.push({ type: 'delete', text: oldLines[oldIndex++] });
  }
  while (newIndex < newLines.length) {
    operations.push({ type: 'insert', text: newLines[newIndex++] });
  }
  return operations;
}

export function createCollaborationProposalReview(
  acceptedContent: string,
  proposedContent: string,
): CollaborationProposalReview {
  const operations = createLineOperations(
    acceptedContent.split('\n'),
    proposedContent.split('\n'),
  );
  const hunks: CollaborationProposalHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: CollaborationProposalHunk | null = null;
  let added = 0;
  let removed = 0;

  for (const operation of operations) {
    if (operation.type === 'equal') {
      current = null;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (!current) {
      current = {
        id: `hunk-${hunks.length + 1}`,
        oldStart: oldLine,
        oldLines: [],
        newLines: [],
        diffLines: [],
      };
      hunks.push(current);
    }
    if (operation.type === 'delete') {
      current.oldLines.push(operation.text);
      current.diffLines.push({ type: 'delete', text: operation.text, oldLineNum: oldLine });
      oldLine += 1;
      removed += 1;
    } else {
      current.newLines.push(operation.text);
      current.diffLines.push({ type: 'insert', text: operation.text, newLineNum: newLine });
      newLine += 1;
      added += 1;
    }
  }

  return { hunks, stats: { added, removed } };
}

export function applyCollaborationProposalHunks(
  acceptedContent: string,
  hunks: readonly CollaborationProposalHunk[],
  selectedHunkIds: ReadonlySet<string>,
): string {
  const lines = acceptedContent.split('\n');
  for (const hunk of [...hunks].reverse()) {
    if (!selectedHunkIds.has(hunk.id)) continue;
    lines.splice(hunk.oldStart - 1, hunk.oldLines.length, ...hunk.newLines);
  }
  return lines.join('\n');
}
