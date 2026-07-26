import { getCollaborationParticipantId } from '../../core/collaboration/collaborationRoom';
import type { VaultFileAdapter } from '../../core/storage/VaultFileAdapter';
import type {
  CollaborationDelivery,
  CollaborationEvent,
  CollaborationParticipant,
  CollaborationRoom,
} from '../../core/types';

const ROOMS_PATH = '.claudian/rooms';
const SAFE_ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
      createdAt: now,
      updatedAt: now,
      participants: options.participants.map(participant => ({ ...participant })),
      events: [],
    };
    await this.write(room);
    return room;
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
