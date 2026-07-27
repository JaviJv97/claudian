import type { Component } from 'obsidian';
import { MarkdownRenderer, setIcon } from 'obsidian';

import {
  getQuotaRoutingRecommendation,
  isQuotaSnapshotStale,
} from '../../../core/collaboration/collaborationResourcePolicy';
import type {
  CollaborationDiscussionMode,
  CollaborationEvent,
  CollaborationParticipantResourcePolicy,
  CollaborationResourceUsageSnapshot,
  CollaborationRoom,
  ProviderId,
} from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';
import { renderDiffContent, renderDiffStats } from '../rendering/DiffRenderer';
import type { TabData } from '../tabs/types';
import { createCollaborationProposalReview } from './collaborationProposalReview';
import { getLatestRetryableDeliveries } from './collaborationRecovery';

interface CollaborationTimelineOptions {
  component: Component;
  hostTab: TabData;
  participantTabs: TabData[];
  participantLabels: Record<string, string>;
  participantResourcePolicies: Record<string, CollaborationParticipantResourcePolicy | undefined>;
  participantUsageSnapshots: Record<string, CollaborationResourceUsageSnapshot | undefined>;
  plugin: FeatureHost;
  roomId: string;
  discussionMode: CollaborationDiscussionMode;
  onDiscussionModeChange: (mode: CollaborationDiscussionMode) => Promise<void>;
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
  onApplyProposal: (
    eventId: string,
    providerId: ProviderId,
    selectedHunks: Record<string, string[]>,
  ) => Promise<void>;
  onStartApprovedPlan: (deliberationId: string) => Promise<void>;
  onRetryApprovedPlan: (deliberationId: string) => Promise<void>;
  onApproveWorkflow: (workflowId: string, deliberationId: string) => Promise<void>;
  onRequestWorkflowChanges: (workflowId: string, deliberationId: string) => Promise<void>;
  onEditResourcePolicy: (participantId: ProviderId) => void;
  onApplyQuotaRecommendation: (participantId: ProviderId) => Promise<void>;
  onOpenUsageDashboard: () => void;
  onReview: (
    reviewerId: ProviderId,
    sourceProviderId: ProviderId,
    content: string,
  ) => Promise<void>;
}

