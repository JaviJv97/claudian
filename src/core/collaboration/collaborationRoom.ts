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
  conversationIds: Record<string, string>,
): Record<string, CollaborationMembership> {
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
  participantIds: readonly string[],
): string[] {
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
  participantIds: readonly string[],
): {
  content: string;
  recipientIds: string[];
  recipientContent: Partial<Record<string, string>>;
} {
  const routeNames = ['all', ...participantIds].map(escapeRegExp).join('|');
  const addressedLine = new RegExp(`^\\s*@(${routeNames})\\b\\s*:?\\s*(.*)$`, 'i');
  const sharedLines: string[] = [];
  const participantLines = new Map<string, string[]>(
    participantIds.map(providerId => [providerId, []]),
  );
  let activeRecipients: string[] | null = null;
  let hasAddressedBlock = false;

  for (const line of message.split('\n')) {
    const match = line.match(addressedLine);
    if (match) {
      hasAddressedBlock = true;
      activeRecipients = match[1].toLowerCase() === 'all'
        ? [...participantIds]
        : participantIds.filter(providerId => (
          providerId.toLowerCase() === match[1].toLowerCase()
        ));
      if (match[2]) {
        for (const providerId of activeRecipients) {
          participantLines.get(providerId)?.push(match[2]);
        }
      }
      continue;
    }

    if (activeRecipients) {
      for (const providerId of activeRecipients) {
        participantLines.get(providerId)?.push(line);
      }
    } else {
      sharedLines.push(line);
    }
  }

  if (hasAddressedBlock) {
    const sharedContent = sharedLines.join('\n').trim();
    const recipientIds = participantIds.filter(providerId => (
      (participantLines.get(providerId)?.join('\n').trim().length ?? 0) > 0
    ));
    const recipientContent = Object.fromEntries(recipientIds.map((providerId) => {
      const addressedContent = participantLines.get(providerId)?.join('\n').trim() ?? '';
      return [
        providerId,
        [sharedContent, addressedContent].filter(Boolean).join('\n'),
      ];
    }));
    const uniqueRecipientContent = new Set(Object.values(recipientContent));
    const content = uniqueRecipientContent.size === 1
      ? uniqueRecipientContent.values().next().value ?? message.trim()
      : message.trim();
    return { content, recipientIds, recipientContent };
  }

  const recipientIds = resolveCollaborationRecipients(message, participantIds);
  const leadingRoute = new RegExp(`^\\s*@(?:${routeNames})\\b\\s*:?\\s*`, 'i');
  const content = message.replace(leadingRoute, '').trim();

  return {
    content,
    recipientIds,
    recipientContent: Object.fromEntries(
      recipientIds.map(providerId => [providerId, content]),
    ),
  };
}

export function getCollaborationParticipantId(
  participant: { id?: string; providerId: ProviderId },
): string {
  return participant.id ?? participant.providerId;
}
