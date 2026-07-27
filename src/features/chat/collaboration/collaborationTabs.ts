import type { TabBarItem, TabId } from '../tabs/types';

export function groupCollaborationTabBarItems(
  items: readonly TabBarItem[],
  getRoomId: (tabId: TabId) => string | null,
): TabBarItem[] {
  const grouped = new Map<string, { item: TabBarItem; participantCount: number }>();
  const visible: TabBarItem[] = [];

  for (const item of items) {
    const roomId = getRoomId(item.id);
    if (!roomId) {
      visible.push({ ...item });
      continue;
    }

    const existing = grouped.get(roomId);
    if (existing) {
      existing.item.isActive = existing.item.isActive || item.isActive;
      existing.item.isStreaming = existing.item.isStreaming || item.isStreaming;
      existing.item.needsAttention = existing.item.needsAttention || item.needsAttention;
      existing.participantCount += 1;
      const agentLabel = `${existing.participantCount} agents`;
      existing.item.title = `Collaboration room with ${agentLabel}`;
      existing.item.badgeLabel = agentLabel;
      continue;
    }

    const roomItem: TabBarItem = {
      ...item,
      title: 'Collaboration room with 1 agent',
      badgeLabel: '1 agent',
      providerId: 'collaboration',
      canClose: false,
    };
    grouped.set(roomId, { item: roomItem, participantCount: 1 });
    visible.push(roomItem);
  }

  return visible.map((item, index) => ({ ...item, index: index + 1 }));
}
