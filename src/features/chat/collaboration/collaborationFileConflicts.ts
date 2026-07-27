export interface CollaborationFileVersion {
  path: string;
  mtime: number;
  size: number;
}

export type CollaborationFileSnapshot = ReadonlyMap<string, string>;

export interface CollaborationFileContentState {
  revision: string;
  content: string;
}

export type CollaborationFileContentSnapshot =
  ReadonlyMap<string, CollaborationFileContentState>;

export function createCollaborationFileRevision(
  _mtime: number,
  size: number,
  content: string,
): string {
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${size}:${(hash >>> 0).toString(16)}`;
}

export function captureCollaborationFileSnapshot(
  files: readonly CollaborationFileVersion[],
): CollaborationFileSnapshot {
  return new Map(files.map(file => [
    file.path,
    `${file.mtime}:${file.size}`,
  ]));
}

export function findSharedReferencedFiles(
  contentByParticipant: Readonly<Record<string, string>>,
  vaultPaths: readonly string[],
): string[] {
  const referenceCounts = new Map<string, number>();

  for (const content of Object.values(contentByParticipant)) {
    for (const path of vaultPaths) {
      const basename = path.split('/').at(-1) ?? path;
      if (!content.includes(path) && !content.includes(basename)) continue;
      referenceCounts.set(path, (referenceCounts.get(path) ?? 0) + 1);
    }
  }

  return [...referenceCounts]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort();
}

export function findChangedSharedFiles(
  baseline: CollaborationFileSnapshot,
  current: CollaborationFileSnapshot,
  sharedPaths: readonly string[],
): string[] {
  return sharedPaths.filter(path => baseline.get(path) !== current.get(path));
}

export function findStaleFileProposals(
  baseline: CollaborationFileContentSnapshot,
  before: CollaborationFileContentSnapshot,
  after: CollaborationFileContentSnapshot,
  participantId: string,
  now = Date.now(),
): Array<{
  path: string;
  participantId: string;
  baseRevision: string;
  currentRevision: string;
  proposedContent: string;
  createdAt: number;
}> {
  const proposals = [];
  for (const [path, base] of baseline) {
    const current = before.get(path);
    const proposed = after.get(path);
    if (
      !current
      || !proposed
      || current.revision === base.revision
      || proposed.revision === current.revision
    ) continue;
    proposals.push({
      path,
      participantId,
      baseRevision: base.revision,
      currentRevision: current.revision,
      proposedContent: proposed.content,
      createdAt: now,
    });
  }
  return proposals;
}
