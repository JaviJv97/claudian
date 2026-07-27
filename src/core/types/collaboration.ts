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
export type CollaborationWorkflowPhase = 'execution' | 'review' | 'verification' | 'checkpoint';

export interface CollaborationDeliberationOutcome {
  status: 'unanimous' | 'approved-with-concerns' | 'rejected';
  approvals: string[];
  objections: string[];
  concerns: string[];
  missing: string[];
  synthesisEventId?: string;
}

export interface CollaborationWorkflowMetadata {
  id: string;
  deliberationId: string;
  phase: CollaborationWorkflowPhase;
}

export interface CollaborationResourceUsageSnapshot {
  participantId: string;
  contextTokens: number;
  contextPercent: number;
  contextTokenDelta: number;
  turns?: number;
  weeklyUsagePercent?: number;
}

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
  resourcePolicy?: CollaborationParticipantResourcePolicy;
}

export interface CollaborationParticipantResourcePolicy {
  mode: 'active' | 'preserve' | 'unavailable';
  /** User-reported provider quota utilization; providers do not expose this reliably. */
  weeklyUsagePercent?: number;
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
  deliberationOutcome?: CollaborationDeliberationOutcome;
  workflow?: CollaborationWorkflowMetadata;
  workflowDecision?: 'approved' | 'changes-requested';
  resourceUsage?: CollaborationResourceUsageSnapshot[];
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
