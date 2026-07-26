import type { Component } from 'obsidian';
import { MarkdownRenderer, setIcon } from 'obsidian';

import type { CollaborationEvent, CollaborationRoom, ProviderId } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';
import type { TabData } from '../tabs/types';
import { getLatestRetryableDeliveries } from './collaborationRecovery';

interface CollaborationTimelineOptions {
  component: Component;
  hostTab: TabData;
  participantTabs: TabData[];
  plugin: FeatureHost;
  roomId: string;
  canStop: (providerId: ProviderId) => boolean;
  onStop: (providerId: ProviderId) => void;
  onRetry: (providerId: ProviderId, content: string) => Promise<void>;
  onOpenFile: (path: string) => Promise<void>;
  onKeepCurrent: (eventId: string) => Promise<void>;
  onResolve: (
    eventId: string,
    providerId: ProviderId,
    content: string,
    conflictFiles: string[],
  ) => Promise<void>;
  onReview: (
    reviewerId: ProviderId,
    sourceProviderId: ProviderId,
    content: string,
  ) => Promise<void>;
}

function getProviderLabel(providerId: ProviderId): string {
  return providerId === 'claude'
    ? 'Claude'
    : providerId === 'codex'
      ? 'Codex'
      : providerId;
}

export class CollaborationTimeline {
  private readonly rootEl: HTMLElement;
  private readonly timelineEl: HTMLElement;
  private readonly recoveryEl: HTMLElement;
  private readonly statusEls = new Map<ProviderId, HTMLElement>();
  private readonly stopEls = new Map<ProviderId, HTMLButtonElement>();
  private readonly nativeMessagesWrapper: HTMLElement | null;
  private readonly cleanups: Array<() => void> = [];
  private renderGeneration = 0;

  constructor(private readonly options: CollaborationTimelineOptions) {
    this.nativeMessagesWrapper = options.hostTab.dom.messagesEl.parentElement;
    this.nativeMessagesWrapper?.addClass('claudian-hidden');
    this.rootEl = options.hostTab.dom.contentEl.createDiv({
      cls: 'claudian-collaboration',
      attr: {
        'aria-label': 'Claude and Codex collaboration room',
      },
    });
    options.hostTab.dom.contentEl.insertBefore(
      this.rootEl,
      this.nativeMessagesWrapper ?? options.hostTab.dom.contentEl.firstChild,
    );

    this.timelineEl = this.rootEl.createDiv({
      cls: 'claudian-collaboration-timeline',
      attr: {
        'aria-live': 'polite',
        'aria-relevant': 'additions text',
      },
    });
    const controlsEl = this.rootEl.createDiv({
      cls: 'claudian-collaboration-controls',
    });
    this.recoveryEl = controlsEl.createDiv({
      cls: 'claudian-collaboration-recovery claudian-hidden',
      attr: {
        'aria-live': 'polite',
        'aria-label': 'Response recovery actions',
      },
    });
    this.buildParticipantRail(controlsEl);

    for (const tab of options.participantTabs) {
      this.cleanups.push(tab.state.subscribe({
        onMessagesChanged: () => this.scheduleRender(),
        onStreamingStateChanged: () => this.scheduleRender(),
        onAttentionChanged: () => this.scheduleRender(),
      }));
    }
    const syncRecipientSelection = () => this.syncRecipientSelection();
    options.hostTab.dom.inputEl.addEventListener('input', syncRecipientSelection);
    this.cleanups.push(() => (
      options.hostTab.dom.inputEl.removeEventListener('input', syncRecipientSelection)
    ));
    this.scheduleRender();
  }

  refresh(): void {
    this.scheduleRender();
  }

  destroy(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.nativeMessagesWrapper?.removeClass('claudian-hidden');
    this.rootEl.remove();
  }

  private buildParticipantRail(containerEl: HTMLElement): void {
    const railEl = containerEl.createDiv({
      cls: 'claudian-collaboration-rail',
      attr: {
        'aria-label': 'Message recipients',
        title: 'Choose who receives the next message. You do not need to type an @ mention.',
      },
    });
    railEl.createSpan({
      cls: 'claudian-collaboration-rail-label',
      text: 'Send to',
    });
    const allButton = railEl.createEl('button', {
      cls: 'claudian-collaboration-recipient is-selected',
      text: 'All',
      attr: {
        type: 'button',
        'aria-pressed': 'true',
        'data-provider': 'all',
      },
    });
    allButton.addEventListener('click', () => this.selectRecipient('all', allButton));

    for (const tab of this.options.participantTabs) {
      const button = railEl.createEl('button', {
        cls: 'claudian-collaboration-recipient',
        text: getProviderLabel(tab.providerId),
        attr: {
          type: 'button',
          'aria-pressed': 'false',
          'data-provider': tab.providerId,
        },
      });
      const statusEl = button.createSpan({
        cls: 'claudian-collaboration-status',
        attr: { 'aria-hidden': 'true' },
      });
      this.statusEls.set(tab.providerId, statusEl);
      button.addEventListener('click', () => this.selectRecipient(tab.providerId, button));

      const stopButton = railEl.createEl('button', {
        cls: 'claudian-collaboration-stop',
        attr: {
          type: 'button',
          'aria-label': `Stop ${getProviderLabel(tab.providerId)}`,
          'data-provider': tab.providerId,
        },
      });
      setIcon(stopButton, 'square');
      stopButton.addEventListener('click', () => this.options.onStop(tab.providerId));
      this.stopEls.set(tab.providerId, stopButton);
    }
  }

