import {
  captureCollaborationFileSnapshot,
  findChangedSharedFiles,
  findSharedReferencedFiles,
} from '@/features/chat/collaboration/collaborationFileConflicts';

describe('collaborationFileConflicts', () => {
  it('finds vault files referenced by more than one participant', () => {
    expect(findSharedReferencedFiles({
      claude: 'Edit notes/Shared.md and Claude.md',
      codex: 'Review Shared.md before editing',
    }, [
      'notes/Shared.md',
      'Claude.md',
      'Codex.md',
    ])).toEqual(['notes/Shared.md']);
  });

  it('reports only shared files changed since the turn began', () => {
    const baseline = captureCollaborationFileSnapshot([
      { path: 'Shared.md', mtime: 10, size: 20 },
      { path: 'Stable.md', mtime: 10, size: 20 },
    ]);
    const current = captureCollaborationFileSnapshot([
      { path: 'Shared.md', mtime: 11, size: 24 },
      { path: 'Stable.md', mtime: 10, size: 20 },
    ]);

    expect(findChangedSharedFiles(
      baseline,
      current,
      ['Shared.md', 'Stable.md'],
    )).toEqual(['Shared.md']);
  });
});
