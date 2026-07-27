import type { CollaborationRoom } from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getRoutableCollaborationParticipantIds(
  room: CollaborationRoom,
  content: string,
  autonomousWorkflow: boolean,
): string[] {
  return room.participants.flatMap((participant) => {
    const participantId = getCollaborationParticipantId(participant);
    const mode = participant.resourcePolicy?.mode ?? 'active';
    if (mode === 'unavailable') return [];
    if (autonomousWorkflow) return mode === 'active' ? [participantId] : [];
    const explicitlyMentioned = new RegExp(
      `(^|\\s)@${escapeRegExp(participantId)}\\b`,
      'i',
    ).test(content);
    return mode === 'active' || explicitlyMentioned ? [participantId] : [];
  });
}

export function getUnavailableMentionedParticipantIds(
  room: CollaborationRoom,
  content: string,
): string[] {
  return room.participants.flatMap((participant) => {
    const participantId = getCollaborationParticipantId(participant);
    return participant.resourcePolicy?.mode === 'unavailable'
      && new RegExp(`(^|\\s)@${escapeRegExp(participantId)}\\b`, 'i').test(content)
      ? [participantId]
      : [];
  });
}

export function getPreservedMentionedParticipantIds(
  room: CollaborationRoom,
  content: string,
): string[] {
  return room.participants.flatMap((participant) => {
    const participantId = getCollaborationParticipantId(participant);
    return participant.resourcePolicy?.mode === 'preserve'
      && new RegExp(`(^|\\s)@${escapeRegExp(participantId)}\\b`, 'i').test(content)
      ? [participantId]
      : [];
  });
}

export function isReadOnlyCollaborationPlan(content: string): boolean {
  const normalized = content
    .replace(/\bdo not (?:edit|write|create|modify|delete)\b/ig, '')
    .replace(/\bwithout (?:editing|writing|creating|modifying|deleting)\b/ig, '')
    .replace(/\bno (?:file )?(?:edits|writes|changes|modifications|deletions)\b/ig, '');
  return /\b(?:read[- ]only|research|inspect|analy[sz]e|review|report|verify)\b/i
    .test(content)
    && !/\b(?:edit|write|create|modify|delete|implement|fix)\b/i.test(normalized);
}
