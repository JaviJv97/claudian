import type {
  CollaborationDeliveryStatus,
  CollaborationFileProposal,
  CollaborationRoom,
  ProviderId,
} from '../../../core/types';

export interface RetryableCollaborationDelivery {
  providerId: ProviderId;
  status: Extract<CollaborationDeliveryStatus, 'failed' | 'cancelled' | 'conflict'>;
  content: string;
  eventId: string;
  conflictFiles?: string[];
  fileProposals?: CollaborationFileProposal[];
}

export function getLatestRetryableDeliveries(
  room: CollaborationRoom,
): RetryableCollaborationDelivery[] {
  const latestUserEvent = [...room.events].reverse().find(event => event.authorId === 'user');
  if (!latestUserEvent) return [];

  return Object.entries(latestUserEvent.delivery).flatMap(([providerId, delivery]) => (
    delivery.status === 'failed'
      || delivery.status === 'cancelled'
      || delivery.status === 'conflict'
      ? [{
        providerId,
        status: delivery.status,
        content: latestUserEvent.recipientContent?.[providerId] ?? latestUserEvent.content,
        eventId: latestUserEvent.id,
        conflictFiles: delivery.conflictFiles,
        fileProposals: delivery.fileProposals,
      }]
      : []
  ));
}