function getFallbackParticipantLabel(participantId: string): string {
  return participantId === 'claude'
    ? 'Claude'
    : participantId === 'codex'
      ? 'Codex'
      : participantId;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const expandedTimelineRoomIds = new Set<string>();

export class CollaborationTimeline {
  private readonly rootEl: HTMLElement;
  private readonly timelineEl: HTMLElement;
  private readonly recoveryEl: HTMLElement;
  private readonly statusEls = new Map<ProviderId, HTMLElement>();
  private readonly stopEls = new Map<ProviderId, HTMLButtonElement>();
  private readonly resourceEls = new Map<ProviderId, HTMLButtonElement>();
  private readonly nativeMessagesWrapper: HTMLElement | null;
  private readonly cleanups: Array<() => void> = [];
  private discussionMode: CollaborationDiscussionMode;
  private renderGeneration = 0;

  constructor(private readonly options: CollaborationTimelineOptions) {
    this.discussionMode = options.discussionMode;
    this.nativeMessagesWrapper = options.hostTab.dom.messagesEl.parentElement;
    this.nativeMessagesWrapper?.addClass('claudian-hidden');
    this.rootEl = options.hostTab.dom.contentEl.createDiv({
      cls: 'claudian-collaboration',
      attr: {
        'aria-label': 'Claude personal, Claude company, and Codex collaboration room',
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
    const participantIds = Object.keys(this.options.participantLabels);
    const rosterEl = containerEl.createDiv({
      cls: 'claudian-collaboration-roster',
      attr: { 'aria-label': 'Agents in this collaboration room' },
    });
    rosterEl.createSpan({
      cls: 'claudian-collaboration-roster-label',
      text: 'In this room',
    });
    rosterEl.createSpan({
      cls: 'claudian-collaboration-roster-members',
      text: participantIds.map(id => this.getParticipantLabel(id)).join(' · '),
    });
    const usageButton = rosterEl.createEl('button', {
      cls: 'claudian-collaboration-usage-overview',
      text: 'Usage overview',
      attr: {
        type: 'button',
        'aria-label': 'Open collaboration usage overview',
      },
    });
    usageButton.addEventListener('click', () => this.options.onOpenUsageDashboard());
    const modeEl = rosterEl.createDiv({
      cls: 'claudian-collaboration-modes',
      attr: { role: 'group', 'aria-label': 'Discussion mode' },
    });
    const modes: Array<{
      id: CollaborationDiscussionMode;
      label: string;
      title: string;
    }> = [
      {
        id: 'round-table',
        label: 'Round table',
        title: 'Agents respond one at a time and see earlier responses in this round.',
      },
      {
        id: 'parallel',
        label: 'Parallel',
        title: 'Agents respond together and see one another’s responses next turn.',
      },
      {
        id: 'deliberation',
        label: 'Deliberation',
        title: 'Independent positions, cross-critique, synthesis, and explicit ratification.',
      },
      {
        id: 'mentioned-only',
        label: 'Mentions',
        title: 'Only agents you explicitly select or mention respond.',
      },
    ];
    for (const mode of modes) {
      const button = modeEl.createEl('button', {
        cls: [
          'claudian-collaboration-mode',
          mode.id === this.discussionMode ? 'is-selected' : '',
        ].filter(Boolean).join(' '),
        text: mode.label,
        attr: {
          type: 'button',
          title: mode.title,
          'aria-pressed': mode.id === this.discussionMode ? 'true' : 'false',
          'data-mode': mode.id,
        },
      });
      button.addEventListener('click', () => {
        if (mode.id === this.discussionMode) return;
        button.disabled = true;
        void this.options.onDiscussionModeChange(mode.id)
          .then(() => {
            this.discussionMode = mode.id;
            for (const candidate of modeEl.querySelectorAll<HTMLElement>(
              '.claudian-collaboration-mode',
            )) {
              const selected = candidate.dataset.mode === mode.id;
              candidate.toggleClass('is-selected', selected);
              candidate.setAttribute('aria-pressed', selected ? 'true' : 'false');
            }
          })
          .finally(() => { button.disabled = false; });
      });
    }

    const recommendations = participantIds.flatMap((participantId) => {
      const recommendation = getQuotaRoutingRecommendation(
        this.options.participantResourcePolicies[participantId],
      );
      return recommendation ? [{ participantId, recommendation }] : [];
    });
    if (recommendations.length > 0) {
      const recommendationEl = containerEl.createDiv({
        cls: 'claudian-collaboration-quota-recommendation',
        attr: {
          role: 'status',
          'aria-label': 'Quota routing recommendation',
        },
      });
      const recommendation = recommendations[0];
      recommendationEl.createSpan({
        text: `${this.getParticipantLabel(recommendation.participantId)}: ${
          recommendation.recommendation.reason
        }`,
      });
      const applyButton = recommendationEl.createEl('button', {
        text: 'Apply preserve mode',
        attr: { type: 'button' },
      });
      applyButton.addEventListener('click', () => {
        applyButton.disabled = true;
        applyButton.setText('Applying…');
        void this.options.onApplyQuotaRecommendation(recommendation.participantId)
          .finally(() => {
            applyButton.disabled = false;
            applyButton.setText('Apply preserve mode');
          });
      });
    }

    const railEl = containerEl.createDiv({
      cls: 'claudian-collaboration-rail',
      attr: {
        'aria-label': 'Message recipients',
        title: 'Choose who receives the next message. You do not need to type an @ mention.',
      },
    });
    railEl.createSpan({
      cls: 'claudian-collaboration-rail-label',
      text: 'Send message to',
    });
    const allButton = railEl.createEl('button', {
      cls: 'claudian-collaboration-recipient is-selected',
      text: Object.values(this.options.participantResourcePolicies).some(policy => (
        policy && policy.mode !== 'active'
      ))
        ? 'Available'
        : 'All',
      attr: {
        type: 'button',
        'aria-pressed': 'true',
        'data-provider': 'all',
        'aria-label': 'Send to all available agents',
      },
    });
    allButton.addEventListener('click', () => this.selectRecipient('all', allButton));

    for (const participantId of participantIds) {
      const button = railEl.createEl('button', {
        cls: 'claudian-collaboration-recipient',
        text: this.getParticipantLabel(participantId),
        attr: {
          type: 'button',
          'aria-pressed': 'false',
          'data-provider': participantId,
        },
      });
      const statusEl = button.createSpan({
        cls: 'claudian-collaboration-status',
        attr: { 'aria-hidden': 'true' },
      });
      this.statusEls.set(participantId, statusEl);
      button.addEventListener('click', () => this.selectRecipient(participantId, button));

      const stopButton = railEl.createEl('button', {
        cls: 'claudian-collaboration-stop',
        attr: {
          type: 'button',
          'aria-label': `Stop ${this.getParticipantLabel(participantId)}`,
          'data-provider': participantId,
        },
      });
      setIcon(stopButton, 'square');
      stopButton.addEventListener('click', () => this.options.onStop(participantId));
      this.stopEls.set(participantId, stopButton);

      const policy = this.options.participantResourcePolicies[participantId];
      const resourceButton = railEl.createEl('button', {
        cls: 'claudian-collaboration-resource',
        text: this.getResourceLabel(policy),
        attr: {
          type: 'button',
          'aria-label': `Edit usage policy for ${this.getParticipantLabel(participantId)}`,
          'data-provider': participantId,
        },
      });
      resourceButton.addEventListener('click', () => (
        this.options.onEditResourcePolicy(participantId)
      ));
      this.resourceEls.set(participantId, resourceButton);
    }
  }

  private selectRecipient(recipientId: 'all' | ProviderId, selectedButton: HTMLElement): void {
    for (const button of this.rootEl.querySelectorAll<HTMLElement>('.claudian-collaboration-recipient')) {
      const selected = button === selectedButton;
      button.toggleClass('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }

    const inputEl = this.options.hostTab.dom.inputEl;
    const participantIds = Object.keys(this.options.participantLabels);
    const routeNames = ['all', ...participantIds].map(escapeRegExp).join('|');
    const withoutMention = inputEl.value.replace(
      new RegExp(`^@(?:${routeNames})\\s+`, 'i'),
      '',
    );
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
    const allEvents = [...room.events, ...liveEvents]
      .sort((left, right) => left.createdAt - right.createdAt);
    const hiddenEventCount = expandedTimelineRoomIds.has(this.options.roomId)
      ? 0
      : Math.max(0, allEvents.length - 120);
    const events = hiddenEventCount > 0
      ? allEvents.slice(hiddenEventCount)
      : allEvents;
    this.timelineEl.empty();

    if (events.length === 0) {
      this.timelineEl.createDiv({
        cls: 'claudian-collaboration-empty',
        text: 'Send a message to begin the room.',
      });
      this.renderRecovery(room);
      return;
    }

    if (hiddenEventCount > 0) {
      const earlierButton = this.timelineEl.createEl('button', {
        cls: 'claudian-collaboration-earlier',
        text: `Show ${Math.min(120, hiddenEventCount)} earlier messages`,
        attr: {
          type: 'button',
          'aria-label': `${hiddenEventCount} earlier collaboration messages are hidden`,
        },
      });
      earlierButton.addEventListener('click', () => {
        expandedTimelineRoomIds.add(this.options.roomId);
        this.scheduleRender();
      });
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
        text: event.authorId === 'user'
          ? 'You'
          : event.authorId === 'system' && event.deliberationPhase
            ? `Deliberation · ${event.deliberationPhase}`
            : event.authorId === 'system' && event.workflow
              ? `Workflow · ${event.workflow.phase}`
            : [
              this.getParticipantLabel(event.authorId),
              event.deliberationPhase ?? event.workflow?.phase,
            ].filter(Boolean).join(' · '),
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
      if (event.deliberationOutcome && event.deliberationId) {
        const outcome = event.deliberationOutcome;
        const statusEl = messageEl.createDiv({
          cls: 'claudian-collaboration-outcome',
          attr: {
            'data-status': outcome.status,
            'aria-label': 'Deliberation outcome',
          },
        });
        statusEl.createSpan({
          cls: 'claudian-collaboration-outcome-status',
          text: outcome.status === 'unanimous'
            ? 'Unanimous'
            : outcome.status === 'approved-with-concerns'
              ? 'Approved with concerns'
              : 'Not approved',
        });
        statusEl.createSpan({
          cls: 'claudian-collaboration-outcome-votes',
          text: `${outcome.approvals.length}/${
            new Set([
              ...outcome.approvals,
              ...outcome.objections,
              ...outcome.missing,
            ]).size
          } approvals`,
        });
        const workflowStarted = room.events.some(candidate => (
          candidate.workflow?.deliberationId === event.deliberationId
        ));
        if (outcome.status !== 'rejected' && !workflowStarted) {
          const startButton = statusEl.createEl('button', {
            cls: 'claudian-collaboration-start-plan',
            text: 'Start approved plan',
            attr: {
              type: 'button',
              'aria-label': 'Start autonomous execution of the approved plan',
            },
          });
          startButton.addEventListener('click', () => {
            startButton.disabled = true;
            startButton.setText('Starting…');
            void this.options.onStartApprovedPlan(event.deliberationId!)
              .catch(() => {
                startButton.disabled = false;
                startButton.setText('Start approved plan');
              });
          });
        }
      }
      if (event.workflow?.phase === 'checkpoint' && !event.workflowDecision) {
        if (event.resourceUsage?.length) {
          const usageEl = messageEl.createDiv({
            cls: 'claudian-collaboration-workflow-usage',
            attr: { 'aria-label': 'Workflow token usage' },
          });
          for (const usage of event.resourceUsage) {
            usageEl.createSpan({
              text: `${this.getParticipantLabel(usage.participantId)}: +${
                usage.contextTokenDelta.toLocaleString()
              } context tokens${
                usage.turns !== undefined ? ` · ${usage.turns} turns` : ''
              } · ${usage.contextPercent}% context${
                usage.weeklyUsagePercent !== undefined
                  ? ` · ${usage.weeklyUsagePercent}% week`
                  : ''
              }`,
            });
          }
          usageEl.createSpan({
            cls: 'claudian-collaboration-workflow-usage-note',
            text: 'Monetary cost unavailable for subscription-backed accounts.',
          });
        }
        const decided = room.events.some(candidate => (
          candidate.workflow?.id === event.workflow?.id && candidate.workflowDecision
        ));
        if (!decided) {
          const checkpointEl = messageEl.createDiv({
            cls: 'claudian-collaboration-checkpoint',
            attr: { 'aria-label': 'Human approval checkpoint' },
          });
          const approveButton = checkpointEl.createEl('button', {
            cls: 'claudian-collaboration-checkpoint-approve',
            text: 'Approve result',
            attr: { type: 'button' },
          });
          approveButton.addEventListener('click', () => {
            approveButton.disabled = true;
            void this.options.onApproveWorkflow(
              event.workflow!.id,
              event.workflow!.deliberationId,
            ).catch(() => { approveButton.disabled = false; });
          });
          const changesButton = checkpointEl.createEl('button', {
            cls: 'claudian-collaboration-checkpoint-changes',
            text: 'Request changes',
            attr: { type: 'button' },
          });
          changesButton.addEventListener('click', () => {
            changesButton.disabled = true;
            void this.options.onRequestWorkflowChanges(
              event.workflow!.id,
              event.workflow!.deliberationId,
            ).catch(() => { changesButton.disabled = false; });
          });
        }
      }
      if (event.workflowDecision === 'changes-requested' && event.workflow) {
        const workflow = event.workflow;
        const laterWorkflow = room.events.some(candidate => (
          candidate.workflow?.deliberationId === workflow.deliberationId
          && candidate.workflow?.id !== workflow.id
          && candidate.createdAt > event.createdAt
        ));
        if (!laterWorkflow) {
          const retryPlanButton = messageEl.createEl('button', {
            cls: 'claudian-collaboration-retry-plan',
            text: 'Retry approved plan',
            attr: {
              type: 'button',
              'aria-label': 'Retry the approved plan with current agent availability',
            },
          });
          retryPlanButton.addEventListener('click', () => {
            retryPlanButton.disabled = true;
            retryPlanButton.setText('Starting…');
            void this.options.onRetryApprovedPlan(workflow.deliberationId)
              .catch(() => {
                retryPlanButton.disabled = false;
                retryPlanButton.setText('Retry approved plan');
              });
          });
        }
      }
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
            text: `${this.getParticipantLabel(providerId)}: ${delivery.status}`,
          });
        }
      }
      if (event.authorId !== 'user' && event.authorId !== 'system') {
        const reviewer = this.options.participantTabs
          .map(tab => this.getTabParticipantId(tab))
          .find(participantId => participantId !== event.authorId);
        if (reviewer) {
          const reviewButton = messageEl.createEl('button', {
            cls: 'claudian-collaboration-review',
            text: `Ask ${this.getParticipantLabel(reviewer)} to review`,
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
          ? `${this.getParticipantLabel(retryable[0].providerId)} ${
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
          ? `Rebase ${this.getParticipantLabel(delivery.providerId)}`
          : `Retry ${this.getParticipantLabel(delivery.providerId)}`,
        attr: {
          type: 'button',
          'aria-label': delivery.status === 'conflict'
            ? `Ask ${this.getParticipantLabel(delivery.providerId)} to rebase the proposal`
            : `Retry with ${this.getParticipantLabel(delivery.providerId)}`,
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
      if (delivery.status === 'conflict' && (delivery.fileProposals?.length ?? 0) > 0) {
        const selectedHunks: Record<string, Set<string>> = {};
        const reviewEl = this.recoveryEl.createEl('details', {
          cls: 'claudian-collaboration-proposal',
        });
        reviewEl.createEl('summary', {
          text: `Review ${this.getParticipantLabel(delivery.providerId)} proposal`,
        });
        const proposalBodyEl = reviewEl.createDiv({
          cls: 'claudian-collaboration-proposal-body',
        });
        for (const proposal of delivery.fileProposals ?? []) {
          const acceptedContent = proposal.acceptedContent;
          const proposalReview = acceptedContent === undefined
            ? null
            : createCollaborationProposalReview(acceptedContent, proposal.proposedContent);
          const fileEl = proposalBodyEl.createDiv({
            cls: 'claudian-collaboration-proposal-file',
          });
          const headingEl = fileEl.createDiv({
            cls: 'claudian-collaboration-proposal-heading',
          });
          headingEl.createSpan({
            cls: 'claudian-collaboration-proposal-path',
            text: proposal.path,
          });
          headingEl.createEl('time', {
            cls: 'claudian-collaboration-proposal-time',
            text: new Date(proposal.createdAt).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            }),
            attr: { datetime: new Date(proposal.createdAt).toISOString() },
          });
          if (proposal.summary) {
            fileEl.createDiv({
              cls: 'claudian-collaboration-proposal-summary',
              text: proposal.summary,
            });
          }
          if (!proposalReview) {
            fileEl.createDiv({
              cls: 'claudian-collaboration-proposal-legacy',
              text: 'This earlier proposal can be applied as a whole.',
            });
            selectedHunks[proposal.path] = new Set(['legacy-whole-file']);
            continue;
          }
          const statsEl = headingEl.createSpan({
            cls: 'claudian-collaboration-proposal-stats',
            attr: { 'aria-label': `${proposalReview.stats.added} lines added, ${
              proposalReview.stats.removed
            } lines removed` },
          });
          renderDiffStats(statsEl, proposalReview.stats);
          selectedHunks[proposal.path] = new Set(
            proposalReview.hunks.map(hunk => hunk.id),
          );
          proposalReview.hunks.forEach((hunk, hunkIndex) => {
            const hunkEl = fileEl.createDiv({
              cls: 'claudian-collaboration-proposal-hunk',
            });
            const hunkId = `${delivery.eventId}-${delivery.providerId}-${
              proposal.path
            }-${hunk.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
            const labelEl = hunkEl.createEl('label', {
              cls: 'claudian-collaboration-proposal-hunk-label',
              attr: { for: hunkId },
            });
            const checkbox = labelEl.createEl('input', {
              attr: { id: hunkId, type: 'checkbox' },
            });
            checkbox.checked = true;
            labelEl.createSpan({
              text: `Change ${hunkIndex + 1} · line ${hunk.oldStart}`,
            });
            checkbox.addEventListener('change', () => {
              if (checkbox.checked) selectedHunks[proposal.path].add(hunk.id);
              else selectedHunks[proposal.path].delete(hunk.id);
            });
            const diffEl = hunkEl.createDiv({
              cls: 'claudian-collaboration-proposal-diff',
            });
            renderDiffContent(diffEl, hunk.diffLines, 0);
          });
        }
        const applyButton = actionsEl.createEl('button', {
          cls: 'claudian-collaboration-retry',
          text: `Apply selected from ${this.getParticipantLabel(delivery.providerId)}`,
          attr: {
            type: 'button',
            'aria-label': `Apply selected changes from ${
              this.getParticipantLabel(delivery.providerId)
            } proposal`,
          },
        });
        applyButton.addEventListener('click', () => {
          const selection = Object.fromEntries(
            Object.entries(selectedHunks).map(([path, ids]) => [path, [...ids]]),
          );
          if (Object.values(selection).every(ids => ids.length === 0)) return;
          applyButton.disabled = true;
          void this.options.onApplyProposal(
            delivery.eventId,
            delivery.providerId,
            selection,
          )
            .catch(() => { applyButton.disabled = false; });
        });
      }
    }
  }

  private syncRecipientSelection(): void {
    const input = this.options.hostTab.dom.inputEl.value.trimStart();
    const participant = Object.keys(this.options.participantLabels).find(participantId => (
      input.toLowerCase().startsWith(`@${participantId.toLowerCase()} `)
    ));
    const selectedProvider = participant ?? 'all';

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
        authorId: this.getTabParticipantId(tab),
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
      const participantId = this.getTabParticipantId(tab);
      const statusEl = this.statusEls.get(participantId);
      if (!statusEl) continue;
      const status = tab.state.needsAttention
        ? 'attention'
        : tab.state.isStreaming
          ? 'streaming'
          : 'idle';
      statusEl.dataset.status = status;
      statusEl.setAttribute('title', `${this.getParticipantLabel(participantId)}: ${status}`);
      const recipientButton = statusEl.parentElement;
      recipientButton?.setAttribute(
        'aria-label',
        `${this.getParticipantLabel(participantId)}, ${status}`,
      );
      const stopButton = this.stopEls.get(participantId);
      const canStop = this.options.canStop(participantId);
      stopButton?.toggleClass('claudian-hidden', !canStop);
      stopButton?.setAttribute('aria-hidden', canStop ? 'false' : 'true');
      if (stopButton) stopButton.disabled = !canStop;
      const resourceEl = this.resourceEls.get(participantId);
      const policy = this.options.participantResourcePolicies[participantId];
      const contextUsage = tab.state.usage;
      const persistedUsage = this.options.participantUsageSnapshots[participantId];
      if (resourceEl) {
        resourceEl.setText(this.getResourceLabel(
          policy,
          contextUsage?.percentage ?? persistedUsage?.contextPercent,
        ));
        resourceEl.dataset.mode = policy?.mode ?? 'active';
        const stale = !!policy?.quotaSnapshot && isQuotaSnapshotStale(policy.quotaSnapshot);
        resourceEl.dataset.stale = stale ? 'true' : 'false';
        resourceEl.setAttribute(
          'title',
          [
            policy?.quotaSnapshot?.windows.length
              ? policy.quotaSnapshot.windows
                .map(window => `${window.label}: ${window.utilizationPercent}%`)
                .join(' · ')
              : policy?.weeklyUsagePercent !== undefined
                ? `${policy.weeklyUsagePercent}% manually reported weekly usage`
              : 'Weekly usage not set',
            policy?.quotaSnapshot
              ? `Provider snapshot ${new Date(policy.quotaSnapshot.fetchedAt).toLocaleString()}${
                stale ? ' (stale)' : ''
              }`
              : 'No provider snapshot',
            policy?.quotaRefreshError ? `Last refresh failed: ${policy.quotaRefreshError}` : '',
            contextUsage
              ? `${contextUsage.contextTokens.toLocaleString()} context tokens`
              : persistedUsage
                ? `${persistedUsage.contextTokens.toLocaleString()} context tokens (last workflow)`
                : 'Context usage unavailable',
          ].filter(Boolean).join(' · '),
        );
      }
    }
  }

  private getResourceLabel(
    policy: CollaborationParticipantResourcePolicy | undefined,
    contextPercent?: number,
  ): string {
    const fiveHour = policy?.quotaSnapshot?.windows.find(window => window.id === 'five-hour'
      || window.id === 'primary');
    const weekly = policy?.quotaSnapshot?.windows.find(window => window.id === 'seven-day'
      || window.id === 'secondary');
    const usage = fiveHour || weekly
      ? [
        fiveHour ? `${fiveHour.utilizationPercent}% 5h` : '',
        weekly ? `${weekly.utilizationPercent}% week` : '',
      ].filter(Boolean).join(' · ')
      : policy?.weeklyUsagePercent !== undefined
        ? `${policy.weeklyUsagePercent}% week`
      : contextPercent !== undefined
        ? `${contextPercent}% context`
        : 'Usage';
    const labeled = policy?.quotaSnapshot && isQuotaSnapshotStale(policy.quotaSnapshot)
      ? `${usage} · stale`
      : usage;
    return policy?.mode === 'preserve'
      ? `${labeled} · preserve`
      : policy?.mode === 'unavailable'
        ? `${labeled} · unavailable`
        : labeled;
  }

  private getTabParticipantId(tab: TabData): string {
    if (!tab.conversationId) return tab.providerId;
    return this.options.plugin.getConversationSync(tab.conversationId)
      ?.collaboration?.participantId ?? tab.providerId;
  }

  private getParticipantLabel(participantId: string): string {
    return this.options.participantLabels[participantId]
      ?? getFallbackParticipantLabel(participantId);
  }
}
