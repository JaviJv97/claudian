export interface CollaborationFileVersion {
  path: string;
  mtime: number;
  size: number;
}

export type CollaborationFileSnapshot = ReadonlyMap<string, string>;

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
