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

export interface CollaborationProfileRepair {
  participantId: string;
  conversationId: string;
  runtimeProfileId: string;
}

export interface CollaborationTabReadiness {
  tabId: TabId;
  conversationId: string | null;
  currentConversationId: string | null;
  hydrationState: 'idle' | 'loading' | 'ready' | 'failed';
}

export interface CollaborationRecipientReadiness {
  tabIdsToHydrate: TabId[];
  missingParticipantIds: string[];
}

export function findCollaborationRecipientReadiness(
  room: CollaborationRoom,
  participantIds: readonly string[],
  tabs: readonly CollaborationTabReadiness[],
): CollaborationRecipientReadiness {
  const tabIdsToHydrate: TabId[] = [];
  const missingParticipantIds: string[] = [];
  for (const participantId of participantIds) {
    const participant = room.participants.find(candidate => (
      getCollaborationParticipantId(candidate) === participantId
    ));
    const tab = participant
      ? tabs.find(candidate => candidate.conversationId === participant.conversationId)
      : undefined;
    if (!participant || !tab) {
      missingParticipantIds.push(participantId);
      continue;
    }
    if (
      tab.hydrationState !== 'ready'
      || tab.currentConversationId !== participant.conversationId
    ) {
      tabIdsToHydrate.push(tab.tabId);
    }
  }
  return { tabIdsToHydrate, missingParticipantIds };
}

export function findCollaborationProfileRepairs(
  room: CollaborationRoom,
  conversations: readonly { id: string; runtimeProfileId?: string }[],
): CollaborationProfileRepair[] {
  const profilesByConversationId = new Map(
    conversations.map(conversation => [conversation.id, conversation.runtimeProfileId]),
  );

  return room.participants.flatMap((participant) => {
    if (
      !participant.runtimeProfileId
      || !profilesByConversationId.has(participant.conversationId)
      || profilesByConversationId.get(participant.conversationId) === participant.runtimeProfileId
    ) {
      return [];
    }
    return [{
      participantId: getCollaborationParticipantId(participant),
      conversationId: participant.conversationId,
      runtimeProfileId: participant.runtimeProfileId,
    }];
  });
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
