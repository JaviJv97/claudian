import type { ProviderId } from './provider';

export type CollaborationAuthorId = 'user' | 'system' | ProviderId;
export type CollaborationRecipientId = 'user' | ProviderId;
export type CollaborationDeliveryStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'conflict'
  | 'resolved'
  | 'failed'
  | 'cancelled';

export interface CollaborationMembership {
  roomId: string;
  participantId: ProviderId;
  conversationIds: Record<ProviderId, string>;
}

export interface CollaborationParticipant {
  providerId: ProviderId;
  conversationId: string;
}

export interface CollaborationDelivery {
  status: CollaborationDeliveryStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  providerMessageId?: string;
  conflictFiles?: string[];
  resolution?: 'kept-current' | 'applied-proposal';
  resolutionProviderId?: ProviderId;
}

export interface CollaborationAttachment {
  id: string;
  name: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
  width?: number;
  height?: number;
  size: number;
}

export interface CollaborationEvent {
  id: string;
  kind: 'message' | 'system';
  authorId: CollaborationAuthorId;
  recipientIds: CollaborationRecipientId[];
  content: string;
  /** Provider-specific prompt text for addressed multi-participant turns. */
  recipientContent?: Partial<Record<ProviderId, string>>;
  createdAt: number;
  delivery: Record<ProviderId, CollaborationDelivery>;
  attachments?: CollaborationAttachment[];
  sourceMessageId?: string;
}

export interface CollaborationRoom {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  participants: CollaborationParticipant[];
  events: CollaborationEvent[];
}
