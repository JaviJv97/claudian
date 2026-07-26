import type { CollaborationMembership } from '../types/collaboration';
import type { ProviderId } from '../types/provider';

export function createCollaborationRoomId(now = Date.now()): string {
  return `room-${now}-${Math.random().toString(36).slice(2, 9)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createCollaborationMemberships(
  roomId: string,
  conversationIds: Record<ProviderId, string>,
): Record<ProviderId, CollaborationMembership> {
  return Object.fromEntries(
    Object.keys(conversationIds).map(participantId => [
      participantId,
      {
        roomId,
        participantId,
        conversationIds: { ...conversationIds },
      },
    ]),
  );
}

export function resolveCollaborationRecipients(
  message: string,
  participantIds: readonly ProviderId[],
): ProviderId[] {
  if (/(^|\s)@all\b/i.test(message)) {
    return [...participantIds];
  }

  const mentioned = participantIds.filter((participantId) => {
    const mention = new RegExp(`(^|\\s)@${escapeRegExp(participantId)}\\b`, 'i');
    return mention.test(message);
  });

  return mentioned.length > 0 ? mentioned : [...participantIds];
}

export function resolveCollaborationTurn(
  message: string,
  participantIds: readonly ProviderId[],
): { content: string; recipientIds: ProviderId[] } {
  const recipientIds = resolveCollaborationRecipients(message, participantIds);
  const routeNames = ['all', ...participantIds].map(escapeRegExp).join('|');
  const leadingRoute = new RegExp(`^\\s*@(?:${routeNames})\\b\\s*`, 'i');

  return {
    content: message.replace(leadingRoute, '').trim(),
    recipientIds,
  };
}
