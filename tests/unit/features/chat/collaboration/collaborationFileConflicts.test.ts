import {
  captureCollaborationFileSnapshot,
  findChangedSharedFiles,
  findSharedReferencedFiles,
  findStaleFileProposals,
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

  it('captures an attributed proposal when an agent edits against a stale revision', () => {
    const baseline = new Map([
      ['Shared.md', { revision: '10:20', content: 'original' }],
    ]);
    const before = new Map([
      ['Shared.md', { revision: '11:24', content: 'accepted first edit' }],
    ]);
    const after = new Map([
      ['Shared.md', { revision: '12:30', content: 'stale second edit' }],
    ]);

    expect(findStaleFileProposals(
      baseline,
      before,
      after,
      'codex',
      'Updated the shared section.',
      100,
    )).toEqual([{
      path: 'Shared.md',
      participantId: 'codex',
      baseRevision: '10:20',
      currentRevision: '11:24',
      acceptedContent: 'accepted first edit',
      proposedContent: 'stale second edit',
      summary: 'Updated the shared section.',
      createdAt: 100,
    }]);
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
