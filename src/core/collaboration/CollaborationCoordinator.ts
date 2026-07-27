import type { CollaborationRoomStorage } from '../bootstrap/storage';
import type {
  CollaborationAttachment,
  CollaborationDelivery,
  CollaborationEvent,
  CollaborationFileProposal,
  CollaborationParticipant,
  CollaborationRoom,
} from '../types';
import { getCollaborationParticipantId } from './collaborationRoom';

export interface CollaborationDispatchRequest {
  eventId: string;
  roomId: string;
  content: string;
}

export interface CollaborationDispatchResult {
  providerMessageId?: string;
  conflictFiles?: string[];
  fileProposals?: CollaborationFileProposal[];
}

export type CollaborationDispatch = (
  participant: CollaborationParticipant,
  request: CollaborationDispatchRequest,
  signal: AbortSignal,
) => Promise<CollaborationDispatchResult>;

export interface SendCollaborationTurnOptions {
  content: string;
  recipientIds: string[];
  recipientContent?: Partial<Record<string, string>>;
  attachments?: CollaborationAttachment[];
  strategy?: 'parallel' | 'sequential';
  prepareContent?: (
    participant: CollaborationParticipant,
    event: CollaborationEvent,
  ) => Promise<string> | string;
  eventMetadata?: Pick<CollaborationEvent, 'deliberationId' | 'deliberationPhase'>;
  eventAuthorId?: CollaborationEvent['authorId'];
  eventKind?: CollaborationEvent['kind'];
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
    participantId: string,
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
      options.recipientIds.includes(getCollaborationParticipantId(participant))
    ));
    const event: CollaborationEvent = {
      id: this.generateId(),
      kind: options.eventKind ?? 'message',
      authorId: options.eventAuthorId ?? 'user',
      recipientIds: recipients.map(getCollaborationParticipantId),
      content: options.content,
      recipientContent: options.recipientContent
        ? { ...options.recipientContent }
        : undefined,
      createdAt: this.now(),
      delivery: Object.fromEntries(
        recipients.map(participant => [
          getCollaborationParticipantId(participant),
          { status: 'pending' },
        ]),
      ),
      attachments: options.attachments?.map(attachment => ({ ...attachment })),
      ...options.eventMetadata,
    };
    await this.storage.appendEvent(room.id, structuredClone(event));

    const deliveries = recipients.map((participant) => {
      const participantId = getCollaborationParticipantId(participant);
      const key = this.getDeliveryKey(room.id, event.id, participantId);
      const abortController = new AbortController();
      this.abortControllers.set(key, abortController);
      return { abortController, key, participant, participantId };
    });
    const isSequential = options.strategy === 'sequential';
    if (!isSequential) {
      await Promise.all(deliveries.map(delivery => this.setDelivery(
        room.id,
        event,
        delivery.participantId,
        { status: 'streaming', startedAt: this.now() },
      )));
    }
    const dispatchDelivery = (delivery: typeof deliveries[number]) => this.dispatch(
        room,
        event,
        delivery.participant,
        delivery.participantId,
        options.dispatch,
        options.prepareContent,
        delivery.abortController,
        delivery.key,
        isSequential,
      );
    const completion = isSequential
      ? deliveries.reduce<Promise<void>>(
        (previous, delivery) => previous.then(() => dispatchDelivery(delivery)),
        Promise.resolve(),
      )
      : Promise.allSettled(deliveries.map(dispatchDelivery)).then(() => undefined);
    return { event, completion };
  }

  cancel(roomId: string, eventId: string, participantId: string): boolean {
    const abortController = this.abortControllers.get(
      this.getDeliveryKey(roomId, eventId, participantId),
    );
    if (!abortController) return false;
    abortController.abort();
    return true;
  }

  private async dispatch(
    room: CollaborationRoom,
    event: CollaborationEvent,
    participant: CollaborationParticipant,
    participantId: string,
    dispatch: CollaborationDispatch,
    prepareContent: SendCollaborationTurnOptions['prepareContent'],
    abortController: AbortController,
    key: string,
    markStreaming: boolean,
  ): Promise<void> {
    try {
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (markStreaming) {
        await this.setDelivery(room.id, event, participantId, {
          status: 'streaming',
          startedAt: this.now(),
        });
      }
      const content = prepareContent
        ? await prepareContent(participant, event)
        : event.recipientContent?.[participantId] ?? event.content;
      const result = await dispatch(participant, {
        eventId: event.id,
        roomId: room.id,
        content,
      }, abortController.signal);
      await this.setDelivery(room.id, event, participantId, {
        status: result.conflictFiles?.length ? 'conflict' : 'completed',
        startedAt: event.delivery[participantId]?.startedAt,
        completedAt: this.now(),
        providerMessageId: result.providerMessageId,
        conflictFiles: result.conflictFiles,
        fileProposals: result.fileProposals?.map(proposal => ({ ...proposal })),
      });
    } catch (error) {
      const startedAt = event.delivery[participantId]?.startedAt;
      await this.setDelivery(room.id, event, participantId, isAbortError(error)
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
    participantId: string,
    delivery: CollaborationDelivery,
  ): Promise<void> {
    event.delivery[participantId] = delivery;
    await this.storage.updateDelivery(roomId, event.id, participantId, delivery);
    this.onDeliveryChanged?.(event, participantId, delivery);
  }

  private getDeliveryKey(roomId: string, eventId: string, participantId: string): string {
    return `${roomId}:${eventId}:${participantId}`;
  }
}
