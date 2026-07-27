import type { AppSessionStorage, AppTabManagerState } from '../providers/types';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  CollaborationDelivery,
  CollaborationDiscussionMode,
  CollaborationEvent,
  CollaborationParticipant,
  CollaborationRoom,
  CollaborationWorkQueue,
} from '../types';

export interface CollaborationRoomStorage {
  create(options: {
    id: string;
    title: string;
    participants: CollaborationParticipant[];
    now?: number;
  }): Promise<CollaborationRoom>;
  get(id: string): Promise<CollaborationRoom | null>;
  list(): Promise<CollaborationRoom[]>;
  delete(id: string): Promise<void>;
  archive(roomId: string, now?: number): Promise<CollaborationRoom>;
  reopen(roomId: string, now?: number): Promise<CollaborationRoom>;
  replaceParticipant(
    roomId: string,
    participantId: string,
    replacement: CollaborationParticipant,
    now?: number,
  ): Promise<CollaborationRoom>;
  updateDiscussionMode(
    roomId: string,
    mode: CollaborationDiscussionMode,
    now?: number,
  ): Promise<CollaborationRoom>;
  updateParticipantResourcePolicy(
    roomId: string,
    participantId: string,
    policy: CollaborationParticipant['resourcePolicy'],
    now?: number,
  ): Promise<CollaborationRoom>;
  updateParticipantCursor(
    roomId: string,
    participantId: string,
    eventId: string,
    now?: number,
  ): Promise<CollaborationRoom>;
  updateParticipantConversation(
    roomId: string,
    participantId: string,
    conversationId: string,
    now?: number,
  ): Promise<CollaborationRoom>;
  appendEvent(roomId: string, event: CollaborationEvent): Promise<CollaborationRoom>;
  updateDelivery(
    roomId: string,
    eventId: string,
    participantId: string,
    delivery: CollaborationDelivery,
  ): Promise<CollaborationRoom>;
  updateWorkQueue(
    roomId: string,
    workQueue: CollaborationWorkQueue,
    now?: number,
  ): Promise<CollaborationRoom>;
}

/**
 * Minimal shared app storage contract.
 *
 * This interface covers only the storage concerns that are shared across
 * all providers: Claudian settings, tab manager state, and session metadata.
 *
 * Provider-specific storage surfaces (CC settings, slash commands, skills,
 * agents, MCP config) live behind provider-owned modules.
 */
export interface SharedAppStorage {
  initialize(): Promise<{ claudian: Record<string, unknown> }>;
  saveClaudianSettings(settings: Record<string, unknown>): Promise<void>;
  setTabManagerState(state: AppTabManagerState): Promise<void>;
  getTabManagerState(): Promise<AppTabManagerState | null>;
  sessions: AppSessionStorage;
  rooms: CollaborationRoomStorage;
  getAdapter(): VaultFileAdapter;
}
