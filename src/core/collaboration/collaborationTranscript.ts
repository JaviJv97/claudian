import type { CollaborationEvent, CollaborationRoom } from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

export interface BuildCollaborationPromptOptions {
  currentEventId: string;
  maxTranscriptChars?: number;
}

function getAuthorLabel(room: CollaborationRoom, authorId: string): string {
  if (authorId === 'user') return 'User';
  if (authorId === 'system') return 'System';
  const participant = room.participants.find(candidate => (
    getCollaborationParticipantId(candidate) === authorId
  ));
  return participant?.label ?? authorId;
}

function getUnseenEvents(
  room: CollaborationRoom,
  participantId: string,
  currentEventId: string,
): CollaborationEvent[] {
  const lastSeenId = room.participantLastSeenEventIds?.[participantId];
  const lastSeenIndex = lastSeenId
    ? room.events.findIndex(event => event.id === lastSeenId)
    : -1;
  return room.events
    .slice(lastSeenIndex + 1)
    .filter(event => event.id !== currentEventId && event.authorId !== participantId);
}

export function buildCollaborationPrompt(
  room: CollaborationRoom,
  participantId: string,
  latestUserContent: string,
  options: BuildCollaborationPromptOptions,
): string {
  const maxTranscriptChars = options.maxTranscriptChars ?? 12_000;
  const participantNames = room.participants
    .map(participant => participant.label ?? getCollaborationParticipantId(participant))
    .join(', ');
  const lines = getUnseenEvents(room, participantId, options.currentEventId)
    .map(event => `[${getAuthorLabel(room, event.authorId)}]: ${event.content}`);
  const retained: string[] = [];
  let retainedLength = 0;
  for (const line of lines.reverse()) {
    if (retainedLength + line.length > maxTranscriptChars) break;
    retained.unshift(line);
    retainedLength += line.length;
  }
  const omitted = retained.length < lines.length;
  const transcript = [
    omitted ? '[Earlier shared context was omitted to fit the context budget.]' : '',
    ...retained,
  ].filter(Boolean).join('\n\n');

  return [
    `You are participating in a live group discussion titled "${room.title}" with: ${participantNames}.`,
    'Messages prefixed with a participant name were written by that participant. Engage with relevant points by name, and add your own view. Do not speak for other participants or prefix your response with your own name.',
    transcript ? `Shared discussion since your last turn:\n${transcript}` : '',
    `Latest message from the user:\n${latestUserContent}`,
  ].filter(Boolean).join('\n\n');
}
