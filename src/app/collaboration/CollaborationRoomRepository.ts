import { getCollaborationParticipantId } from '../../core/collaboration/collaborationRoom';
import type { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import type {
  CollaborationDelivery,
  CollaborationDiscussionMode,
  CollaborationEvent,
  CollaborationParticipant,
  CollaborationRoom,
  CollaborationWorkQueue,
} from '../../core/types';

const ROOMS_PATH = '.claudian/rooms';
const SAFE_ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_WORK_QUEUE_HISTORY = 20;

export interface CreateCollaborationRoomOptions {
  id: string;
  title: string;
  participants: CollaborationParticipant[];
  now?: number;
}

function assertRoomId(id: string): void {
  if (
    !SAFE_ROOM_ID_PATTERN.test(id)
    || id === '.'
    || id === '..'
    || /%(?:2f|5c)/i.test(id)
  ) {
    throw new Error(`Invalid collaboration room id: ${JSON.stringify(id)}`);
  }
}

export class CollaborationRoomRepository {
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly adapter: VaultFileAdapter) {}

  async create(options: CreateCollaborationRoomOptions): Promise<CollaborationRoom> {
    assertRoomId(options.id);
    const now = options.now ?? Date.now();
    const room: CollaborationRoom = {
      version: 1,
      id: options.id,
      title: options.title,
      status: 'active',
      discussionMode: 'round-table',
      participantLastSeenEventIds: {},
      createdAt: now,
      updatedAt: now,
      participants: options.participants.map(participant => ({ ...participant })),
      events: [],
    };
    await this.write(room);
    return room;
  }

  async restore(room: CollaborationRoom): Promise<CollaborationRoom> {
    assertRoomId(room.id);
    if (await this.get(room.id)) {
      throw new Error(`Collaboration room already exists: ${room.id}`);
    }
    const participantIds = room.participants.map(getCollaborationParticipantId);
    if (new Set(participantIds).size !== participantIds.length) {
      throw new Error('Collaboration room contains duplicate participants');
    }
    const restored: CollaborationRoom = {
      ...structuredClone(room),
      version: 1,
      status: 'active',
      archivedAt: undefined,
      participantLastSeenEventIds: {},
    };
    await this.write(restored);
    return restored;
  }

  async get(id: string): Promise<CollaborationRoom | null> {
    assertRoomId(id);
    const path = this.getPath(id);
    if (!(await this.adapter.exists(path))) return null;
    try {
      const parsed = JSON.parse(await this.adapter.read(path)) as CollaborationRoom;
      return parsed.version === 1 && parsed.id === id ? parsed : null;
    } catch {
      return null;
    }
  }

  async list(): Promise<CollaborationRoom[]> {
    const paths = await this.adapter.listFiles(ROOMS_PATH);
    const rooms = await Promise.all(paths
      .filter(candidate => candidate.endsWith('.json'))
      .map(async (candidate) => {
        try {
          const parsed = JSON.parse(await this.adapter.read(candidate)) as CollaborationRoom;
          return parsed.version === 1 && SAFE_ROOM_ID_PATTERN.test(parsed.id) ? parsed : null;
        } catch {
          return null;
        }
      }));
    return rooms
      .filter((room): room is CollaborationRoom => room !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async delete(id: string): Promise<void> {
    assertRoomId(id);
    await this.adapter.delete(this.getPath(id));
  }

  async appendEvent(roomId: string, event: CollaborationEvent): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      if (room.events.some(existing => existing.id === event.id)) return room;
      room.events.push(structuredClone(event));
      room.updatedAt = Math.max(room.updatedAt, event.createdAt);
      return room;
    });
  }

  async updateParticipantConversation(
    roomId: string,
    participantId: string,
    conversationId: string,
    now = Date.now(),
  ): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      const participant = room.participants.find(candidate => (
        getCollaborationParticipantId(candidate) === participantId
      ));
      if (!participant) {
        throw new Error(`Collaboration participant not found: ${participantId}`);
      }
      participant.conversationId = conversationId;
      room.updatedAt = Math.max(room.updatedAt, now);
      return room;
    });
  }

  async archive(roomId: string, now = Date.now()): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      room.status = 'archived';
      room.archivedAt = now;
      room.updatedAt = Math.max(room.updatedAt, now);
      return room;
    });
  }

  async reopen(roomId: string, now = Date.now()): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      room.status = 'active';
      delete room.archivedAt;
      room.updatedAt = Math.max(room.updatedAt, now);
      return room;
    });
  }

  async replaceParticipant(
    roomId: string,
    participantId: string,
    replacement: CollaborationParticipant,
    now = Date.now(),
  ): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      const index = room.participants.findIndex(candidate => (
        getCollaborationParticipantId(candidate) === participantId
      ));
      if (index < 0) {
        throw new Error(`Collaboration participant not found: ${participantId}`);
      }
      const replacementId = getCollaborationParticipantId(replacement);
      if (room.participants.some((candidate, candidateIndex) => (
        candidateIndex !== index
        && getCollaborationParticipantId(candidate) === replacementId
      ))) {
        throw new Error(`Collaboration participant already exists: ${replacementId}`);
      }
      room.participants[index] = { ...replacement };
      room.updatedAt = Math.max(room.updatedAt, now);
      return room;
    });
  }

  async updateDiscussionMode(
    roomId: string,
    mode: CollaborationDiscussionMode,
    now = Date.now(),
  ): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      room.discussionMode = mode;
      room.updatedAt = Math.max(room.updatedAt, now);
      return room;
    });
  }

  async updateParticipantResourcePolicy(
    roomId: string,
    participantId: string,
    policy: CollaborationParticipant['resourcePolicy'],
    now = Date.now(),
  ): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      const participant = room.participants.find(candidate => (
        getCollaborationParticipantId(candidate) === participantId
      ));
      if (!participant) {
        throw new Error(`Collaboration participant not found: ${participantId}`);
      }
      participant.resourcePolicy = policy ? { ...policy } : undefined;
      room.updatedAt = Math.max(room.updatedAt, now);
      return room;
    });
  }

  async updateParticipantCursor(
    roomId: string,
    participantId: string,
    eventId: string,
    now = Date.now(),
  ): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      if (!room.participants.some(participant => (
        getCollaborationParticipantId(participant) === participantId
      ))) {
        throw new Error(`Collaboration participant not found: ${participantId}`);
      }
      room.participantLastSeenEventIds ??= {};
      room.participantLastSeenEventIds[participantId] = eventId;
      room.updatedAt = Math.max(room.updatedAt, now);
      return room;
    });
  }

  async updateDelivery(
    roomId: string,
    eventId: string,
    participantId: string,
    delivery: CollaborationDelivery,
  ): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      const event = room.events.find(candidate => candidate.id === eventId);
      if (!event) throw new Error(`Collaboration event not found: ${eventId}`);
      event.delivery[participantId] = { ...delivery };
      room.updatedAt = Math.max(
        room.updatedAt,
        delivery.completedAt ?? delivery.startedAt ?? Date.now(),
      );
      return room;
    });
  }

  async updateWorkQueue(
    roomId: string,
    workQueue: CollaborationWorkQueue,
    expectedQueueUpdatedAt?: number,
    now = Date.now(),
  ): Promise<CollaborationRoom> {
    return this.mutate(roomId, (room) => {
      if (
        expectedQueueUpdatedAt === undefined
        && room.workQueue
        && room.workQueue.sourceDeliberationId !== workQueue.sourceDeliberationId
      ) {
        if (!room.workQueue.completionApprovedAt) {
          throw new Error('Approve or finish the current work queue before creating another.');
        }
        room.workQueueHistory ??= [];
        room.workQueueHistory.push(structuredClone(room.workQueue));
        room.workQueueHistory = room.workQueueHistory.slice(-MAX_WORK_QUEUE_HISTORY);
      }
      if (
        expectedQueueUpdatedAt !== undefined
        && room.workQueue?.updatedAt !== expectedQueueUpdatedAt
      ) {
        throw new Error('The work queue changed in another tab. Refresh and try again.');
      }
      room.workQueue = structuredClone(workQueue);
      room.updatedAt = Math.max(room.updatedAt, now, workQueue.updatedAt);
      return room;
    });
  }

  private async mutate(
    roomId: string,
    mutation: (room: CollaborationRoom) => CollaborationRoom,
  ): Promise<CollaborationRoom> {
    assertRoomId(roomId);
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const room = await this.get(roomId);
      if (!room) throw new Error(`Collaboration room not found: ${roomId}`);
      const updated = mutation(room);
      await this.write(updated);
      return updated;
    });
    this.queues.set(roomId, operation);
    try {
      return await operation;
    } finally {
      if (this.queues.get(roomId) === operation) this.queues.delete(roomId);
    }
  }

  private getPath(id: string): string {
    return `${ROOMS_PATH}/${id}.json`;
  }

  private write(room: CollaborationRoom): Promise<void> {
    return this.adapter.write(this.getPath(room.id), JSON.stringify(room, null, 2));
  }
}
