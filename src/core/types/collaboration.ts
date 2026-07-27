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
export type CollaborationDiscussionMode =
  | 'parallel'
  | 'round-table'
  | 'deliberation'
  | 'mentioned-only';
export type CollaborationDeliberationPhase =
  | 'position'
  | 'critique'
  | 'synthesis'
  | 'ratification';

export interface CollaborationMembership {
  roomId: string;
  participantId: string;
  conversationIds: Record<string, string>;
}

export interface CollaborationParticipant {
  /** Stable room-local identity. Missing only on legacy two-participant rooms. */
  id?: string;
  providerId: ProviderId;
  label?: string;
  runtimeProfileId?: string;
  conversationId: string;
}

export interface CollaborationDelivery {
  status: CollaborationDeliveryStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  providerMessageId?: string;
  conflictFiles?: string[];
  fileProposals?: CollaborationFileProposal[];
  resolution?: 'kept-current' | 'applied-proposal';
  resolutionProviderId?: string;
}

export interface CollaborationFileProposal {
  path: string;
  participantId: string;
  baseRevision: string;
  currentRevision: string;
  /** Missing only on proposals persisted before line-level review was introduced. */
  acceptedContent?: string;
  proposedContent: string;
  summary?: string;
  createdAt: number;
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
  recipientContent?: Partial<Record<string, string>>;
  createdAt: number;
  delivery: Record<string, CollaborationDelivery>;
  attachments?: CollaborationAttachment[];
  sourceMessageId?: string;
  deliberationId?: string;
  deliberationPhase?: CollaborationDeliberationPhase;
}

export interface CollaborationRoom {
  version: 1;
  id: string;
  title: string;
  /** Missing on legacy rooms and treated as active. */
  status?: 'active' | 'archived';
  archivedAt?: number;
  /** Legacy rooms default to parallel delivery. */
  discussionMode?: CollaborationDiscussionMode;
  /** Last durable room event included in each participant's model context. */
  participantLastSeenEventIds?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  participants: CollaborationParticipant[];
  events: CollaborationEvent[];
}
