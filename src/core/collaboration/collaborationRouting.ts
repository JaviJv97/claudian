import type {
  CollaborationDiscussionMode,
  CollaborationEffectiveRoute,
  CollaborationRoutingSettings,
} from '../types';

export const MAX_ROUND_TABLE_CYCLES = 5;
const DISCUSSION_MODES: readonly CollaborationDiscussionMode[] = [
  'parallel',
  'round-table',
  'deliberation',
  'mentioned-only',
];

export function normalizeCollaborationRoutingSettings(
  settings: Partial<CollaborationRoutingSettings> | undefined,
  participantIds: readonly string[],
  legacyMode: CollaborationDiscussionMode = 'round-table',
): CollaborationRoutingSettings {
  const configuredOrder = Array.isArray(settings?.roundTable?.participantOrder)
    ? settings.roundTable.participantOrder
    : [];
  const order = [...new Set(configuredOrder)]
    .filter(id => participantIds.includes(id));
  for (const participantId of participantIds) {
    if (!order.includes(participantId)) order.push(participantId);
  }
  const configuredCycles = Number(settings?.roundTable?.cycles);
  const cycles = Number.isFinite(configuredCycles)
    ? Math.min(
    MAX_ROUND_TABLE_CYCLES,
      Math.max(1, Math.trunc(configuredCycles)),
    )
    : 1;
  const eligible = (id: string | undefined) => id && participantIds.includes(id)
    ? id
    : undefined;
  return {
    selection: settings?.selection === 'auto' ? 'auto' : 'manual',
    defaultMode: DISCUSSION_MODES.includes(settings?.defaultMode as CollaborationDiscussionMode)
      ? settings?.defaultMode as CollaborationDiscussionMode
      : legacyMode,
    roundTable: {
      participantOrder: order,
      startingParticipantId: eligible(settings?.roundTable?.startingParticipantId),
      cycles,
      rotateStarter: settings?.roundTable?.rotateStarter === true,
    },
    facilitatorParticipantId: eligible(settings?.facilitatorParticipantId),
    synthesizerParticipantId: eligible(settings?.synthesizerParticipantId),
  };
}

function rotate<T>(items: readonly T[], startIndex: number): T[] {
  if (items.length === 0) return [];
  const index = ((startIndex % items.length) + items.length) % items.length;
  return [...items.slice(index), ...items.slice(0, index)];
}

export interface CollaborationRouteInput {
  content: string;
  explicitMode?: CollaborationDiscussionMode;
  explicitRecipientIds: string[];
  explicitRecipients: boolean;
  eligibleParticipantIds: string[];
  sharedReferencedFiles: string[];
  settings: CollaborationRoutingSettings;
}

function resolveAutomaticMode(content: string): {
  mode?: CollaborationDiscussionMode;
  reason?: string;
} {
  if (/\b(?:consensus|ratif(?:y|ication)|final recommendation|decide|decision)\b/i.test(content)
    && /\b(?:challenge|critique|positions?|agree|consensus|final)\b/i.test(content)) {
    return { mode: 'deliberation', reason: 'The prompt requests critique and a decision.' };
  }
  if (/\b(?:build on|previous answer|one at a time|in sequence|then|handoff)\b/i.test(content)) {
    return { mode: 'round-table', reason: 'The prompt describes an ordered dependency.' };
  }
  if (/\b(?:independent|compare|brainstorm|each (?:agent|model)|multiple opinions?)\b/i.test(content)) {
    return { mode: 'parallel', reason: 'The prompt requests independent first-pass responses.' };
  }
  return {};
}

export function resolveCollaborationEffectiveRoute(
  input: CollaborationRouteInput,
): CollaborationEffectiveRoute {
  const recipientIds = input.explicitRecipientIds
    .filter(id => input.eligibleParticipantIds.includes(id));
  let mode = input.explicitMode ?? input.settings.defaultMode;
  let source: CollaborationEffectiveRoute['source'] = input.explicitMode
    ? 'explicit'
    : 'default';
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (
    !input.explicitMode
    && input.sharedReferencedFiles.length > 0
    && recipientIds.length > 1
  ) {
    mode = 'round-table';
    source = 'deterministic';
    reasons.push('Shared file references require sequential delivery.');
  } else if (!input.explicitMode && input.explicitRecipients) {
    mode = 'mentioned-only';
    source = 'explicit';
    reasons.push('Explicit recipients were selected.');
  } else if (!input.explicitMode && input.settings.selection === 'auto') {
    const automatic = resolveAutomaticMode(input.content);
    if (automatic.mode) {
      mode = automatic.mode;
      source = 'deterministic';
      if (automatic.reason) reasons.push(automatic.reason);
    } else {
      reasons.push('No strong routing signal; using the room default.');
    }
  }

  if (input.explicitMode === 'parallel' && input.sharedReferencedFiles.length > 0) {
    warnings.push('Parallel delivery can produce shared-file conflicts.');
  }
  if (mode === 'deliberation' && recipientIds.length < 2 && !input.explicitMode) {
    mode = 'parallel';
    warnings.push('Deliberation requires at least two eligible participants; using one response.');
  }

  const preferred = input.settings.roundTable.participantOrder
    .filter(id => recipientIds.includes(id));
  for (const id of recipientIds) {
    if (!preferred.includes(id)) preferred.push(id);
  }
  const starterIndex = input.settings.roundTable.startingParticipantId
    ? preferred.indexOf(input.settings.roundTable.startingParticipantId)
    : 0;
  const orderedParticipantIds = rotate(preferred, starterIndex < 0 ? 0 : starterIndex);
  const cycles = mode === 'round-table'
    ? input.settings.roundTable.cycles
    : 1;
  const cycleOrders = Array.from({ length: cycles }, (_, index) => (
    input.settings.roundTable.rotateStarter
      ? rotate(orderedParticipantIds, index)
      : [...orderedParticipantIds]
  ));
  const facilitatorParticipantId = input.settings.facilitatorParticipantId
    && recipientIds.includes(input.settings.facilitatorParticipantId)
    ? input.settings.facilitatorParticipantId
    : undefined;
  const synthesizerParticipantId = input.settings.synthesizerParticipantId
    && recipientIds.includes(input.settings.synthesizerParticipantId)
    ? input.settings.synthesizerParticipantId
    : undefined;
  if (input.settings.facilitatorParticipantId && !facilitatorParticipantId) {
    warnings.push('The configured facilitator is not eligible for this turn.');
  }
  if (input.settings.synthesizerParticipantId && !synthesizerParticipantId) {
    warnings.push('The configured synthesizer is not eligible for this turn.');
  }

  return {
    mode,
    source,
    recipientIds,
    orderedParticipantIds,
    cycleOrders,
    cycles,
    facilitatorParticipantId,
    synthesizerParticipantId,
    reasons,
    warnings,
  };
}
