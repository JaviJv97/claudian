import type {
  CollaborationDelivery,
  CollaborationDiscussionMode,
  CollaborationEvent,
  CollaborationParticipant,
  CollaborationRoom,
  CollaborationRoutingSettings,
  CollaborationWorkQueue,
  ProviderId,
} from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

export const PORTABLE_COLLABORATION_ROOM_VERSION = 2;

export interface PortableCollaborationParticipant {
  id: string;
  providerId: ProviderId;
  label?: string;
  runtimeProfileId?: string;
  resourceMode?: Exclude<
    NonNullable<CollaborationParticipant['resourcePolicy']>['mode'],
    'unavailable'
  >;
}

export interface PortableCollaborationAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  width?: number;
  height?: number;
}

export interface PortableCollaborationEvent
  extends Omit<CollaborationEvent, 'attachments'> {
  attachments?: PortableCollaborationAttachment[];
}

export interface PortableCollaborationRoom {
  schemaVersion: 1 | 2;
  exportedAt: number;
  sourceRoomId: string;
  title: string;
  sourceStatus: 'active' | 'archived';
  discussionMode: CollaborationDiscussionMode;
  routing?: CollaborationRoutingSettings;
  createdAt: number;
  updatedAt: number;
  participants: PortableCollaborationParticipant[];
  events: PortableCollaborationEvent[];
  workQueue?: CollaborationWorkQueue;
  workQueueHistory?: CollaborationWorkQueue[];
  archiveSessionIds: string[];
  repositoryRefs: string[];
  machineLocalReferences: string[];
}

interface PortableRoomExportOptions {
  exportedAt?: number;
  archiveSessionIds?: string[];
  repositoryRefs?: string[];
}

const CREDENTIAL_FIELD_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|authorization)/i;
const POSIX_HOME_PATH_PATTERN = /\/(?:home|Users)\/[^/\s"'`]+\/[^\s"'`)\]}>,]+/g;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s"'`)\]}>,]+/g;

function sanitizeDelivery(delivery: CollaborationDelivery): CollaborationDelivery {
  const sanitized = structuredClone(delivery);
  delete sanitized.providerMessageId;
  return sanitized;
}

function sanitizeEvent(event: CollaborationEvent): PortableCollaborationEvent {
  return {
    ...structuredClone(event),
    delivery: Object.fromEntries(
      Object.entries(event.delivery).map(([participantId, delivery]) => [
        participantId,
        sanitizeDelivery(delivery),
      ]),
    ),
    attachments: event.attachments?.map(attachment => ({
      id: attachment.id,
      name: attachment.name,
      mediaType: attachment.mediaType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
    })),
  };
}

function findMachineLocalReferences(events: readonly PortableCollaborationEvent[]): string[] {
  const references = new Set<string>();
  for (const event of events) {
    for (const match of event.content.matchAll(POSIX_HOME_PATH_PATTERN)) references.add(match[0]);
    for (const match of event.content.matchAll(WINDOWS_PATH_PATTERN)) references.add(match[0]);
  }
  return [...references].sort();
}

function assertNoCredentialFields(value: unknown, path = 'package'): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_FIELD_PATTERN.test(key)) {
      throw new Error(`Portable room contains credential-like field at ${path}.${key}`);
    }
    assertNoCredentialFields(child, `${path}.${key}`);
  }
}

function isPortableRoom(value: unknown): value is PortableCollaborationRoom {
  if (!value || typeof value !== 'object') return false;
  const room = value as Partial<PortableCollaborationRoom>;
  const discussionModes: CollaborationDiscussionMode[] = [
    'parallel',
    'round-table',
    'deliberation',
    'mentioned-only',
  ];
  return (room.schemaVersion === 1 || room.schemaVersion === PORTABLE_COLLABORATION_ROOM_VERSION)
    && typeof room.sourceRoomId === 'string'
    && typeof room.title === 'string'
    && discussionModes.includes(room.discussionMode as CollaborationDiscussionMode)
    && Array.isArray(room.participants)
    && room.participants.length > 0
    && room.participants.every(participant => (
      typeof participant.id === 'string'
      && typeof participant.providerId === 'string'
      && !('conversationId' in participant)
      && (
        participant.resourceMode === undefined
        || ['active', 'preserve', 'muted'].includes(participant.resourceMode)
        || (
          room.schemaVersion === 1
          && (participant.resourceMode as string | undefined) === 'unavailable'
        )
      )
    ))
    && Array.isArray(room.events)
    && Array.isArray(room.archiveSessionIds)
    && Array.isArray(room.repositoryRefs)
    && Array.isArray(room.machineLocalReferences);
}

export function createPortableCollaborationRoom(
  room: CollaborationRoom,
  options: PortableRoomExportOptions = {},
): PortableCollaborationRoom {
  const events = room.events.map(sanitizeEvent);
  const portable: PortableCollaborationRoom = {
    schemaVersion: PORTABLE_COLLABORATION_ROOM_VERSION,
    exportedAt: options.exportedAt ?? Date.now(),
    sourceRoomId: room.id,
    title: room.title,
    sourceStatus: room.status ?? 'active',
    discussionMode: room.discussionMode ?? 'parallel',
    routing: room.routing ? structuredClone(room.routing) : undefined,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    participants: room.participants.map(participant => ({
      id: getCollaborationParticipantId(participant),
      providerId: participant.providerId,
      label: participant.label,
      runtimeProfileId: participant.runtimeProfileId,
      resourceMode: participant.resourcePolicy?.mode === 'unavailable'
        ? undefined
        : participant.resourcePolicy?.mode,
    })),
    events,
    workQueue: room.workQueue ? structuredClone(room.workQueue) : undefined,
    workQueueHistory: room.workQueueHistory
      ? structuredClone(room.workQueueHistory)
      : undefined,
    archiveSessionIds: [...(options.archiveSessionIds ?? [])],
    repositoryRefs: [...(options.repositoryRefs ?? [])],
    machineLocalReferences: findMachineLocalReferences(events),
  };
  assertNoCredentialFields(portable);
  return portable;
}

export function parsePortableCollaborationRoom(content: string): PortableCollaborationRoom {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Portable room is not valid JSON');
  }
  assertNoCredentialFields(parsed);
  if (!isPortableRoom(parsed)) {
    throw new Error('Portable room schema is invalid or unsupported');
  }
  const portable = structuredClone(parsed);
  for (const participant of portable.participants) {
    if ((participant.resourceMode as string | undefined) === 'unavailable') {
      participant.resourceMode = undefined;
    }
  }
  return portable;
}
