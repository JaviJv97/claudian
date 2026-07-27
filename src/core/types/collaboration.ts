import type { ProviderQuotaSnapshot } from '../runtime/types';
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
export type CollaborationRouteSource = 'explicit' | 'deterministic' | 'default';

export interface CollaborationRoutingSettings {
  selection: 'manual' | 'auto';
  defaultMode: CollaborationDiscussionMode;
  roundTable: {
    participantOrder: string[];
    startingParticipantId?: string;
    cycles: number;
    rotateStarter: boolean;
  };
  facilitatorParticipantId?: string;
  synthesizerParticipantId?: string;
}

export interface CollaborationEffectiveRoute {
  mode: CollaborationDiscussionMode;
  source: CollaborationRouteSource;
  recipientIds: string[];
  orderedParticipantIds: string[];
  cycleOrders: string[][];
  cycles: number;
  facilitatorParticipantId?: string;
  synthesizerParticipantId?: string;
  reasons: string[];
  warnings: string[];
}
export type CollaborationDeliberationPhase =
  | 'position'
  | 'critique'
  | 'synthesis'
  | 'ratification';
export type CollaborationWorkflowPhase = 'execution' | 'review' | 'verification' | 'checkpoint';
export type CollaborationTaskStatus =
  | 'draft'
  | 'blocked'
  | 'ready'
  | 'running'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface CollaborationTaskVerificationResult {
  command: string;
  status: 'passed' | 'failed';
  output?: string;
}

export interface CollaborationTaskEvidence {
  summary: string;
  filesChanged: string[];
  acceptanceCriteriaMet: string[];
  verificationResults: CollaborationTaskVerificationResult[];
  commitSha?: string;
  knownLimitations?: string[];
  completedAt?: number;
  review?: {
    reviewerId: string;
    verdict: 'approve' | 'changes-needed';
    findings: string[];
    reviewedAt: number;
  };
  resourceUsage?: CollaborationResourceUsageSnapshot[];
}

export interface CollaborationWorkTask {
  id: string;
  title: string;
  description: string;
  status: CollaborationTaskStatus;
  ownerId: string;
  reviewerId: string;
  dependsOn: string[];
  fileScopes: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  risk: 'low' | 'medium' | 'high';
  attempts: number;
  maxAttempts: number;
  evidence?: CollaborationTaskEvidence;
  evidenceHistory?: CollaborationTaskEvidence[];
  failure?: {
    reason: string;
    failedAt: number;
  };
  createdAt: number;
  updatedAt: number;
}

export interface CollaborationWorkQueue {
  version: 1;
  status: 'draft' | 'approved' | 'paused' | 'completed';
  sourceDeliberationId: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  completionApprovedAt?: number;
  tasks: CollaborationWorkTask[];
}

export interface CollaborationDeliberationOutcome {
  status: 'unanimous' | 'approved-with-concerns' | 'rejected' | 'incomplete';
  approvals: string[];
  objections: string[];
  concerns: string[];
  missing: string[];
  synthesisEventId?: string;
  /** Present when infrastructure interrupted a phase before deliberation completed. */
  interruptedPhase?: CollaborationDeliberationPhase;
  interruptionReason?: 'failed' | 'cancelled' | 'missing-response';
}

export interface CollaborationWorkflowMetadata {
  id: string;
  deliberationId: string;
  phase: CollaborationWorkflowPhase;
  taskId?: string;
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
  mode: 'active' | 'preserve' | 'muted' | 'unavailable';
  /** Manual fallback used when a provider snapshot is unavailable. */
  weeklyUsagePercent?: number;
  /** Last provider-reported account snapshot. Safe to persist; contains no credentials. */
  quotaSnapshot?: ProviderQuotaSnapshot;
  /** Bounded, credential-free samples used for local trends and projections. */
  quotaHistory?: CollaborationQuotaHistoryPoint[];
  quotaRefreshError?: string;
  /** Automatic refresh backoff deadline after repeated provider failures. */
  quotaNextRetryAt?: number;
}

export interface CollaborationQuotaHistoryPoint {
  fetchedAt: number;
  windows: ProviderQuotaSnapshot['windows'];
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
  /** Immutable routing decision used for this turn. */
  effectiveRoute?: CollaborationEffectiveRoute;
  roundTableCycle?: {
    id: string;
    index: number;
    total: number;
  };
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
  routing?: CollaborationRoutingSettings;
  /** Last durable room event included in each participant's model context. */
  participantLastSeenEventIds?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  participants: CollaborationParticipant[];
  events: CollaborationEvent[];
  workQueue?: CollaborationWorkQueue;
  workQueueHistory?: CollaborationWorkQueue[];
}
