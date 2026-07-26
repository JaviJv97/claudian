import type { CollaborationRoomStorage } from '../bootstrap/storage';
import type {
  CollaborationAttachment,
  CollaborationDelivery,
  CollaborationEvent,
  CollaborationParticipant,
  CollaborationRoom,
  ProviderId,
} from '../types';

export interface CollaborationDispatchRequest {
  eventId: string;
  roomId: string;
  content: string;
}

export interface CollaborationDispatchResult {
  providerMessageId?: string;
  conflictFiles?: string[];
}

export type CollaborationDispatch = (
  participant: CollaborationParticipant,
  request: CollaborationDispatchRequest,
  signal: AbortSignal,
) => Promise<CollaborationDispatchResult>;

export interface SendCollaborationTurnOptions {
  content: string;
  recipientIds: ProviderId[];
  recipientContent?: Partial<Record<ProviderId, string>>;
  attachments?: CollaborationAttachment[];
  dispatch: CollaborationDispatch;
}

export interface CollaborationTurn {
  event: CollaborationEvent;
  completion: Promise<void>;
}

export interface CollaborationCoordinatorOptions {
  storage: Pick<CollaborationRoomStorage, 'appendEvent' | 'updateDelivery'>;
  generateId?: () => string;
  now?: () => number;
  onDeliveryChanged?: (
    event: CollaborationEvent,
    providerId: ProviderId,
    delivery: CollaborationDelivery,
  ) => void;
}

function defaultId(): string {
  return `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

export class CollaborationCoordinator {
  private readonly storage: CollaborationCoordinatorOptions['storage'];
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly onDeliveryChanged?: CollaborationCoordinatorOptions['onDeliveryChanged'];
  private abortControllers = new Map<string, AbortController>();

  constructor(options: CollaborationCoordinatorOptions) {
    this.storage = options.storage;
    this.generateId = options.generateId ?? defaultId;
    this.now = options.now ?? Date.now;
    this.onDeliveryChanged = options.onDeliveryChanged;
  }

  async send(
    room: CollaborationRoom,
    options: SendCollaborationTurnOptions,
  ): Promise<CollaborationTurn> {
    const recipients = room.participants.filter(participant => (
      options.recipientIds.includes(participant.providerId)
    ));
    const event: CollaborationEvent = {
      id: this.generateId(),
      kind: 'message',
      authorId: 'user',
      recipientIds: recipients.map(participant => participant.providerId),
      content: options.content,
      recipientContent: options.recipientContent
        ? { ...options.recipientContent }
        : undefined,
      createdAt: this.now(),
      delivery: Object.fromEntries(
        recipients.map(participant => [participant.providerId, { status: 'pending' }]),
      ),
      attachments: options.attachments?.map(attachment => ({ ...attachment })),
    };
    await this.storage.appendEvent(room.id, structuredClone(event));

    const deliveries = await Promise.all(recipients.map(async (participant) => {
      const key = this.getDeliveryKey(room.id, event.id, participant.providerId);
      const abortController = new AbortController();
      this.abortControllers.set(key, abortController);
      await this.setDelivery(room.id, event, participant.providerId, {
        status: 'streaming',
        startedAt: this.now(),
      });
      return { abortController, key, participant };
    }));
    const completion = Promise.allSettled(
      deliveries.map(delivery => this.dispatch(
        room,
        event,
        delivery.participant,
        options.dispatch,
        delivery.abortController,
        delivery.key,
      )),
    ).then(() => undefined);
    return { event, completion };
  }

  cancel(roomId: string, eventId: string, providerId: ProviderId): boolean {
    const abortController = this.abortControllers.get(
      this.getDeliveryKey(roomId, eventId, providerId),
    );
    if (!abortController) return false;
    abortController.abort();
    return true;
  }

  private async dispatch(
    room: CollaborationRoom,
    event: CollaborationEvent,
    participant: CollaborationParticipant,
    dispatch: CollaborationDispatch,
    abortController: AbortController,
    key: string,
  ): Promise<void> {
    try {
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const result = await dispatch(participant, {
        eventId: event.id,
        roomId: room.id,
        content: event.recipientContent?.[participant.providerId] ?? event.content,
      }, abortController.signal);
      await this.setDelivery(room.id, event, participant.providerId, {
        status: result.conflictFiles?.length ? 'conflict' : 'completed',
        startedAt: event.delivery[participant.providerId]?.startedAt,
        completedAt: this.now(),
        providerMessageId: result.providerMessageId,
        conflictFiles: result.conflictFiles,
      });
    } catch (error) {
      const startedAt = event.delivery[participant.providerId]?.startedAt;
      await this.setDelivery(room.id, event, participant.providerId, isAbortError(error)
        ? {
          status: 'cancelled',
          startedAt,
          completedAt: this.now(),
        }
        : {
          status: 'failed',
          startedAt,
          completedAt: this.now(),
          error: toErrorMessage(error),
        });
    } finally {
      if (this.abortControllers.get(key) === abortController) {
        this.abortControllers.delete(key);
      }
    }
  }

  private async setDelivery(
    roomId: string,
    event: CollaborationEvent,
    providerId: ProviderId,
    delivery: CollaborationDelivery,
  ): Promise<void> {
    event.delivery[providerId] = delivery;
    await this.storage.updateDelivery(roomId, event.id, providerId, delivery);
    this.onDeliveryChanged?.(event, providerId, delivery);
  }

  private getDeliveryKey(roomId: string, eventId: string, providerId: ProviderId): string {
    return `${roomId}:${eventId}:${providerId}`;
  }
}
