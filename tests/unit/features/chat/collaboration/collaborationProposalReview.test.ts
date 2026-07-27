import {
  applyCollaborationProposalHunks,
  createCollaborationProposalReview,
} from '@/features/chat/collaboration/collaborationProposalReview';

describe('collaborationProposalReview', () => {
  it('builds independently selectable hunks with line-change totals', () => {
    const review = createCollaborationProposalReview(
      'alpha\nkeep\nmiddle\nkeep-again\nomega\n',
      'ALPHA\nkeep\nmiddle\nkeep-again\nOMEGA\n',
    );

    expect(review.hunks).toHaveLength(2);
    expect(review.stats).toEqual({ added: 2, removed: 2 });
    expect(review.hunks[0]).toMatchObject({
      id: 'hunk-1',
      oldStart: 1,
      oldLines: ['alpha'],
      newLines: ['ALPHA'],
    });
    expect(review.hunks[1]).toMatchObject({
      id: 'hunk-2',
      oldStart: 5,
      oldLines: ['omega'],
      newLines: ['OMEGA'],
    });
  });

  it('applies only selected hunks without changing unrelated content', () => {
    const current = 'alpha\nkeep\nmiddle\nkeep-again\nomega\n';
    const review = createCollaborationProposalReview(
      current,
      'ALPHA\nkeep\nmiddle\nkeep-again\nOMEGA\n',
    );

    expect(applyCollaborationProposalHunks(
      current,
      review.hunks,
      new Set(['hunk-2']),
    )).toBe('alpha\nkeep\nmiddle\nkeep-again\nOMEGA\n');
  });

  it('preserves a missing trailing newline', () => {
    const current = 'one\ntwo';
    const review = createCollaborationProposalReview(current, 'one\nTWO');

    expect(applyCollaborationProposalHunks(
      current,
      review.hunks,
      new Set(review.hunks.map(hunk => hunk.id)),
    )).toBe('one\nTWO');
  });
});
