import type { TabBarItem, TabId } from '../tabs/types';

export function groupCollaborationTabBarItems(
  items: readonly TabBarItem[],
  getRoomId: (tabId: TabId) => string | null,
): TabBarItem[] {
  const grouped = new Map<string, TabBarItem>();
  const visible: TabBarItem[] = [];

  for (const item of items) {
    const roomId = getRoomId(item.id);
    if (!roomId) {
      visible.push({ ...item });
      continue;
    }

    const existing = grouped.get(roomId);
    if (existing) {
      existing.isActive = existing.isActive || item.isActive;
      existing.isStreaming = existing.isStreaming || item.isStreaming;
      existing.needsAttention = existing.needsAttention || item.needsAttention;
      continue;
    }

    const roomItem: TabBarItem = {
      ...item,
      title: 'Claude ×2 + Codex',
      badgeLabel: 'Claude ×2 + Codex',
      providerId: 'collaboration',
      canClose: false,
    };
    grouped.set(roomId, roomItem);
    visible.push(roomItem);
  }

  return visible.map((item, index) => ({ ...item, index: index + 1 }));
}
