import type {
  CollaborationDeliveryStatus,
  CollaborationRoom,
  ProviderId,
} from '../../../core/types';

export interface RetryableCollaborationDelivery {
  providerId: ProviderId;
  status: Extract<CollaborationDeliveryStatus, 'failed' | 'cancelled'>;
  content: string;
  eventId: string;
}

export function getLatestRetryableDeliveries(
  room: CollaborationRoom,
): RetryableCollaborationDelivery[] {
  const latestUserEvent = [...room.events].reverse().find(event => event.authorId === 'user');
  if (!latestUserEvent) return [];

  return Object.entries(latestUserEvent.delivery).flatMap(([providerId, delivery]) => (
    delivery.status === 'failed' || delivery.status === 'cancelled'
      ? [{
        providerId,
        status: delivery.status,
        content: latestUserEvent.content,
        eventId: latestUserEvent.id,
      }]
      : []
  ));
}
