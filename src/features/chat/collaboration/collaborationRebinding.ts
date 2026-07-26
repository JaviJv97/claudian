import { getCollaborationParticipantId } from '../../../core/collaboration/collaborationRoom';
import type { CollaborationRoom, ProviderId } from '../../../core/types';
import type { TabId } from '../tabs/types';

export interface CollaborationTabIdentity {
  tabId: TabId;
  providerId: ProviderId;
  runtimeProfileId?: string;
  conversationId: string | null;
  roomId: string | null;
}

export interface CollaborationRebindCandidate {
  tabId: TabId;
  participantId: string;
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
      && (
        !participant.runtimeProfileId
        || tab.runtimeProfileId === participant.runtimeProfileId
      )
      && tab.conversationId
      && tab.roomId === null
    ));
    if (replacements.length !== 1) continue;

    candidates.push({
      tabId: replacements[0].tabId,
      participantId: getCollaborationParticipantId(participant),
      providerId: participant.providerId,
      previousConversationId: participant.conversationId,
      conversationId: replacements[0].conversationId!,
    });
  }

  return candidates.length === 1 ? candidates : [];
}
