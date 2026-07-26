import { groupCollaborationTabBarItems } from '@/features/chat/collaboration/collaborationTabs';
import type { TabBarItem } from '@/features/chat/tabs/types';

function createItem(overrides: Partial<TabBarItem>): TabBarItem {
  return {
    id: 'tab-1',
    index: 1,
    title: 'Conversation',
    providerId: 'claude',
    isActive: false,
    isStreaming: false,
    needsAttention: false,
    canClose: true,
    ...overrides,
  };
}

describe('groupCollaborationTabBarItems', () => {
  it('collapses participant tabs into an accurate participant-count badge', () => {
    const items = [
      createItem({ id: 'claude-tab', providerId: 'claude', isStreaming: true }),
      createItem({
        id: 'codex-tab',
        index: 2,
        providerId: 'codex',
        isActive: true,
      }),
    ];

    expect(groupCollaborationTabBarItems(
      items,
      tabId => tabId.endsWith('-tab') ? 'room-1' : null,
    )).toEqual([
      expect.objectContaining({
        id: 'claude-tab',
        index: 1,
        title: 'Collaboration room with 2 agents',
        badgeLabel: '2 agents',
        isActive: true,
        isStreaming: true,
        canClose: false,
      }),
    ]);
  });

  it('does not reuse the three-agent label for a two-agent room', () => {
    const items = [
      createItem({ id: 'personal-tab', providerId: 'claude' }),
      createItem({ id: 'codex-tab', providerId: 'codex' }),
    ];

    const [badge] = groupCollaborationTabBarItems(
      items,
      tabId => tabId.endsWith('-tab') ? 'room-1' : null,
    );

    expect(badge.badgeLabel).toBe('2 agents');
    expect(badge.title).toBe('Collaboration room with 2 agents');
  });

  it('preserves ordinary tabs and renumbers the visible sequence', () => {
    const items = [
      createItem({ id: 'plain-tab' }),
      createItem({ id: 'claude-tab', index: 2 }),
      createItem({ id: 'codex-tab', index: 3, providerId: 'codex' }),
    ];

    expect(groupCollaborationTabBarItems(
      items,
      tabId => tabId.endsWith('-tab') && tabId !== 'plain-tab' ? 'room-1' : null,
    ).map(item => [item.id, item.index])).toEqual([
      ['plain-tab', 1],
      ['claude-tab', 2],
    ]);
  });
});
