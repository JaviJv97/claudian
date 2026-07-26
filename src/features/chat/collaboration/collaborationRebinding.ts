import type { CollaborationRoom, ProviderId } from '../../../core/types';
import type { TabId } from '../tabs/types';

export interface CollaborationTabIdentity {
  tabId: TabId;
  providerId: ProviderId;
  conversationId: string | null;
  roomId: string | null;
}

export interface CollaborationRebindCandidate {
  tabId: TabId;
  providerId: ProviderId;
  previousConversationId: string;
  conversationId: string;
}

export function findCollaborationRebindCandidates(
  room: CollaborationRoom,
  tabs: readonly CollaborationTabIdentity[],
): CollaborationRebindCandidate[] {
  const candidates: CollaborationRebindCandidate[] = [];

  for (const participant of room.participants) {
    const alreadyOpen = tabs.some(tab => (
      tab.conversationId === participant.conversationId
    ));
    if (alreadyOpen) continue;

    const replacements = tabs.filter(tab => (
      tab.providerId === participant.providerId
      && tab.conversationId
      && tab.roomId === null
    ));
    if (replacements.length !== 1) continue;

    candidates.push({
      tabId: replacements[0].tabId,
      providerId: participant.providerId,
      previousConversationId: participant.conversationId,
      conversationId: replacements[0].conversationId!,
    });
  }

  return candidates.length === 1 ? candidates : [];
}
