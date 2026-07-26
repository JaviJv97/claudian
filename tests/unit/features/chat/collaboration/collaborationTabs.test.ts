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
  it('collapses participant tabs into one attributed room badge', () => {
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
        title: 'Claude ×2 + Codex',
        badgeLabel: 'Claude ×2 + Codex',
        isActive: true,
        isStreaming: true,
        canClose: false,
      }),
    ]);
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