  private selectRecipient(recipientId: 'all' | ProviderId, selectedButton: HTMLElement): void {
    for (const button of this.rootEl.querySelectorAll<HTMLElement>('.claudian-collaboration-recipient')) {
      const selected = button === selectedButton;
      button.toggleClass('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }

    const inputEl = this.options.hostTab.dom.inputEl;
    const withoutMention = inputEl.value.replace(/^@(all|claude|codex)\s+/i, '');
    inputEl.value = recipientId === 'all' ? withoutMention : `@${recipientId} ${withoutMention}`;
    const EventConstructor = inputEl.ownerDocument.defaultView?.Event ?? Event;
    inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    inputEl.focus();
  }

  private scheduleRender(): void {
    const generation = ++this.renderGeneration;
    void this.render(generation);
  }

  private async render(generation: number): Promise<void> {
    this.syncRecipientSelection();
    this.updateParticipantStatuses();
    const room = await this.options.plugin.storage.rooms.get(this.options.roomId);
    if (!room || generation !== this.renderGeneration) return;

    const liveEvents = this.getLiveAssistantEvents(room);
    const events = [...room.events, ...liveEvents]
      .sort((left, right) => left.createdAt - right.createdAt);
    this.timelineEl.empty();

    if (events.length === 0) {
      this.timelineEl.createDiv({
        cls: 'claudian-collaboration-empty',
        text: 'Send a message to begin the room.',
      });
      this.renderRecovery(room);
      return;
    }

    for (const event of events) {
      const messageEl = this.timelineEl.createDiv({
        cls: [
          'claudian-collaboration-message',
          `claudian-collaboration-message--${event.authorId === 'user' ? 'user' : 'agent'}`,
        ].join(' '),
        attr: {
          'data-author': event.authorId,
          'data-event-id': event.id,
        },
      });
      messageEl.createDiv({
        cls: 'claudian-collaboration-author',
        text: event.authorId === 'user' ? 'You' : getProviderLabel(event.authorId),
      });
      const contentEl = messageEl.createDiv({
        cls: 'claudian-collaboration-content',
        attr: { dir: 'auto' },
      });
      for (const attachment of event.attachments ?? []) {
        contentEl.createEl('img', {
          cls: 'claudian-collaboration-image',
          attr: {
            src: `data:${attachment.mediaType};base64,${attachment.data}`,
            alt: attachment.name,
          },
        });
      }
      await MarkdownRenderer.render(
        this.options.plugin.app,
        event.content,
        contentEl,
        '',
        this.options.component,
      );
      if (event.authorId === 'user' && Object.keys(event.delivery).length > 0) {
        const deliveryEl = messageEl.createDiv({
          cls: 'claudian-collaboration-delivery',
          attr: { 'aria-label': 'Delivery status' },
        });
        for (const [providerId, delivery] of Object.entries(event.delivery)) {
          const itemEl = deliveryEl.createDiv({
            cls: 'claudian-collaboration-delivery-item',
            attr: {
              'data-status': delivery.status,
            },
          });
          itemEl.createSpan({
            text: `${getProviderLabel(providerId)}: ${delivery.status}`,
          });
        }
      }
      if (event.authorId !== 'user' && event.authorId !== 'system') {
        const reviewer = this.options.participantTabs.find(tab => (
          tab.providerId !== event.authorId
        ))?.providerId;
        if (reviewer) {
          const reviewButton = messageEl.createEl('button', {
            cls: 'claudian-collaboration-review',
            text: `Ask ${getProviderLabel(reviewer)} to review`,
            attr: { type: 'button' },
          });
          reviewButton.addEventListener('click', () => {
            void this.options.onReview(reviewer, event.authorId, event.content);
          });
        }
      }
      if (generation !== this.renderGeneration) return;
    }
    this.renderRecovery(room);
    this.timelineEl.scrollTop = this.timelineEl.scrollHeight;
  }

  private renderRecovery(room: CollaborationRoom): void {
    const retryable = getLatestRetryableDeliveries(room);
    this.recoveryEl.empty();
    this.recoveryEl.toggleClass('claudian-hidden', retryable.length === 0);
    if (retryable.length === 0) return;

    const conflictFiles = [...new Set(
      retryable.flatMap(delivery => delivery.conflictFiles ?? []),
    )];
    this.recoveryEl.createSpan({
      cls: 'claudian-collaboration-recovery-label',
      text: conflictFiles.length > 0
        ? `Review ${conflictFiles.join(', ')} before retrying.`
        : retryable.length === 1
          ? `${getProviderLabel(retryable[0].providerId)} ${
            retryable[0].status === 'cancelled' ? 'was stopped' : 'failed'
          }.`
          : 'Some responses need attention.',
    });
    const actionsEl = this.recoveryEl.createDiv({
      cls: 'claudian-collaboration-recovery-actions',
    });
    if (conflictFiles.length > 0) {
      const openButton = actionsEl.createEl('button', {
        cls: 'claudian-collaboration-retry',
        text: 'Open note',
        attr: {
          type: 'button',
          'aria-label': `Open ${conflictFiles[0]}`,
        },
      });
      openButton.addEventListener('click', () => {
        void this.options.onOpenFile(conflictFiles[0]);
      });

      const keepButton = actionsEl.createEl('button', {
        cls: 'claudian-collaboration-retry',
        text: 'Keep current',
        attr: {
          type: 'button',
          'aria-label': `Keep the current version of ${conflictFiles.join(', ')}`,
        },
      });
      keepButton.addEventListener('click', () => {
        keepButton.disabled = true;
        void this.options.onKeepCurrent(retryable[0].eventId).catch(() => {
          keepButton.disabled = false;
        });
      });
    }
    for (const delivery of retryable) {
      const retryButton = actionsEl.createEl('button', {
        cls: 'claudian-collaboration-retry',
        text: delivery.status === 'conflict'
          ? `Apply ${getProviderLabel(delivery.providerId)}`
          : `Retry ${getProviderLabel(delivery.providerId)}`,
        attr: {
          type: 'button',
          'aria-label': delivery.status === 'conflict'
            ? `Apply ${getProviderLabel(delivery.providerId)} proposal to the current file`
            : `Retry with ${getProviderLabel(delivery.providerId)}`,
        },
      });
      retryButton.addEventListener('click', () => {
        retryButton.disabled = true;
        const action = delivery.status === 'conflict'
          ? this.options.onResolve(
            delivery.eventId,
            delivery.providerId,
            delivery.content,
            delivery.conflictFiles ?? conflictFiles,
          )
          : this.options.onRetry(delivery.providerId, delivery.content);
        void action.catch(() => {
          retryButton.disabled = false;
        });
      });
    }
  }

  private syncRecipientSelection(): void {
    const input = this.options.hostTab.dom.inputEl.value.trimStart();
    const participant = this.options.participantTabs.find(tab => (
      input.toLowerCase().startsWith(`@${tab.providerId.toLowerCase()} `)
    ));
    const selectedProvider = participant?.providerId ?? 'all';

    for (const button of this.rootEl.querySelectorAll<HTMLElement>(
      '.claudian-collaboration-recipient',
    )) {
      const selected = button.dataset.provider === selectedProvider;
      button.toggleClass('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  private getLiveAssistantEvents(room: CollaborationRoom): CollaborationEvent[] {
    const persistedSourceIds = new Set(
      room.events.map(event => event.sourceMessageId).filter(Boolean),
    );
    return this.options.participantTabs.flatMap((tab) => {
      if (!tab.state.isStreaming) return [];
      const message = [...tab.state.messages].reverse().find(candidate => (
        candidate.role === 'assistant' && !persistedSourceIds.has(candidate.id)
      ));
      if (!message?.content) return [];
      return [{
        id: `live-${tab.id}-${message.id}`,
        kind: 'message' as const,
        authorId: tab.providerId,
        recipientIds: ['user' as const],
        content: message.content,
        createdAt: message.timestamp,
        delivery: {},
        sourceMessageId: message.id,
      }];
    });
  }

  private updateParticipantStatuses(): void {
    for (const tab of this.options.participantTabs) {
      const statusEl = this.statusEls.get(tab.providerId);
      if (!statusEl) continue;
      const status = tab.state.needsAttention
        ? 'attention'
        : tab.state.isStreaming
          ? 'streaming'
          : 'idle';
      statusEl.dataset.status = status;
      statusEl.setAttribute('title', `${getProviderLabel(tab.providerId)}: ${status}`);
      const recipientButton = statusEl.parentElement;
      recipientButton?.setAttribute(
        'aria-label',
        `${getProviderLabel(tab.providerId)}, ${status}`,
      );
      const stopButton = this.stopEls.get(tab.providerId);
      const canStop = this.options.canStop(tab.providerId);
      stopButton?.toggleClass('claudian-hidden', !canStop);
      stopButton?.setAttribute('aria-hidden', canStop ? 'false' : 'true');
      if (stopButton) stopButton.disabled = !canStop;
    }
  }
}
