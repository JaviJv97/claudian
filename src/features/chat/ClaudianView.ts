import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice, Scope, setIcon } from 'obsidian';

import type { CollaborationDispatch } from '../../core/collaboration/CollaborationCoordinator';
import { CollaborationCoordinator } from '../../core/collaboration/CollaborationCoordinator';
import {
  buildDeliberationInstruction,
  evaluateDeliberationConsensus,
} from '../../core/collaboration/collaborationDeliberation';
import {
  appendQuotaHistory,
  getPreservedMentionedParticipantIds,
  getRoutableCollaborationParticipantIds,
  getUnavailableMentionedParticipantIds,
  isReadOnlyCollaborationPlan,
} from '../../core/collaboration/collaborationResourcePolicy';
import {
  createCollaborationMemberships,
  createCollaborationRoomId,
  getCollaborationParticipantId,
  resolveCollaborationTurn,
} from '../../core/collaboration/collaborationRoom';
import {
  buildCollaborationTaskExecutionInstruction,
  buildCollaborationTaskReviewInstruction,
  parseCollaborationTaskEvidence,
  parseCollaborationTaskReview,
} from '../../core/collaboration/collaborationTaskWorkflow';
import { buildCollaborationPrompt } from '../../core/collaboration/collaborationTranscript';
import {
  buildCollaborationExecutionInstruction,
  buildCollaborationReviewInstruction,
  buildCollaborationVerificationInstruction,
} from '../../core/collaboration/collaborationWorkflow';
import {
  approveCollaborationWorkQueue,
  approveCompletedCollaborationWorkQueue,
  type CollaborationDraftTaskContractUpdate,
  isCollaborationPathInTaskScope,
  parseCollaborationTaskGraph,
  setCollaborationWorkQueuePaused,
  transitionCollaborationTask,
  updateCollaborationDraftTaskAssignment,
  updateCollaborationDraftTaskContract,
} from '../../core/collaboration/collaborationWorkQueue';
import { StartupProfiler } from '../../core/performance/StartupProfiler';
import { getHiddenProviderCommandSet } from '../../core/providers/commands/hiddenCommands';
import {
  getProviderSettingsSnapshotWithModel,
  resolveConversationModel,
} from '../../core/providers/conversationModel';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import { type AppTabManagerState, DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '../../core/providers/types';
import type {
  CollaborationDeliberationPhase,
  CollaborationEvent,
  CollaborationWorkflowPhase,
  ImageAttachment,
} from '../../core/types';
import { VIEW_TYPE_CLAUDIAN } from '../../core/types';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../utils/animationFrame';
import type { FeatureHost } from '../FeatureHost';
import {
  captureCollaborationFileSnapshot,
  createCollaborationFileRevision,
  findChangedSharedFiles,
  findSharedReferencedFiles,
  findStaleFileProposals,
} from './collaboration/collaborationFileConflicts';
import {
  applyCollaborationProposalHunks,
  createCollaborationProposalReview,
} from './collaboration/collaborationProposalReview';
import {
  findCollaborationProfileRepairs,
  findCollaborationRebindCandidates,
} from './collaboration/collaborationRebinding';
import { CollaborationResourcePolicyModal } from './collaboration/CollaborationResourcePolicyModal';
import { findFreshAssistantMessage } from './collaboration/collaborationResponse';
import {
  chooseCollaborationParticipants,
  toClaudeParticipantChoices,
} from './collaboration/CollaborationRoomModal';
import { groupCollaborationTabBarItems } from './collaboration/collaborationTabs';
import { CollaborationTimeline } from './collaboration/CollaborationTimeline';
import { CollaborationUsageDashboardModal } from './collaboration/CollaborationUsageDashboardModal';
import type { HistoryConversationStatus } from './controllers/ConversationController';
import { MentionCacheCoordinator } from './services/MentionCacheCoordinator';
import { TabStatePersistenceCoordinator } from './services/TabStatePersistenceCoordinator';
import {
  getTabProviderId,
  initializeTabService,
  sendTabInputMessageFromExplicitEnterShortcut,
  setupServiceCallbacks,
  updatePlanModeUI,
} from './tabs/Tab';
import { TabBar } from './tabs/TabBar';
import { TabManager } from './tabs/TabManager';
import type { TabBarItem, TabData, TabId } from './tabs/types';
import { recalculateUsageForModel } from './utils/usageInfo';

type LoadableView = {
  containerEl?: HTMLElement;
  load: () => Promise<void> | void;
};

interface CollaborationWorkflowRoute {
  id: string;
  deliberationId: string;
  originalGoal: string;
  approvedSynthesis: string;
  taskId?: string;
}

export class ClaudianView extends ItemView {
  private plugin: FeatureHost;

  // Tab management
  private tabManager: TabManager | null = null;
  private mentionCacheCoordinator: MentionCacheCoordinator | null = null;
  private tabBar: TabBar | null = null;
  private tabBarContainerEl: HTMLElement | null = null;
  private tabContentEl: HTMLElement | null = null;
  private navRowContent: HTMLElement | null = null;
  private inputFooterEl: HTMLElement | null = null;
  private inputNavRowHostEl: HTMLElement | null = null;
  private activeInputSlotEl: HTMLElement | null = null;
  private activeInputTabId: TabId | null = null;

  // DOM Elements
  private viewContainerEl: HTMLElement | null = null;
  private newTabButtonEl: HTMLElement | null = null;

  // History elements
  private historyDropdown: HTMLElement | null = null;
  private historyRenderAbortController: AbortController | null = null;

  // Event refs for cleanup
  private eventRefs: EventRef[] = [];

  // Debouncing for tab bar updates
  private pendingTabBarUpdate: ScheduledAnimationFrame | null = null;

  private tabStatePersistence: TabStatePersistenceCoordinator;
  private collaborationCoordinator: CollaborationCoordinator;
  private collaborationTimelines = new Map<TabId, CollaborationTimeline>();
  private collaborationReconcileQueue: Promise<void> = Promise.resolve();
  private activeCollaborationDeliveries = new Map<string, string>();
  private quotaRefreshInterval: number | null = null;
  private quotaRefreshFlights = new Map<string, Promise<void>>();

  constructor(leaf: WorkspaceLeaf, plugin: FeatureHost) {
    super(leaf);
    this.plugin = plugin;
    this.tabStatePersistence = new TabStatePersistenceCoordinator(
      state => this.plugin.persistTabManagerState(state),
    );
    this.collaborationCoordinator = new CollaborationCoordinator({
      storage: this.plugin.storage.rooms,
      onDeliveryChanged: () => this.refreshAllCollaborationTimelines(),
    });

    // Hover Editor compatibility: Define load as an instance method that can't be
    // overwritten by prototype patching. Hover Editor patches ClaudianView.prototype.load
    // after our class is defined, but instance methods take precedence over prototype methods.
    const prototype = Object.getPrototypeOf(this) as LoadableView;
    const originalLoad = prototype.load.bind(this);
    Object.defineProperty(this, 'load', {
      value: async () => {
        // Ensure containerEl exists before any patched load code tries to use it
        if (!this.containerEl) {
          (this as LoadableView).containerEl = createDiv({ cls: 'view-content' });
        }
        // Wrap in try-catch to prevent Hover Editor errors from breaking our view
        try {
          return await originalLoad();
        } catch {
          // Hover Editor may throw if its DOM setup fails - continue anyway
        }
      },
      writable: false,
      configurable: false,
    });
  }

  getViewType(): string {
    return VIEW_TYPE_CLAUDIAN;
  }

  getDisplayText(): string {
    return 'Claudian';
  }

  getIcon(): string {
    return 'bot';
  }

  /** Refreshes model-dependent UI across all tabs (used after settings/env changes). */
  refreshModelSelector(changedProviderId?: ProviderId): void {
    this.tabManager?.reconcileProviderAvailability();
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      const providerId = getTabProviderId(tab, this.plugin);
      if (
        changedProviderId
        && tab.lifecycleState !== 'blank'
        && providerId !== changedProviderId
      ) {
        continue;
      }
      const conversation = tab.conversationId
        ? this.plugin.getConversationSync(tab.conversationId)
        : null;
      const modelOverride = conversation
        ? resolveConversationModel(this.plugin.settings, providerId, conversation).model
        : tab.lifecycleState === 'blank'
        ? tab.draftModel
        : tab.service?.getAuxiliaryModel?.() ?? null;
      const providerSettings = getProviderSettingsSnapshotWithModel(
        this.plugin.settings,
        providerId,
        modelOverride,
      );
      const model = providerSettings.model;
      const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
      const capabilities = ProviderRegistry.getCapabilities(providerId);
      const contextWindow = uiConfig.getContextWindowSize(
        model,
        providerSettings.customContextLimits,
        providerSettings,
      );

      if (tab.state.usage) {
        tab.state.usage = recalculateUsageForModel(tab.state.usage, model, contextWindow);
      }

      tab.ui.modelSelector?.updateDisplay();
      tab.ui.modelSelector?.renderOptions();
      tab.ui.modeSelector?.updateDisplay();
      tab.ui.modeSelector?.renderOptions();
      tab.ui.thinkingBudgetSelector?.updateDisplay();
      tab.ui.permissionToggle?.updateDisplay();
      tab.ui.serviceTierToggle?.updateDisplay();
      tab.dom.inputWrapper.toggleClass(
        'claudian-input-plan-mode',
        providerSettings.permissionMode === 'plan' && capabilities.supportsPlanMode,
      );
    }

    if (!changedProviderId) {
      this.tabManager?.primeProviderRuntime();
    }
  }

  invalidateProviderCommandCaches(providerIds?: ProviderId[]): void {
    this.tabManager?.invalidateProviderCommandCaches(providerIds);
  }

  invalidateProviderResources(providerIds: ProviderId[], generation: number): void {
    this.tabManager?.invalidateProviderResources(providerIds, generation);
  }

  /** Updates provider-scoped hidden commands on all tabs after settings changes. */
  updateHiddenProviderCommands(): void {
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      tab.ui.slashCommandDropdown?.setHiddenCommands(
        getHiddenProviderCommandSet(this.plugin.settings, getTabProviderId(tab, this.plugin)),
      );
    }
  }

  async onOpen() {
    const span = StartupProfiler.start('view-open');
    try {
      await this.onOpenImpl();
    } finally {
      StartupProfiler.finish(span);
    }
  }

  private async onOpenImpl() {
    // Guard: Hover Editor and similar plugins may call onOpen before DOM is ready.
    // containerEl must exist before we can access contentEl or create elements.
    if (!this.containerEl) {
      return;
    }

    // Use contentEl (standard Obsidian API) as primary target.
    // Hover Editor and other plugins may modify the DOM structure,
    // so we need fallbacks to handle non-standard scenarios.
    let container: HTMLElement | null =
      this.contentEl ?? (this.containerEl.children[1] as HTMLElement | null);

    if (!container) {
      // Last resort: create our own container inside containerEl
      container = this.containerEl.createDiv();
    }

    this.viewContainerEl = container;
    this.viewContainerEl.empty();
    this.viewContainerEl.addClass('claudian-container');

    this.navRowContent = this.buildNavRowContent();
    this.tabContentEl = this.viewContainerEl.createDiv({ cls: 'claudian-tab-content-container' });
    this.buildInputFooter();

    this.tabManager = new TabManager(
      this.plugin,
      this.tabContentEl,
      this,
      {
        onPersistedStateChanged: () => {
          this.persistTabState();
        },
        onTabCreated: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
          this.syncProviderBrandColor();
          void this.reconcileCollaborationTimelines();
        },
        onActiveTabChanged: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
          this.syncProviderBrandColor();
        },
        onTabSwitched: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
          this.syncProviderBrandColor();
        },
        onTabClosed: (tabId) => {
          this.collaborationTimelines.get(tabId)?.destroy();
          this.collaborationTimelines.delete(tabId);
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.updateInputLocation();
        },
        onTabStreamingChanged: () => {
          this.updateTabBar();
          this.updateHistoryDropdown();
        },
        onTabRewindingChanged: () => this.updateTabBar(),
        onTabTitleChanged: () => this.updateTabBar(),
        onTabAttentionChanged: () => this.updateTabBar(),
        onTabConversationChanged: (tabId, conversationId, previousConversationId) => {
          this.updateTabBar();
          this.updateHistoryDropdown();
          this.syncProviderBrandColor();
          void this.handleTabConversationRebind(
            tabId,
            conversationId,
            previousConversationId,
          );
        },
        onTabProviderChanged: () => {
          this.updateTabBar();
          this.syncProviderBrandColor();
        },
      }
    );
    this.mentionCacheCoordinator = new MentionCacheCoordinator(
      () => (this.tabManager?.getAllTabs() ?? []).map(tab => ({
        fileContextManager: tab.ui.fileContextManager,
      })),
    );

    this.wireEventHandlers();
    await this.restoreOrCreateTabs();
    await this.reconcileCollaborationTimelines();
    this.startQuotaRefreshSchedule();
    this.syncProviderBrandColor();
    this.attachNavRowContentToInputFooter();
    this.updateInputLocation();
    this.updateTabBarVisibility();
  }

  async onClose() {
    this.cancelHistoryRendering();
    if (this.quotaRefreshInterval !== null) {
      window.clearInterval(this.quotaRefreshInterval);
      this.quotaRefreshInterval = null;
    }
    if (this.pendingTabBarUpdate !== null) {
      cancelScheduledAnimationFrame(this.pendingTabBarUpdate);
      this.pendingTabBarUpdate = null;
    }

    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];
    for (const timeline of this.collaborationTimelines?.values() ?? []) timeline.destroy();
    this.collaborationTimelines?.clear();
    this.quotaRefreshFlights?.clear();

    try {
      await this.persistTabStateImmediate();
    } catch {
      // The storage boundary already reports the failure. View teardown must still complete cleanly.
    } finally {
      this.tabStatePersistence.dispose();
      try {
        this.restoreActiveInputToTabContent();
        await this.tabManager?.destroy();
      } finally {
        this.tabManager = null;
        this.mentionCacheCoordinator = null;

        this.tabBar?.destroy();
        this.tabBar = null;
        this.scope = null;
      }
    }
  }

  // ============================================
  // UI Building
  // ============================================

  /**
   * Builds the active tab nav row content.
   * The wrapper is moved to the active tab's nav row on tab switches.
   */
  private buildNavRowContent(): HTMLElement {
    const wrapper = this.containerEl.createDiv({ cls: 'claudian-input-nav-content' });

    this.tabBarContainerEl = wrapper.createDiv({ cls: 'claudian-tab-bar-container' });
    this.tabBar = new TabBar(this.tabBarContainerEl, {
      onTabClick: (tabId) => this.handleTabClick(tabId),
      onTabClose: (tabId) => {
        void this.handleTabClose(tabId);
      },
      onNewTab: () => {
        void this.createNewTab().catch(() => new Notice('Failed to create tab'));
      },
      onTitleExpansionChanged: () => this.persistTabState(),
    });

    const navActionsEl = wrapper.createDiv({ cls: 'claudian-input-nav-actions' });

    this.newTabButtonEl = navActionsEl.createDiv({ cls: 'claudian-input-nav-btn claudian-new-tab-btn' });
    setIcon(this.newTabButtonEl, 'square-plus');
    this.newTabButtonEl.setAttribute('aria-label', 'New tab');
    this.newTabButtonEl.addEventListener('click', () => {
      void this.createNewTab().catch(() => new Notice('Failed to create tab'));
    });

    const newBtn = navActionsEl.createDiv({ cls: 'claudian-input-nav-btn' });
    setIcon(newBtn, 'square-pen');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => {
      void (async () => {
        await this.tabManager?.createNewConversation();
        this.updateHistoryDropdown();
      })().catch(() => new Notice('Failed to create conversation'));
    });

    // History dropdown
    const historyContainer = navActionsEl.createDiv({ cls: 'claudian-history-container' });
    const historyBtn = historyContainer.createDiv({ cls: 'claudian-input-nav-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Chat history');

    this.historyDropdown = historyContainer.createDiv({ cls: 'claudian-history-menu' });

    historyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleHistoryDropdown();
    });

    return wrapper;
  }

  private buildInputFooter(): void {
    if (!this.viewContainerEl) return;

    this.inputFooterEl = this.viewContainerEl.createDiv({ cls: 'claudian-input-footer' });
    this.inputNavRowHostEl = this.inputFooterEl.createDiv({
      cls: 'claudian-input-nav-row claudian-view-input-nav-row',
    });
    this.activeInputSlotEl = this.inputFooterEl.createDiv({ cls: 'claudian-active-input-slot' });
  }

  private attachNavRowContentToInputFooter(): void {
    if (!this.inputNavRowHostEl || !this.navRowContent) return;

    this.tabBar?.captureScrollPosition();
    this.inputNavRowHostEl.appendChild(this.navRowContent);
    this.tabBar?.restoreScrollPosition();
  }

  private updateInputLocation(): void {
    const activeTab = this.tabManager?.getActiveTab();
    if (!this.activeInputSlotEl) return;

    if (!activeTab) {
      this.activeInputSlotEl.empty();
      this.activeInputTabId = null;
      return;
    }

    if (this.activeInputTabId && this.activeInputTabId !== activeTab.id) {
      const previousTab = this.tabManager?.getTab(this.activeInputTabId);
      if (previousTab) {
        previousTab.dom.contentEl.appendChild(previousTab.dom.inputComposerEl);
      }
    }

    if (this.activeInputTabId === activeTab.id) {
      if (activeTab.dom.inputComposerEl.parentElement !== this.activeInputSlotEl) {
        this.activeInputSlotEl.appendChild(activeTab.dom.inputComposerEl);
      }
      return;
    }

    this.activeInputSlotEl.empty();
    this.activeInputSlotEl.appendChild(activeTab.dom.inputComposerEl);
    this.activeInputTabId = activeTab.id;
  }

  private restoreActiveInputToTabContent(): void {
    if (!this.activeInputTabId) return;

    const activeInputTab = this.tabManager?.getTab(this.activeInputTabId);
    if (activeInputTab) {
      activeInputTab.dom.contentEl.appendChild(activeInputTab.dom.inputComposerEl);
    }
    this.activeInputSlotEl?.empty();
    this.activeInputTabId = null;
  }

  /** Refreshes tab controls after settings that affect tab availability change. */
  refreshTabControls(): void {
    this.updateTabBarVisibility();
  }

  // ============================================
  // Tab Management
  // ============================================

  private handleTabClick(tabId: TabId): void {
    const switched = this.tabManager?.switchToTab(tabId);
    if (switched) {
      void switched.catch(() => new Notice('Failed to switch tab'));
    }
  }

  private async handleTabClose(tabId: TabId): Promise<void> {
    try {
      const tab = this.tabManager?.getTab(tabId);
      // If streaming, treat close like user interrupt (force close cancels the stream)
      const force = tab?.state.isStreaming ?? false;
      await this.tabManager?.closeTab(tabId, force);
      this.updateTabBarVisibility();
    } catch {
      new Notice('Failed to close tab');
    }
  }

  async createNewTab(): Promise<void> {
    const tab = await this.tabManager?.createTab();
    if (!tab) {
      const maxTabs = this.plugin.settings.maxTabs ?? 3;
      new Notice(`Maximum ${maxTabs} tabs allowed`);
      this.updateTabBarVisibility();
      return;
    }
    this.updateTabBarVisibility();
  }

  async startClaudeCodexCollaboration(): Promise<boolean> {
    if (!this.tabManager) {
      new Notice('Open Claudian before starting a collaboration room.');
      return false;
    }
    if (!ProviderRegistry.isEnabled('codex', this.plugin.settings)) {
      new Notice('Enable Codex in Claudian settings before starting a collaboration room.');
      return false;
    }

    const choices = toClaudeParticipantChoices(
      ProviderRegistry.getRuntimeProfiles('claude', this.plugin.settings),
    );
    choices.push({
      id: 'codex',
      providerId: 'codex',
      label: 'Codex',
      available: true,
      selected: true,
    });
    const selection = await chooseCollaborationParticipants(this.app, choices);
    if (!selection) return false;

    const maxTabs = Math.max(3, Math.min(10, this.plugin.settings.maxTabs ?? 3));
    if (this.tabManager.getTabCount() + selection.participants.length > maxTabs) {
      new Notice(
        `This room needs ${selection.participants.length} available tabs. `
        + `Close a tab or raise the tab limit.`,
      );
      return false;
    }

    const roomId = createCollaborationRoomId();
    const createdConversationIds: string[] = [];
    const createdTabIds: TabId[] = [];
    let roomCreated = false;
    try {
      const conversations = await Promise.all(selection.participants.map(async (participant) => {
        const conversation = await this.plugin.createConversation({
          providerId: participant.providerId,
          runtimeProfileId: participant.runtimeProfileId,
        });
        createdConversationIds.push(conversation.id);
        return { participant, conversation };
      }));
      const conversationIds = Object.fromEntries(
        conversations.map(({ participant, conversation }) => [participant.id, conversation.id]),
      );
      const memberships = createCollaborationMemberships(roomId, conversationIds);
      await this.plugin.storage.rooms.create({
        id: roomId,
        title: selection.title,
        participants: conversations.map(({ participant, conversation }) => ({
          id: participant.id,
          providerId: participant.providerId,
          label: participant.label,
          runtimeProfileId: participant.runtimeProfileId,
          conversationId: conversation.id,
        })),
      });
      roomCreated = true;

      await Promise.all(conversations.map(({ participant, conversation }) => (
        this.plugin.updateConversation(conversation.id, {
          title: `Collaboration · ${participant.label}`,
          collaboration: memberships[participant.id],
        })
      )));

      for (const [index, { conversation }] of conversations.entries()) {
        const tab = await this.tabManager.createTab(conversation.id, undefined, {
          activate: index === conversations.length - 1,
        });
        if (!tab) throw new Error('Could not open all collaboration participants.');
        createdTabIds.push(tab.id);
      }

      this.updateTabBarVisibility();
      await this.reconcileCollaborationTimelines();
      new Notice(`${selection.title} room created.`);
      return true;
    } catch (error) {
      for (const tabId of createdTabIds) {
        try {
          await this.tabManager.closeTab(tabId, true);
        } catch {
          // Continue rollback so one failed tab close does not strand other records.
        }
      }
      if (roomCreated) {
        try {
          await this.plugin.storage.rooms.delete(roomId);
        } catch {
          // Conversation cleanup still has value if room cleanup fails.
        }
      }
      await Promise.allSettled(
        createdConversationIds.map(id => this.plugin.deleteConversation(id)),
      );
      const message = error instanceof Error ? error.message : 'Could not create collaboration.';
      new Notice(message);
      return false;
    }
  }

  async archiveCurrentCollaboration(): Promise<boolean> {
    const activeTab = this.tabManager?.getActiveTab();
    const conversation = activeTab?.conversationId
      ? this.plugin.getConversationSync(activeTab.conversationId)
      : null;
    const roomId = conversation?.collaboration?.roomId;
    if (!roomId || !this.tabManager) {
      new Notice('The active tab is not part of a collaboration room.');
      return false;
    }
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room) {
      new Notice('Collaboration room not found.');
      return false;
    }
    await this.plugin.storage.rooms.archive(roomId);
    const conversationIds = new Set(
      room.participants.map(participant => participant.conversationId),
    );
    for (const tab of [...this.tabManager.getAllTabs()]) {
      if (tab.conversationId && conversationIds.has(tab.conversationId)) {
        await this.tabManager.closeTab(tab.id, true);
      }
    }
    this.updateTabBarVisibility();
    new Notice(`${room.title} archived.`);
    return true;
  }

  async reopenLatestCollaboration(): Promise<boolean> {
    if (!this.tabManager) return false;
    const room = (await this.plugin.storage.rooms.list())
      .find(candidate => candidate.status === 'archived');
    if (!room) {
      new Notice('No archived collaboration rooms found.');
      return false;
    }
    const maxTabs = Math.max(3, Math.min(10, this.plugin.settings.maxTabs ?? 3));
    if (this.tabManager.getTabCount() + room.participants.length > maxTabs) {
      new Notice(
        `Reopening ${room.title} needs ${room.participants.length} available tabs.`,
      );
      return false;
    }
    const openedTabs: TabId[] = [];
    try {
      for (const [index, participant] of room.participants.entries()) {
        const tab = await this.tabManager.createTab(participant.conversationId, undefined, {
          activate: index === room.participants.length - 1,
        });
        if (!tab) throw new Error('Could not reopen every collaboration participant.');
        openedTabs.push(tab.id);
      }
      await this.plugin.storage.rooms.reopen(room.id);
      this.updateTabBarVisibility();
      await this.reconcileCollaborationTimelines();
      new Notice(`${room.title} reopened.`);
      return true;
    } catch (error) {
      for (const tabId of openedTabs) {
        try {
          await this.tabManager.closeTab(tabId, true);
        } catch {
          // Continue rolling back the remaining tabs.
        }
      }
      new Notice(error instanceof Error ? error.message : 'Could not reopen collaboration.');
      return false;
    }
  }

  async replaceCurrentCollaborationParticipant(): Promise<boolean> {
    if (!this.tabManager) return false;
    const activeTab = this.tabManager.getActiveTab();
    const currentConversation = activeTab?.conversationId
      ? this.plugin.getConversationSync(activeTab.conversationId)
      : null;
    const membership = currentConversation?.collaboration;
    if (!activeTab || !currentConversation || !membership) {
      new Notice('The active tab is not a collaboration participant.');
      return false;
    }
    const room = await this.plugin.storage.rooms.get(membership.roomId);
    const currentParticipant = room?.participants.find(participant => (
      getCollaborationParticipantId(participant) === membership.participantId
    ));
    if (!room || !currentParticipant) {
      new Notice('Collaboration participant not found.');
      return false;
    }

    const choices = toClaudeParticipantChoices(
      ProviderRegistry.getRuntimeProfiles('claude', this.plugin.settings),
    );
    if (ProviderRegistry.isEnabled('codex', this.plugin.settings)) {
      choices.push({
        id: 'codex',
        providerId: 'codex',
        label: 'Codex',
        available: true,
        selected: false,
      });
    }
    const existingIds = new Set(room.participants.map(getCollaborationParticipantId));
    const candidates = choices
      .filter(choice => !existingIds.has(choice.id))
      .map(choice => ({ ...choice, selected: false }));
    if (candidates.length === 0) {
      new Notice('No unused collaboration profiles are available.');
      return false;
    }
    const selection = await chooseCollaborationParticipants(this.app, candidates, {
      title: 'Replace participant',
      help: `Choose one participant to replace ${currentParticipant.label ?? membership.participantId}.`,
      submitLabel: 'Replace participant',
      minimum: 1,
      maximum: 1,
    });
    const replacementChoice = selection?.participants[0];
    if (!replacementChoice) return false;

    const replacementConversation = await this.plugin.createConversation({
      providerId: replacementChoice.providerId,
      runtimeProfileId: replacementChoice.runtimeProfileId,
    });
    const replacement = {
      id: replacementChoice.id,
      providerId: replacementChoice.providerId,
      label: replacementChoice.label,
      runtimeProfileId: replacementChoice.runtimeProfileId,
      conversationId: replacementConversation.id,
    };
    const nextConversationIds = { ...membership.conversationIds };
    delete nextConversationIds[membership.participantId];
    nextConversationIds[replacementChoice.id] = replacementConversation.id;

    try {
      await this.plugin.updateConversation(replacementConversation.id, {
        title: `Collaboration · ${replacementChoice.label}`,
        collaboration: {
          roomId: room.id,
          participantId: replacementChoice.id,
          conversationIds: nextConversationIds,
        },
      });
      await Promise.all(room.participants
        .filter(participant => getCollaborationParticipantId(participant) !== membership.participantId)
        .map(participant => this.plugin.updateConversation(participant.conversationId, {
          collaboration: {
            roomId: room.id,
            participantId: getCollaborationParticipantId(participant),
            conversationIds: nextConversationIds,
          },
        })));
      await this.plugin.storage.rooms.replaceParticipant(
        room.id,
        membership.participantId,
        replacement,
      );
      await this.tabManager.closeTab(activeTab.id, true);
      const replacementTab = await this.tabManager.createTab(
        replacementConversation.id,
        undefined,
        { activate: true },
      );
      if (!replacementTab) throw new Error('Could not open the replacement participant.');
      this.updateTabBarVisibility();
      await this.reconcileCollaborationTimelines();
      new Notice(`${replacementChoice.label} joined ${room.title}.`);
      return true;
    } catch (error) {
      try {
        await this.plugin.storage.rooms.replaceParticipant(
          room.id,
          replacementChoice.id,
          currentParticipant,
        );
      } catch {
        // The repository may not have reached the replacement step.
      }
      await this.plugin.deleteConversation(replacementConversation.id);
      if (!this.tabManager.getAllTabs().some(tab => tab.conversationId === currentConversation.id)) {
        await this.tabManager.createTab(currentConversation.id, undefined, { activate: true });
      }
      new Notice(error instanceof Error ? error.message : 'Could not replace participant.');
      return false;
    }
  }

  async routeCollaborationMessage(
    originTabId: TabId,
    content: string,
    images?: ImageAttachment[],
    workflow?: CollaborationWorkflowRoute,
  ): Promise<boolean> {
    const originTab = this.tabManager?.getTab(originTabId);
    const originConversation = originTab?.conversationId
      ? this.plugin.getConversationSync(originTab.conversationId)
      : null;
    const membership = originConversation?.collaboration;
    if (!originTab || !membership || !this.tabManager) return false;

    const room = await this.plugin.storage.rooms.get(membership.roomId);
    if (!room) {
      new Notice('This collaboration room could not be loaded.');
      return true;
    }

    const unavailableMentions = getUnavailableMentionedParticipantIds(room, content);
    if (unavailableMentions.length > 0) {
      new Notice(`${unavailableMentions.join(', ')} is marked unavailable.`);
      return true;
    }
    const preservedOverrides = getPreservedMentionedParticipantIds(room, content);
    if (preservedOverrides.length > 0) {
      new Notice(
        `${preservedOverrides.join(', ')} is in preserve mode; the explicit mention overrides quota preservation.`,
      );
    }
    const workflowTask = workflow?.taskId
      ? room.workQueue?.tasks.find(task => task.id === workflow.taskId)
      : undefined;
    const routableParticipantIds = workflowTask
      ? [workflowTask.ownerId, workflowTask.reviewerId].filter(participantId => (
        room.participants.some(participant => (
          getCollaborationParticipantId(participant) === participantId
          && participant.resourcePolicy?.mode !== 'unavailable'
        ))
      ))
      : getRoutableCollaborationParticipantIds(
        room,
        content,
        Boolean(workflow),
      );
    if (routableParticipantIds.length === 0) {
      new Notice('No available agents are eligible for this message.');
      return true;
    }
    const collaborationTurn = resolveCollaborationTurn(content, routableParticipantIds);
    const discussionMode = room.discussionMode ?? 'parallel';
    if (
      (discussionMode === 'deliberation' || workflow)
      && routableParticipantIds.length < 2
    ) {
      new Notice(
        workflow
          ? 'Autonomous workflows require at least two active agents for cross-review.'
          : 'Deliberation requires at least two available agents.',
      );
      return true;
    }
    if (
      discussionMode === 'mentioned-only'
      && !/(^|\s)@(?:all|[A-Za-z0-9][A-Za-z0-9._-]*)\b/i.test(content)
    ) {
      new Notice('Mention an agent or choose a recipient in mentioned-only mode.');
      return true;
    }
    const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
    const sharedReferencedFiles = workflowTask
      ? this.plugin.app.vault.getFiles()
        .map(file => file.path)
        .filter(path => (
          isCollaborationPathInTaskScope(path, workflowTask.fileScopes)
          && !/\.(?:avif|gif|ico|jpe?g|mp[34]|pdf|png|webm|webp|woff2?|zip)$/i.test(path)
        ))
      : workflow
        ? markdownFiles.map(file => file.path)
      : findSharedReferencedFiles(
        Object.fromEntries(collaborationTurn.recipientIds.map(providerId => [
          providerId,
          collaborationTurn.recipientContent?.[providerId] ?? collaborationTurn.content,
        ])),
        markdownFiles.map(file => file.path),
      );
    const captureSharedFileSnapshot = async () => captureCollaborationFileSnapshot(
      (await Promise.all(sharedReferencedFiles.map(async (path) => {
        const stat = await this.plugin.app.vault.adapter.stat(path);
        return {
          path,
          mtime: stat?.mtime ?? -1,
          size: stat?.size ?? -1,
        };
      }))),
    );
    const captureSharedFileContentSnapshot = async () => new Map(
      await Promise.all(sharedReferencedFiles.map(async (path) => {
        const [stat, fileContent] = await Promise.all([
          this.plugin.app.vault.adapter.stat(path),
          this.plugin.app.vault.adapter.read(path),
        ]);
        return [path, {
          revision: createCollaborationFileRevision(
            stat?.mtime ?? -1,
            stat?.size ?? fileContent.length,
            fileContent,
          ),
          content: fileContent,
        }] as const;
      })),
    );
    const captureTaskWorkspaceSnapshot = async () => {
      const paths = this.plugin.app.vault.getFiles()
        .map(file => file.path)
        .filter(path => (
          !path.startsWith('.claudian/')
          && !path.startsWith(`${this.plugin.app.vault.configDir}/`)
          && !path.startsWith('.trash/')
        ));
      return captureCollaborationFileSnapshot(await Promise.all(paths.map(async path => {
        const stat = await this.plugin.app.vault.adapter.stat(path);
        return {
          path,
          mtime: stat?.mtime ?? -1,
          size: stat?.size ?? -1,
        };
      })));
    };
    const taskWorkspaceBaseline = workflowTask
      ? await captureTaskWorkspaceSnapshot()
      : undefined;
    let fileBaseline = await captureSharedFileSnapshot();
    let fileContentBaseline = await captureSharedFileContentSnapshot();
    let activeDeliberationId: string | undefined;
    let activeDeliberationPhase: CollaborationDeliberationPhase | undefined;
    let activeWorkflowPhase: CollaborationWorkflowPhase | undefined;
    const dispatch: CollaborationDispatch = async (participant, request, signal) => {
        const participantId = getCollaborationParticipantId(participant);
        const participantFileState = await captureSharedFileContentSnapshot();
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

        const tab = this.tabManager?.getAllTabs().find(candidate => (
          candidate.conversationId === participant.conversationId
        ));
        const inputController = tab?.controllers.inputController;
        if (!tab || !inputController) {
          throw new Error(`${participantId} participant is not open`);
        }

        const existingAssistantIds = new Set(
          tab.state.messages
            .filter(message => message.role === 'assistant')
            .map(message => message.id),
        );
        const cancel = () => inputController.cancelStreaming();
        signal.addEventListener('abort', cancel, { once: true });
        try {
          await inputController.sendMessage({
            content: request.content,
            images,
            editorContextOverride: null,
            browserContextOverride: null,
            canvasContextOverride: null,
            skipCollaborationRouting: true,
          });
        } finally {
          signal.removeEventListener('abort', cancel);
        }
        if (tab.conversationId && tab.conversationId !== participant.conversationId) {
          const reboundRoom = await this.rebindCollaborationParticipant(
            room.id,
            participantId,
            tab.conversationId,
          );
          room.participants = reboundRoom.participants;
          participant.conversationId = tab.conversationId;
        }

        const assistantMessage = findFreshAssistantMessage(
          tab.state.messages,
          existingAssistantIds,
        );
        if (assistantMessage) {
          const assistantEvent: CollaborationEvent = {
            id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            kind: 'message',
            authorId: participantId,
            recipientIds: ['user'],
            content: assistantMessage.content,
            createdAt: assistantMessage.timestamp,
            delivery: {},
            sourceMessageId: assistantMessage.id,
            deliberationId: activeDeliberationId,
            deliberationPhase: activeDeliberationPhase,
            workflow: workflow && activeWorkflowPhase
              ? {
                id: workflow.id,
                deliberationId: workflow.deliberationId,
                phase: activeWorkflowPhase,
              }
              : undefined,
          };
          await this.plugin.storage.rooms.appendEvent(room.id, assistantEvent);
          room.events.push(structuredClone(assistantEvent));
          await this.plugin.storage.rooms.updateParticipantCursor(
            room.id,
            participantId,
            discussionMode === 'round-table' || discussionMode === 'deliberation'
              ? assistantEvent.id
              : request.eventId,
          );
          room.participantLastSeenEventIds ??= {};
          room.participantLastSeenEventIds[participantId] = (
            discussionMode === 'round-table' || discussionMode === 'deliberation'
          )
            ? assistantEvent.id
            : request.eventId;
          this.refreshCollaborationTimelines(room.id);
        }
        if (signal.aborted || assistantMessage?.isInterrupt) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (!assistantMessage) {
          throw new Error(`${participantId} completed without a new assistant response`);
        }
        const conflictFiles = findChangedSharedFiles(
          fileBaseline,
          await captureSharedFileSnapshot(),
          sharedReferencedFiles,
        );
        const proposedFileState = await captureSharedFileContentSnapshot();
        const fileProposals = findStaleFileProposals(
          fileContentBaseline,
          participantFileState,
          proposedFileState,
          participantId,
          assistantMessage?.content,
        );
        for (const proposal of fileProposals) {
          const accepted = participantFileState.get(proposal.path);
          if (accepted) {
            await this.plugin.app.vault.adapter.write(proposal.path, accepted.content);
          }
        }
        return {
          providerMessageId: assistantMessage?.assistantMessageId,
          conflictFiles: fileProposals.length > 0
            ? fileProposals.map(proposal => proposal.path)
            : discussionMode === 'parallel' && conflictFiles.length > 0
              ? conflictFiles
              : undefined,
          fileProposals: fileProposals.length > 0 ? fileProposals : undefined,
        };
    };

    if (workflow) {
      const participantIds = routableParticipantIds;
      const usageBaseline = new Map(participantIds.map((participantId) => {
        const participant = room.participants.find(candidate => (
          getCollaborationParticipantId(candidate) === participantId
        ));
        const tab = participant && this.tabManager?.getAllTabs().find(candidate => (
          candidate.conversationId === participant.conversationId
        ));
        const persistedUsage = participant
          ? this.plugin.getConversationSync(participant.conversationId)?.usage
          : undefined;
        const priorWorkflowUsage = [...room.events].reverse()
          .flatMap(event => event.resourceUsage ?? [])
          .find(usage => usage.participantId === participantId);
        return [
          participantId,
          tab?.state.usage?.contextTokens
            ?? persistedUsage?.contextTokens
            ?? priorWorkflowUsage?.contextTokens
            ?? 0,
        ] as const;
      }));
      const runWorkflowPhase = async (
        phase: Exclude<CollaborationWorkflowPhase, 'checkpoint'>,
        recipients: string[],
        strategy: 'parallel' | 'sequential',
        prepareContent: (participantId: string) => string,
      ): Promise<CollaborationEvent> => {
        activeDeliberationId = undefined;
        activeDeliberationPhase = undefined;
        activeWorkflowPhase = phase;
        const phaseTurn = await this.collaborationCoordinator.send(room, {
          content: `Autonomous ${phase} phase`,
          recipientIds: recipients,
          strategy,
          eventAuthorId: 'system',
          eventKind: 'system',
          eventMetadata: {
            workflow: {
              id: workflow.id,
              deliberationId: workflow.deliberationId,
              phase,
              taskId: workflow.taskId,
            },
          },
          prepareContent: participant => prepareContent(
            getCollaborationParticipantId(participant),
          ),
          dispatch,
        });
        room.events.push(structuredClone(phaseTurn.event));
        for (const participantId of recipients) {
          this.activeCollaborationDeliveries.set(
            this.getCollaborationDeliveryKey(room.id, participantId),
            phaseTurn.event.id,
          );
        }
        this.refreshCollaborationTimelines(room.id);
        await phaseTurn.completion;
        for (const participantId of recipients) {
          this.activeCollaborationDeliveries.delete(
            this.getCollaborationDeliveryKey(room.id, participantId),
          );
        }
        this.refreshCollaborationTimelines(room.id);
        return phaseTurn.event;
      };
      const formatOutputs = (phase: CollaborationWorkflowPhase): string => room.events
        .filter(event => (
          event.workflow?.id === workflow.id
          && event.workflow.phase === phase
          && event.authorId !== 'system'
          && event.authorId !== 'user'
        ))
        .map(event => {
          const participant = room.participants.find(candidate => (
            getCollaborationParticipantId(candidate) === event.authorId
          ));
          return `[${participant?.label ?? event.authorId}]: ${event.content}`;
        })
        .join('\n\n');
      if (workflow.taskId) {
        const task = room.workQueue?.tasks.find(candidate => candidate.id === workflow.taskId);
        if (!task || !room.workQueue) throw new Error(`Queue task not found: ${workflow.taskId}`);
        const failTask = async (message: string): Promise<boolean> => {
          const latest = await this.plugin.storage.rooms.get(room.id);
          if (latest?.workQueue) {
            const current = latest.workQueue.tasks.find(candidate => candidate.id === task.id);
            if (current?.status === 'running' || current?.status === 'review') {
              const failed = transitionCollaborationTask(
                latest.workQueue,
                task.id,
                'failed',
                { actorId: current.reviewerId, failureReason: message },
              );
              await this.plugin.storage.rooms.updateWorkQueue(
                room.id,
                failed,
                latest.workQueue.updatedAt,
              );
            }
          }
          new Notice(message);
          this.refreshCollaborationTimelines(room.id);
          return true;
        };
        const executionEvent = await runWorkflowPhase(
          'execution',
          [task.ownerId],
          'sequential',
          () => buildCollaborationTaskExecutionInstruction(room, task),
        );
        if (executionEvent.delivery[task.ownerId]?.status !== 'completed') {
          return failTask(`${task.id} execution did not complete.`);
        }
        if (taskWorkspaceBaseline) {
          const currentWorkspace = await captureTaskWorkspaceSnapshot();
          const workspacePaths = [...new Set([
            ...taskWorkspaceBaseline.keys(),
            ...currentWorkspace.keys(),
          ])];
          const outsideScope = findChangedSharedFiles(
            taskWorkspaceBaseline,
            currentWorkspace,
            workspacePaths,
          ).filter(path => !isCollaborationPathInTaskScope(path, task.fileScopes));
          if (outsideScope.length > 0) {
            return failTask(
              `${task.id} changed files outside its scope: ${outsideScope.join(', ')}`,
            );
          }
        }
        const ownerOutput = [...room.events].reverse().find(event => (
          event.workflow?.id === workflow.id
          && event.workflow.phase === 'execution'
          && event.authorId === task.ownerId
        ))?.content;
        let evidence;
        try {
          evidence = parseCollaborationTaskEvidence(ownerOutput ?? '');
          const latest = await this.plugin.storage.rooms.get(room.id);
          if (!latest?.workQueue) throw new Error('Work queue not found');
          const inReview = transitionCollaborationTask(
            latest.workQueue,
            task.id,
            'review',
            { actorId: task.ownerId, evidence },
          );
          await this.plugin.storage.rooms.updateWorkQueue(
            room.id,
            inReview,
            latest.workQueue.updatedAt,
          );
          room.workQueue = structuredClone(inReview);
          for (const path of evidence.filesChanged) {
            if (
              !sharedReferencedFiles.includes(path)
              && isCollaborationPathInTaskScope(path, task.fileScopes)
              && !/\.(?:avif|gif|ico|jpe?g|mp[34]|pdf|png|webm|webp|woff2?|zip)$/i.test(path)
              && await this.plugin.app.vault.adapter.exists(path)
            ) {
              sharedReferencedFiles.push(path);
            }
          }
          fileBaseline = await captureSharedFileSnapshot();
          fileContentBaseline = await captureSharedFileContentSnapshot();
          this.refreshCollaborationTimelines(room.id);
        } catch (error) {
          return failTask(error instanceof Error ? error.message : `${task.id} evidence failed`);
        }
        const reviewEvent = await runWorkflowPhase(
          'review',
          [task.reviewerId],
          'sequential',
          () => buildCollaborationTaskReviewInstruction(room, task, evidence),
        );
        if (reviewEvent.delivery[task.reviewerId]?.status !== 'completed') {
          return failTask(`${task.id} review did not complete.`);
        }
        const reviewerOutput = [...room.events].reverse().find(event => (
          event.workflow?.id === workflow.id
          && event.workflow.phase === 'review'
          && event.authorId === task.reviewerId
        ))?.content;
        try {
          const review = parseCollaborationTaskReview(reviewerOutput ?? '');
          const latest = await this.plugin.storage.rooms.get(room.id);
          if (!latest?.workQueue) throw new Error('Work queue not found');
          const next = transitionCollaborationTask(
            latest.workQueue,
            task.id,
            review.verdict === 'approve' ? 'done' : 'failed',
            {
              actorId: task.reviewerId,
              failureReason: review.findings.join('; ') || 'Reviewer requested changes.',
            },
          );
          const reviewedTask = next.tasks.find(candidate => candidate.id === task.id);
          if (reviewedTask?.evidence) {
            reviewedTask.evidence.review = {
              reviewerId: task.reviewerId,
              verdict: review.verdict,
              findings: review.findings,
              reviewedAt: Date.now(),
            };
            reviewedTask.evidence.resourceUsage = [task.ownerId, task.reviewerId].map(
              (participantId) => {
                const participant = room.participants.find(candidate => (
                  getCollaborationParticipantId(candidate) === participantId
                ));
                const tab = participant && this.tabManager?.getAllTabs().find(candidate => (
                  candidate.conversationId === participant.conversationId
                ));
                const contextTokens = tab?.state.usage?.contextTokens
                  ?? (participant
                    ? this.plugin.getConversationSync(participant.conversationId)?.usage
                      ?.contextTokens
                    : 0)
                  ?? 0;
                return {
                  participantId,
                  contextTokens,
                  contextPercent: tab?.state.usage?.percentage ?? 0,
                  contextTokenDelta: Math.max(
                    0,
                    contextTokens - (usageBaseline.get(participantId) ?? 0),
                  ),
                  weeklyUsagePercent: participant?.resourcePolicy?.weeklyUsagePercent,
                };
              },
            );
          }
          await this.plugin.storage.rooms.updateWorkQueue(
            room.id,
            next,
            latest.workQueue.updatedAt,
          );
          new Notice(
            review.verdict === 'approve'
              ? `${task.id} approved. Dependencies were updated.`
              : `${task.id} needs changes: ${review.findings.join('; ')}`,
          );
          this.refreshCollaborationTimelines(room.id);
          return true;
        } catch (error) {
          return failTask(error instanceof Error ? error.message : `${task.id} review failed`);
        }
      }
      const readOnlyExecution = isReadOnlyCollaborationPlan(
        `${workflow.originalGoal}\n${workflow.approvedSynthesis}`,
      );
      const activeParticipantLabels = room.participants
        .filter(participant => participantIds.includes(
          getCollaborationParticipantId(participant),
        ))
        .map(participant => (
          participant.label ?? getCollaborationParticipantId(participant)
        ));
      const availabilityAdaptation = participantIds.length < room.participants.length
        ? `${activeParticipantLabels[0]} is authorized to cover responsibilities assigned to participants omitted by quota-preservation or availability policy. Treat that coverage as part of the approved runtime plan, not as scope overreach.`
        : undefined;
      const executionEvent = await runWorkflowPhase(
        'execution',
        participantIds,
        readOnlyExecution ? 'parallel' : 'sequential',
        participantId => buildCollaborationExecutionInstruction(
          room,
          participantId,
          workflow.originalGoal,
          workflow.approvedSynthesis,
          activeParticipantLabels,
          participantId === participantIds[0]
            && participantIds.length < room.participants.length,
        ),
      );
      let workflowNeedsAttention = Object.values(executionEvent.delivery).some(delivery => (
        delivery.status !== 'completed'
      ));
      if (!workflowNeedsAttention) {
        const executionOutputs = formatOutputs('execution');
        const reviewEvent = await runWorkflowPhase(
          'review',
          participantIds,
          'parallel',
          participantId => buildCollaborationReviewInstruction(
            room,
            participantId,
            workflow.originalGoal,
            workflow.approvedSynthesis,
            executionOutputs,
            availabilityAdaptation,
          ),
        );
        workflowNeedsAttention = Object.values(reviewEvent.delivery).some(delivery => (
          delivery.status !== 'completed'
        ));
        const verifierId = workflowNeedsAttention ? undefined : participantIds.at(-1);
        if (verifierId) {
          const verificationEvent = await runWorkflowPhase(
            'verification',
            [verifierId],
            'sequential',
            participantId => buildCollaborationVerificationInstruction(
              room,
              participantId,
              workflow.originalGoal,
              workflow.approvedSynthesis,
              executionOutputs,
              formatOutputs('review'),
              availabilityAdaptation,
            ),
          );
          workflowNeedsAttention = Object.values(verificationEvent.delivery).some(delivery => (
            delivery.status !== 'completed'
          ));
        }
      }
      const verificationOutput = formatOutputs('verification');
      const ready = !workflowNeedsAttention
        && /^CHECKPOINT:\s*READY\b/im.test(verificationOutput);
      const checkpointEvent: CollaborationEvent = {
        id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        kind: 'system',
        authorId: 'system',
        recipientIds: ['user'],
        content: ready
          ? 'Human approval checkpoint: execution and cross-review completed. Review the evidence and approve the result or request changes.'
          : workflowNeedsAttention
            ? 'Human review required: the workflow produced a conflict, failure, or cancellation. Resolve pending items before continuing.'
            : 'Human review required: verification found unresolved changes.',
        createdAt: Date.now(),
        delivery: {},
        workflow: {
          id: workflow.id,
          deliberationId: workflow.deliberationId,
          phase: 'checkpoint',
        },
        resourceUsage: participantIds.map((participantId) => {
          const participant = room.participants.find(candidate => (
            getCollaborationParticipantId(candidate) === participantId
          ));
          const tab = participant && this.tabManager?.getAllTabs().find(candidate => (
            candidate.conversationId === participant.conversationId
          ));
          const usage = tab?.state.usage ?? (participant
            ? this.plugin.getConversationSync(participant.conversationId)?.usage
            : undefined);
          const contextTokens = usage?.contextTokens ?? 0;
          return {
            participantId,
            contextTokens,
            contextPercent: usage?.percentage ?? 0,
            contextTokenDelta: Math.max(
              0,
              contextTokens - (usageBaseline.get(participantId) ?? 0),
            ),
            turns: room.events.filter(event => (
              event.workflow?.id === workflow.id
              && event.authorId === 'system'
              && participantId in event.delivery
            )).length,
            weeklyUsagePercent: participant?.resourcePolicy?.weeklyUsagePercent,
          };
        }),
      };
      await this.plugin.storage.rooms.appendEvent(room.id, checkpointEvent);
      room.events.push(checkpointEvent);
      this.refreshCollaborationTimelines(room.id);
      return true;
    }

    if (discussionMode === 'deliberation') {
      const deliberationId = `deliberation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const allParticipantIds = routableParticipantIds;
      const synthesizerId = allParticipantIds.at(-1);
      const runPhase = async (
        phase: CollaborationDeliberationPhase,
        recipientIds: string[],
        strategy: 'parallel' | 'sequential',
      ): Promise<void> => {
        activeDeliberationId = deliberationId;
        activeDeliberationPhase = phase;
        const phaseTurn = await this.collaborationCoordinator.send(room, {
          content: phase === 'position'
            ? collaborationTurn.content
            : `${phase[0].toUpperCase()}${phase.slice(1)} phase`,
          recipientIds,
          attachments: phase === 'position' ? images : undefined,
          strategy,
          eventAuthorId: phase === 'position' ? 'user' : 'system',
          eventKind: phase === 'position' ? 'message' : 'system',
          eventMetadata: { deliberationId, deliberationPhase: phase },
          prepareContent: participant => buildDeliberationInstruction(
            room,
            phase,
            collaborationTurn.content,
            deliberationId,
            getCollaborationParticipantId(participant),
          ),
          dispatch,
        });
        room.events.push(structuredClone(phaseTurn.event));
        for (const participantId of recipientIds) {
          this.activeCollaborationDeliveries.set(
            this.getCollaborationDeliveryKey(room.id, participantId),
            phaseTurn.event.id,
          );
        }
        this.refreshCollaborationTimelines(room.id);
        await phaseTurn.completion;
        for (const participantId of recipientIds) {
          this.activeCollaborationDeliveries.delete(
            this.getCollaborationDeliveryKey(room.id, participantId),
          );
        }
        this.refreshCollaborationTimelines(room.id);
      };

      await runPhase(
        'position',
        allParticipantIds,
        sharedReferencedFiles.length > 0 ? 'sequential' : 'parallel',
      );
      await runPhase(
        'critique',
        allParticipantIds,
        sharedReferencedFiles.length > 0 ? 'sequential' : 'parallel',
      );
      if (synthesizerId) await runPhase('synthesis', [synthesizerId], 'sequential');
      await runPhase(
        'ratification',
        allParticipantIds,
        sharedReferencedFiles.length > 0 ? 'sequential' : 'parallel',
      );
      const consensus = evaluateDeliberationConsensus(
        room.events,
        deliberationId,
        allParticipantIds,
      );
      const synthesisEventId = [...room.events].reverse().find(event => (
        event.deliberationId === deliberationId
        && event.deliberationPhase === 'synthesis'
        && event.authorId !== 'system'
      ))?.id;
      const outcomeStatus = consensus.approved
        ? consensus.concerns.length > 0
          ? 'approved-with-concerns'
          : 'unanimous'
        : 'rejected';
      const finalEvent: CollaborationEvent = {
        id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        kind: 'system',
        authorId: 'system',
        recipientIds: ['user'],
        content: consensus.approved
          ? consensus.concerns.length > 0
            ? `Approved with non-blocking concerns from: ${consensus.concerns.join(', ')}.`
            : 'Unanimous approval: every participant explicitly approved the synthesis.'
          : `No consensus. Objections preserved from: ${
            consensus.objections.length > 0
              ? consensus.objections.join(', ')
              : consensus.missing.join(', ') || 'missing ratifications'
          }.`,
        createdAt: Date.now(),
        delivery: {},
        deliberationId,
        deliberationPhase: 'ratification',
        deliberationOutcome: {
          status: outcomeStatus,
          approvals: consensus.approvals,
          objections: consensus.objections,
          concerns: consensus.concerns,
          missing: consensus.missing,
          synthesisEventId,
        },
      };
      await this.plugin.storage.rooms.appendEvent(room.id, finalEvent);
      room.events.push(finalEvent);
      this.refreshCollaborationTimelines(room.id);
      return true;
    }

    const turn = await this.collaborationCoordinator.send(room, {
      content: collaborationTurn.content,
      recipientIds: collaborationTurn.recipientIds,
      recipientContent: collaborationTurn.recipientContent,
      attachments: images,
      strategy: discussionMode === 'round-table' || sharedReferencedFiles.length > 0
        ? 'sequential'
        : 'parallel',
      prepareContent: (participant, event) => buildCollaborationPrompt(
        room,
        getCollaborationParticipantId(participant),
        event.recipientContent?.[getCollaborationParticipantId(participant)] ?? event.content,
        { currentEventId: event.id },
      ),
      dispatch,
    });
    for (const participantId of collaborationTurn.recipientIds) {
      this.activeCollaborationDeliveries.set(
        this.getCollaborationDeliveryKey(room.id, participantId),
        turn.event.id,
      );
    }
    this.refreshCollaborationTimelines(room.id);
    void turn.completion.finally(() => {
      for (const participantId of collaborationTurn.recipientIds) {
        const key = this.getCollaborationDeliveryKey(room.id, participantId);
        if (this.activeCollaborationDeliveries.get(key) === turn.event.id) {
          this.activeCollaborationDeliveries.delete(key);
        }
      }
      this.refreshCollaborationTimelines(room.id);
    });
    return true;
  }

  private reconcileCollaborationTimelines(): Promise<void> {
    // Tab restoration and room creation can request reconciliation concurrently.
    // Serialize the work so two passes cannot both mount timelines into one tab.
    const previous = this.collaborationReconcileQueue ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => this.performCollaborationTimelineReconciliation());
    this.collaborationReconcileQueue = operation;
    return operation;
  }

  private startQuotaRefreshSchedule(): void {
    if (this.quotaRefreshInterval != null) return;
    void this.refreshOpenCollaborationQuotas(false);
    this.quotaRefreshInterval = window.setInterval(() => {
      void this.refreshOpenCollaborationQuotas(false);
    }, 5 * 60 * 1_000);
    (this.quotaRefreshInterval as unknown as { unref?: () => void }).unref?.();
  }

  private async refreshOpenCollaborationQuotas(announce: boolean): Promise<void> {
    const roomIds = new Set(
      (this.tabManager?.getAllTabs() ?? []).flatMap((tab) => {
        const membership = tab.conversationId
          ? this.plugin.getConversationSync(tab.conversationId)?.collaboration
          : undefined;
        return membership ? [membership.roomId] : [];
      }),
    );
    for (const roomId of roomIds) {
      const room = await this.plugin.storage.rooms.get(roomId);
      if (!room || room.status === 'archived') continue;
      await Promise.all(room.participants.map(participant => (
        this.refreshCollaborationParticipantQuota(
          roomId,
          getCollaborationParticipantId(participant),
          announce,
        ).catch(() => undefined)
      )));
      await this.reconcileCollaborationTimelines();
    }
  }

  private refreshCollaborationParticipantQuota(
    roomId: string,
    participantId: string,
    announce: boolean,
  ): Promise<void> {
    const key = `${roomId}:${participantId}`;
    this.quotaRefreshFlights ??= new Map();
    const existing = this.quotaRefreshFlights.get(key);
    if (existing) return existing;
    const operation = this.performCollaborationParticipantQuotaRefresh(
      roomId,
      participantId,
      announce,
    ).finally(() => {
      if (this.quotaRefreshFlights.get(key) === operation) {
        this.quotaRefreshFlights.delete(key);
      }
    });
    this.quotaRefreshFlights.set(key, operation);
    return operation;
  }

  private async performCollaborationParticipantQuotaRefresh(
    roomId: string,
    participantId: string,
    announce: boolean,
  ): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    const participant = room?.participants.find(candidate => (
      getCollaborationParticipantId(candidate) === participantId
    ));
    if (!room || !participant) throw new Error('Collaboration participant not found.');
    const participantTab = this.tabManager?.getAllTabs().find(candidate => (
      candidate.conversationId === participant.conversationId
    ));
    if (!participantTab) throw new Error('Participant tab is unavailable.');

    try {
      if (
        !participantTab.service
        || !participantTab.serviceInitialized
        || participantTab.service.runtimeProfileId !== participant.runtimeProfileId
      ) {
        await initializeTabService(participantTab, this.plugin);
        setupServiceCallbacks(participantTab, this.plugin);
      }
      const runtime = participantTab.service;
      if (!runtime?.getQuotaSnapshot) {
        throw new Error(`${participant.label ?? participantId} does not expose account quota.`);
      }
      let quotaSnapshot;
      try {
        await runtime.ensureReady();
        quotaSnapshot = await runtime.getQuotaSnapshot();
      } catch (initialError) {
        const conversation = this.plugin.getConversationSync(participant.conversationId);
        if (!conversation?.sessionId) throw initialError;
        runtime.resetSession();
        try {
          await runtime.ensureReady();
          quotaSnapshot = await runtime.getQuotaSnapshot();
        } finally {
          runtime.syncConversationState(
            conversation,
            conversation.externalContextPaths ?? [],
          );
        }
      }
      const latestRoom = await this.plugin.storage.rooms.get(roomId);
      const latestParticipant = latestRoom?.participants.find(candidate => (
        getCollaborationParticipantId(candidate) === participantId
      ));
      const currentPolicy = latestParticipant?.resourcePolicy ?? participant.resourcePolicy;
      const weeklyWindow = quotaSnapshot.windows.find(window => (
        window.id === 'seven-day' || window.id === 'secondary'
      ));
      await this.plugin.storage.rooms.updateParticipantResourcePolicy(
        roomId,
        participantId,
        {
          mode: currentPolicy?.mode ?? 'active',
          weeklyUsagePercent: weeklyWindow?.utilizationPercent
            ?? currentPolicy?.weeklyUsagePercent,
          quotaSnapshot,
          quotaHistory: appendQuotaHistory(currentPolicy?.quotaHistory, {
            fetchedAt: quotaSnapshot.fetchedAt,
            windows: quotaSnapshot.windows.map(window => ({ ...window })),
          }),
        },
      );
      if (announce) {
        new Notice(
          quotaSnapshot.windows.length > 0
            ? `${participant.label ?? participantId} quota refreshed.`
            : quotaSnapshot.unavailableReason ?? 'Provider quota is unavailable.',
        );
      }
    } catch (error) {
      const latestRoom = await this.plugin.storage.rooms.get(roomId);
      const latestParticipant = latestRoom?.participants.find(candidate => (
        getCollaborationParticipantId(candidate) === participantId
      ));
      const message = error instanceof Error ? error.message : 'Could not refresh provider quota.';
      await this.plugin.storage.rooms.updateParticipantResourcePolicy(
        roomId,
        participantId,
        {
          ...(latestParticipant?.resourcePolicy ?? participant.resourcePolicy ?? { mode: 'active' }),
          quotaRefreshError: message,
        },
      );
      if (announce) new Notice(message);
      throw error;
    }
  }

  private async performCollaborationTimelineReconciliation(): Promise<void> {
    // Some lightweight test hosts construct the view without running field initializers.
    if (!this.collaborationTimelines) return;
    const tabs = this.tabManager?.getAllTabs() ?? [];
    // Rebuild from the complete room roster. Room creation opens participants
    // sequentially, so retaining an early timeline can leave later agents absent.
    for (const timeline of this.collaborationTimelines.values()) timeline.destroy();
    this.collaborationTimelines.clear();
    // Sweep orphaned roots left by an interrupted or older concurrent pass.
    for (const tab of tabs) {
      for (const root of tab.dom.contentEl.querySelectorAll('.claudian-collaboration')) {
        root.remove();
      }
    }

    const tabsByRoom = new Map<string, TabData[]>();
    for (const tab of tabs) {
      if (!tab.conversationId) continue;
      const membership = this.plugin.getConversationSync(tab.conversationId)?.collaboration;
      if (!membership) continue;
      const roomTabs = tabsByRoom.get(membership.roomId) ?? [];
      roomTabs.push(tab);
      tabsByRoom.set(membership.roomId, roomTabs);
    }

    for (const [roomId, roomTabs] of tabsByRoom) {
      let room = await this.plugin.storage.rooms.get(roomId);
      if (!room) {
        const membership = roomTabs
          .map(tab => (
            tab.conversationId
              ? this.plugin.getConversationSync(tab.conversationId)?.collaboration
              : null
          ))
          .find(candidate => candidate?.roomId === roomId);
        if (!membership) continue;
        room = await this.plugin.storage.rooms.create({
          id: roomId,
          title: 'Claude Personal + Claude Company + Codex',
          participants: Object.entries(membership.conversationIds).map(
            ([participantId, conversationId]) => ({
              id: participantId,
              providerId: participantId.startsWith('claude-') ? 'claude' : participantId,
              label: participantId === 'claude-personal'
                ? 'Claude Personal'
                : participantId === 'claude-company'
                  ? 'Claude Company'
                  : ProviderRegistry.getProviderDisplayName(participantId),
              runtimeProfileId: participantId === 'claude-personal'
                ? 'personal'
                : participantId === 'claude-company'
                  ? 'company'
                  : undefined,
              conversationId,
            }),
          ),
        });
      }
      const conversationProfiles = room.participants.flatMap((participant) => {
        const conversation = this.plugin.getConversationSync(participant.conversationId);
        return conversation
          ? [{ id: conversation.id, runtimeProfileId: conversation.runtimeProfileId }]
          : [];
      });
      for (const repair of findCollaborationProfileRepairs(room, conversationProfiles)) {
        await this.plugin.updateConversation(repair.conversationId, {
          runtimeProfileId: repair.runtimeProfileId,
        });
      }
      const tabIdentities = tabs.map(tab => ({
        tabId: tab.id,
        providerId: tab.providerId,
        runtimeProfileId: tab.conversationId
          ? this.plugin.getConversationSync(tab.conversationId)?.runtimeProfileId
          : undefined,
        conversationId: tab.conversationId,
        roomId: tab.conversationId
          ? this.plugin.getConversationSync(tab.conversationId)?.collaboration?.roomId ?? null
          : null,
      }));
      for (const candidate of findCollaborationRebindCandidates(room, tabIdentities)) {
        room = await this.rebindCollaborationParticipant(
          room.id,
          candidate.participantId,
          candidate.conversationId,
        );
        const replacementTab = tabs.find(tab => tab.id === candidate.tabId);
        if (replacementTab && !roomTabs.includes(replacementTab)) roomTabs.push(replacementTab);
      }
      if (roomTabs.length < 2) continue;
      for (const tab of roomTabs) {
        this.collaborationTimelines.set(tab.id, new CollaborationTimeline({
          component: this,
          hostTab: tab,
          participantTabs: roomTabs,
          participantLabels: Object.fromEntries(room.participants.map(participant => [
            getCollaborationParticipantId(participant),
            participant.label ?? ProviderRegistry.getProviderDisplayName(participant.providerId),
          ])),
          participantResourcePolicies: Object.fromEntries(room.participants.map(participant => [
            getCollaborationParticipantId(participant),
            participant.resourcePolicy,
          ])),
          participantUsageSnapshots: Object.fromEntries(room.participants.map((participant) => {
            const participantId = getCollaborationParticipantId(participant);
            const usage = [...room.events].reverse()
              .flatMap(event => event.resourceUsage ?? [])
              .find(candidate => candidate.participantId === participantId);
            return [participantId, usage];
          })),
          plugin: this.plugin,
          roomId,
          discussionMode: room.discussionMode ?? 'parallel',
          onDiscussionModeChange: async (mode) => {
            await this.plugin.storage.rooms.updateDiscussionMode(roomId, mode);
            new Notice(
              mode === 'round-table'
                ? 'Round table: agents respond sequentially with shared context.'
                : mode === 'parallel'
                  ? 'Parallel: agents respond together and share context next turn.'
                  : mode === 'deliberation'
                    ? 'Deliberation: independent positions through explicit ratification.'
                    : 'Mentions: only selected agents respond.',
            );
          },
          canStop: providerId => this.activeCollaborationDeliveries.has(
            this.getCollaborationDeliveryKey(roomId, providerId),
          ),
          onStop: providerId => this.stopCollaborationDelivery(roomId, providerId),
          onRetry: async (providerId, content) => {
            await this.routeCollaborationMessage(tab.id, `@${providerId} ${content}`);
          },
          onOpenFile: async (path) => {
            await this.plugin.app.workspace.openLinkText(path, '', false);
          },
          onKeepCurrent: async (eventId) => {
            await this.resolveCollaborationConflict(roomId, eventId, 'kept-current');
            await this.appendCollaborationWorkspaceEvent(
              roomId,
              'Kept the current workspace state. Pending edit proposals were dismissed.',
            );
          },
          onResolve: async (eventId, providerId, content, conflictFiles) => {
            const fileList = conflictFiles.join(', ');
            await this.routeCollaborationMessage(
              tab.id,
              `@${providerId} Resolve the collaboration conflict in ${fileList}. Re-read ${
                conflictFiles.length === 1 ? 'the file' : 'each file'
              } immediately before editing. Apply your originally requested change to the current version, even if the original source text has changed. Preserve unrelated content and report exactly what you changed.\n\nOriginal request:\n${content}`,
            );
            await this.resolveCollaborationConflict(
              roomId,
              eventId,
              'applied-proposal',
              providerId,
              providerId,
            );
          },
          onApplyProposal: async (eventId, providerId, selectedHunks) => {
            const currentRoom = await this.plugin.storage.rooms.get(roomId);
            const delivery = currentRoom?.events
              .find(event => event.id === eventId)
              ?.delivery[providerId];
            if (!delivery?.fileProposals?.length) {
              throw new Error('File proposal not found');
            }
            for (const proposal of delivery.fileProposals) {
              if ((selectedHunks[proposal.path]?.length ?? 0) === 0) continue;
              const currentContent = await this.plugin.app.vault.adapter.read(proposal.path);
              const currentStat = await this.plugin.app.vault.adapter.stat(proposal.path);
              const currentRevision = createCollaborationFileRevision(
                currentStat?.mtime ?? -1,
                currentStat?.size ?? currentContent.length,
                currentContent,
              );
              if (currentRevision !== proposal.currentRevision) {
                new Notice(`${proposal.path} changed again. Rebase the proposal instead.`);
                return;
              }
            }
            const applied: string[] = [];
            for (const proposal of delivery.fileProposals) {
              const selected = new Set(selectedHunks[proposal.path] ?? []);
              if (selected.size === 0) continue;
              const acceptedContent = proposal.acceptedContent;
              const review = acceptedContent === undefined ? null
                : createCollaborationProposalReview(
                  acceptedContent,
                  proposal.proposedContent,
                );
              const nextContent = acceptedContent === undefined || review === null
                ? proposal.proposedContent
                : applyCollaborationProposalHunks(
                  acceptedContent,
                  review.hunks,
                  selected,
                );
              await this.plugin.app.vault.adapter.write(
                proposal.path,
                nextContent,
              );
              applied.push(
                review
                  ? `${proposal.path} (${selected.size} of ${review.hunks.length} changes)`
                  : `${proposal.path} (whole file)`,
              );
            }
            if (applied.length === 0) return;
            await this.resolveCollaborationConflict(
              roomId,
              eventId,
              'applied-proposal',
              providerId,
              providerId,
            );
            const proposalParticipant = room.participants.find(participant => (
              getCollaborationParticipantId(participant) === providerId
            ));
            const providerLabel = proposalParticipant?.label
              ?? ProviderRegistry.getProviderDisplayName(
                proposalParticipant?.providerId ?? providerId,
              );
            await this.appendCollaborationWorkspaceEvent(
              roomId,
              `Accepted workspace state from ${providerLabel}: ${applied.join(', ')}.`,
            );
            new Notice(`${providerLabel} proposal applied.`);
          },
          onStartApprovedPlan: async (deliberationId) => {
            await this.startApprovedCollaborationPlan(tab.id, roomId, deliberationId);
          },
          onCreateWorkQueue: async (deliberationId) => {
            await this.createCollaborationWorkQueue(roomId, deliberationId);
          },
          onApproveWorkQueue: async () => {
            await this.approveCollaborationWorkQueue(roomId);
          },
          onRunWorkTask: async (taskId) => {
            try {
              await this.runCollaborationWorkTask(tab.id, roomId, taskId);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : `Could not run ${taskId}`);
              throw error;
            }
          },
          onRetryWorkTask: async (taskId) => {
            try {
              await this.retryCollaborationWorkTask(roomId, taskId);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : `Could not retry ${taskId}`);
              throw error;
            }
          },
          onRecoverWorkTask: async (taskId) => {
            try {
              await this.recoverCollaborationWorkTask(roomId, taskId);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : `Could not recover ${taskId}`);
              throw error;
            }
          },
          onSetWorkQueuePaused: async (paused) => {
            try {
              await this.setCollaborationWorkQueuePaused(roomId, paused);
            } catch (error) {
              new Notice(error instanceof Error ? error.message : 'Could not update the queue');
              throw error;
            }
          },
          onUpdateDraftTaskAssignment: async (taskId, ownerId, reviewerId) => {
            try {
              await this.updateCollaborationDraftTaskAssignment(
                roomId,
                taskId,
                ownerId,
                reviewerId,
              );
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : `Could not reassign ${taskId}`,
              );
              throw error;
            }
          },
          onUpdateDraftTaskContract: async (taskId, patch) => {
            try {
              await this.updateCollaborationDraftTaskContract(roomId, taskId, patch);
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : `Could not update ${taskId}`,
              );
              throw error;
            }
          },
          onApproveCompletedWorkQueue: async () => {
            try {
              await this.approveCompletedCollaborationWorkQueue(roomId);
            } catch (error) {
              new Notice(
                error instanceof Error ? error.message : 'Could not approve the completed queue',
              );
              throw error;
            }
          },
          onRetryApprovedPlan: async (deliberationId) => {
            await this.startApprovedCollaborationPlan(
              tab.id,
              roomId,
              deliberationId,
              true,
            );
          },
          onApproveWorkflow: async (workflowId, deliberationId) => {
            await this.appendCollaborationWorkflowDecision(
              roomId,
              workflowId,
              deliberationId,
              'approved',
              'Result approved by the user. Autonomous workflow complete.',
            );
          },
          onRequestWorkflowChanges: async (workflowId, deliberationId) => {
            await this.appendCollaborationWorkflowDecision(
              roomId,
              workflowId,
              deliberationId,
              'changes-requested',
              'The user requested changes. The workflow is paused for direction.',
            );
            tab.dom.inputEl.value = '@all Changes requested: ';
            tab.dom.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            tab.dom.inputEl.focus();
          },
          onEditResourcePolicy: (participantId) => {
            const participant = room.participants.find(candidate => (
              getCollaborationParticipantId(candidate) === participantId
            ));
            if (!participant) return;
            new CollaborationResourcePolicyModal(
              this.plugin,
              participant.label ?? ProviderRegistry.getProviderDisplayName(
                participant.providerId,
              ),
              participant.resourcePolicy,
              (policy) => {
                void this.plugin.storage.rooms.updateParticipantResourcePolicy(
                  roomId,
                  participantId,
                  policy,
                )
                  .then(() => this.reconcileCollaborationTimelines())
                  .catch((error) => {
                    new Notice(
                      error instanceof Error
                        ? error.message
                        : 'Could not update usage policy.',
                    );
                  });
              },
              async () => {
                await this.refreshCollaborationParticipantQuota(
                  roomId,
                  participantId,
                  true,
                );
                await this.reconcileCollaborationTimelines();
              },
            ).open();
          },
          onApplyQuotaRecommendation: async (participantId) => {
            const latestRoom = await this.plugin.storage.rooms.get(roomId);
            const latestParticipant = latestRoom?.participants.find(candidate => (
              getCollaborationParticipantId(candidate) === participantId
            ));
            if (!latestParticipant) throw new Error('Collaboration participant not found.');
            await this.plugin.storage.rooms.updateParticipantResourcePolicy(
              roomId,
              participantId,
              {
                ...(latestParticipant.resourcePolicy ?? {}),
                mode: 'preserve',
              },
            );
            await this.reconcileCollaborationTimelines();
            new Notice(`${latestParticipant.label ?? participantId} set to preserve mode.`);
          },
          onOpenUsageDashboard: () => {
            new CollaborationUsageDashboardModal(this.plugin, {
              roomId,
              loadRoom: () => this.plugin.storage.rooms.get(roomId),
              refreshAll: async () => {
                const latestRoom = await this.plugin.storage.rooms.get(roomId);
                if (!latestRoom) return;
                await Promise.all(latestRoom.participants.map(participant => (
                  this.refreshCollaborationParticipantQuota(
                    roomId,
                    getCollaborationParticipantId(participant),
                    false,
                  ).catch(() => undefined)
                )));
                await this.reconcileCollaborationTimelines();
              },
              applyRecommendation: async (participantId) => {
                const latestRoom = await this.plugin.storage.rooms.get(roomId);
                const latestParticipant = latestRoom?.participants.find(candidate => (
                  getCollaborationParticipantId(candidate) === participantId
                ));
                if (!latestParticipant) return;
                await this.plugin.storage.rooms.updateParticipantResourcePolicy(
                  roomId,
                  participantId,
                  {
                    ...(latestParticipant.resourcePolicy ?? {}),
                    mode: 'preserve',
                  },
                );
                await this.reconcileCollaborationTimelines();
              },
            }).open();
          },
          onReview: async (reviewerId, sourceProviderId, content) => {
            const sourceParticipant = room.participants.find(participant => (
              getCollaborationParticipantId(participant) === sourceProviderId
            ));
            const sourceLabel = sourceParticipant?.label
              ?? (sourceParticipant
                ? ProviderRegistry.getProviderDisplayName(sourceParticipant.providerId)
                : sourceProviderId);
            await this.routeCollaborationMessage(
              tab.id,
              `@${reviewerId} Review this response from ${sourceLabel}. Identify errors, omissions, and concrete improvements.\n\n${content}`,
            );
          },
        }));
      }
    }
    this.updateTabBar();
  }

  private async resolveCollaborationConflict(
    roomId: string,
    eventId: string,
    resolution: 'kept-current' | 'applied-proposal',
    resolutionProviderId?: string,
    targetProviderId?: string,
  ): Promise<void> {
    const currentRoom = await this.plugin.storage.rooms.get(roomId);
    const event = currentRoom?.events.find(candidate => candidate.id === eventId);
    if (!event) throw new Error(`Collaboration event not found: ${eventId}`);

    await Promise.all(Object.entries(event.delivery).map(async ([providerId, delivery]) => {
      if (delivery.status !== 'conflict') return;
      if (targetProviderId && providerId !== targetProviderId) return;
      await this.plugin.storage.rooms.updateDelivery(roomId, eventId, providerId, {
        ...delivery,
        status: 'resolved',
        resolution,
        resolutionProviderId,
      });
    }));
    this.refreshCollaborationTimelines(roomId);
  }

  private async appendCollaborationWorkspaceEvent(
    roomId: string,
    content: string,
  ): Promise<void> {
    await this.plugin.storage.rooms.appendEvent(roomId, {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      kind: 'system',
      authorId: 'system',
      recipientIds: ['user'],
      content,
      createdAt: Date.now(),
      delivery: {},
    });
    this.refreshCollaborationTimelines(roomId);
  }

  private async createCollaborationWorkQueue(
    roomId: string,
    deliberationId: string,
  ): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room) throw new Error('Collaboration room not found');
    const outcome = [...room.events].reverse().find(event => (
      event.deliberationId === deliberationId && event.deliberationOutcome
    ));
    if (!outcome?.deliberationOutcome || outcome.deliberationOutcome.status === 'rejected') {
      throw new Error('The plan is not approved');
    }
    const synthesis = room.events.find(event => (
      event.id === outcome.deliberationOutcome?.synthesisEventId
    ));
    if (!synthesis) throw new Error('Approved synthesis not found');
    try {
      const queue = parseCollaborationTaskGraph(synthesis.content, deliberationId);
      await this.plugin.storage.rooms.updateWorkQueue(roomId, queue);
      new Notice('Draft task queue created. Review it before approval.');
      this.refreshCollaborationTimelines(roomId);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not create task queue');
      throw error;
    }
  }

  private async approveCollaborationWorkQueue(roomId: string): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    try {
      const queue = approveCollaborationWorkQueue(
        room.workQueue,
        room.participants
          .filter(participant => participant.resourcePolicy?.mode !== 'unavailable')
          .map(getCollaborationParticipantId),
      );
      await this.plugin.storage.rooms.updateWorkQueue(
        roomId,
        queue,
        room.workQueue.updatedAt,
      );
      new Notice('Task queue approved. Unblocked tasks are ready.');
      this.refreshCollaborationTimelines(roomId);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Queue validation failed');
      throw error;
    }
  }

  private async runCollaborationWorkTask(
    originTabId: TabId,
    roomId: string,
    taskId: string,
  ): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    const task = room.workQueue.tasks.find(candidate => candidate.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const owner = room.participants.find(candidate => (
      getCollaborationParticipantId(candidate) === task.ownerId
    ));
    const reviewer = room.participants.find(candidate => (
      getCollaborationParticipantId(candidate) === task.reviewerId
    ));
    if (!owner || !reviewer) throw new Error('Task owner or reviewer is unavailable');
    if (owner.resourcePolicy?.mode === 'unavailable') {
      new Notice(`${task.ownerId} is unavailable. Reassign the task before running it.`);
      return;
    }
    if (reviewer.resourcePolicy?.mode === 'unavailable') {
      new Notice(`${task.reviewerId} is unavailable. Reassign the reviewer before running it.`);
      return;
    }
    const running = transitionCollaborationTask(
      room.workQueue,
      taskId,
      'running',
      { actorId: task.ownerId },
    );
    await this.plugin.storage.rooms.updateWorkQueue(
      roomId,
      running,
      room.workQueue.updatedAt,
    );
    this.refreshCollaborationTimelines(roomId);
    const synthesis = room.events.find(event => (
      event.deliberationId === room.workQueue?.sourceDeliberationId
      && event.deliberationPhase === 'synthesis'
      && event.authorId !== 'system'
    ));
    const original = room.events.find(event => (
      event.deliberationId === room.workQueue?.sourceDeliberationId
      && event.deliberationPhase === 'position'
      && event.authorId === 'user'
    ));
    const workflowId = `task-${task.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    new Notice(`${task.id} started with ${task.ownerId}; ${task.reviewerId} will review.`);
    const failStartedTask = async (reason: string): Promise<void> => {
      const latest = await this.plugin.storage.rooms.get(roomId);
      if (latest?.workQueue) {
        const latestTask = latest.workQueue.tasks.find(candidate => candidate.id === taskId);
        if (latestTask?.status === 'running' || latestTask?.status === 'review') {
          const failed = transitionCollaborationTask(
            latest.workQueue,
            taskId,
            'failed',
            { actorId: task.reviewerId, failureReason: reason },
          );
          await this.plugin.storage.rooms.updateWorkQueue(
            roomId,
            failed,
            latest.workQueue.updatedAt,
          );
          this.refreshCollaborationTimelines(roomId);
        }
      }
    };
    let handled: boolean;
    try {
      handled = await this.routeCollaborationMessage(
        originTabId,
        `@${task.ownerId} @${task.reviewerId} Execute queue task ${task.id}`,
        undefined,
        {
          id: workflowId,
          deliberationId: room.workQueue.sourceDeliberationId,
          originalGoal: original?.content ?? task.description,
          approvedSynthesis: synthesis?.content ?? task.description,
          taskId,
        },
      );
    } catch (error) {
      await failStartedTask(
        error instanceof Error ? error.message : `Could not dispatch ${task.id}`,
      );
      throw error;
    }
    if (!handled) {
      await failStartedTask(`Could not route ${task.id}`);
      throw new Error(`Could not route ${task.id}`);
    }
  }

  private async retryCollaborationWorkTask(roomId: string, taskId: string): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    const task = room.workQueue.tasks.find(candidate => candidate.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const ready = transitionCollaborationTask(
      room.workQueue,
      taskId,
      'ready',
      { actorId: task.ownerId },
    );
    await this.plugin.storage.rooms.updateWorkQueue(
      roomId,
      ready,
      room.workQueue.updatedAt,
    );
    new Notice(`${taskId} is ready for retry (${task.attempts}/${task.maxAttempts} used).`);
    this.refreshCollaborationTimelines(roomId);
  }

  private async recoverCollaborationWorkTask(roomId: string, taskId: string): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    const task = room.workQueue.tasks.find(candidate => candidate.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'running' && task.status !== 'review') {
      throw new Error(`${taskId} is not interrupted`);
    }
    const participantId = task.status === 'running' ? task.ownerId : task.reviewerId;
    if (this.activeCollaborationDeliveries.has(
      this.getCollaborationDeliveryKey(roomId, participantId),
    )) {
      throw new Error(`${taskId} is still active; stop the agent before recovery`);
    }
    const failed = transitionCollaborationTask(
      room.workQueue,
      taskId,
      'failed',
      {
        actorId: 'system',
        failureReason: `Interrupted during ${task.status}; no active delivery was found.`,
      },
    );
    await this.plugin.storage.rooms.updateWorkQueue(
      roomId,
      failed,
      room.workQueue.updatedAt,
    );
    new Notice(`${taskId} recovered as failed. Retry it when ready.`);
    this.refreshCollaborationTimelines(roomId);
  }

  private async setCollaborationWorkQueuePaused(
    roomId: string,
    paused: boolean,
  ): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    const queue = setCollaborationWorkQueuePaused(room.workQueue, paused);
    await this.plugin.storage.rooms.updateWorkQueue(
      roomId,
      queue,
      room.workQueue.updatedAt,
    );
    new Notice(
      paused
        ? 'Task scheduling paused. Active execution and review will continue.'
        : 'Task scheduling resumed.',
    );
    this.refreshCollaborationTimelines(roomId);
  }

  private async updateCollaborationDraftTaskAssignment(
    roomId: string,
    taskId: string,
    ownerId: string,
    reviewerId: string,
  ): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    const queue = updateCollaborationDraftTaskAssignment(
      room.workQueue,
      taskId,
      ownerId,
      reviewerId,
      room.participants
        .filter(participant => participant.resourcePolicy?.mode !== 'unavailable')
        .map(getCollaborationParticipantId),
    );
    await this.plugin.storage.rooms.updateWorkQueue(
      roomId,
      queue,
      room.workQueue.updatedAt,
    );
    this.refreshCollaborationTimelines(roomId);
  }

  private async updateCollaborationDraftTaskContract(
    roomId: string,
    taskId: string,
    patch: CollaborationDraftTaskContractUpdate,
  ): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    const queue = updateCollaborationDraftTaskContract(
      room.workQueue,
      taskId,
      patch,
    );
    await this.plugin.storage.rooms.updateWorkQueue(
      roomId,
      queue,
      room.workQueue.updatedAt,
    );
    this.refreshCollaborationTimelines(roomId);
  }

  private async approveCompletedCollaborationWorkQueue(roomId: string): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room?.workQueue) throw new Error('Work queue not found');
    const queue = approveCompletedCollaborationWorkQueue(room.workQueue);
    await this.plugin.storage.rooms.updateWorkQueue(
      roomId,
      queue,
      room.workQueue.updatedAt,
    );
    await this.plugin.storage.rooms.appendEvent(roomId, {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      kind: 'system',
      authorId: 'system',
      recipientIds: ['user'],
      content: 'Completed task queue approved by the user after evidence review.',
      createdAt: Date.now(),
      delivery: {},
    });
    new Notice('Completed queue approved.');
    this.refreshCollaborationTimelines(roomId);
  }

  private async startApprovedCollaborationPlan(
    originTabId: TabId,
    roomId: string,
    deliberationId: string,
    allowRetry = false,
  ): Promise<void> {
    const room = await this.plugin.storage.rooms.get(roomId);
    if (!room) throw new Error('Collaboration room not found');
    const outcomeEvent = [...room.events].reverse().find(event => (
      event.deliberationId === deliberationId && event.deliberationOutcome
    ));
    if (
      !outcomeEvent?.deliberationOutcome
      || outcomeEvent.deliberationOutcome.status === 'rejected'
    ) {
      throw new Error('The plan is not approved');
    }
    if (
      !allowRetry
      && room.events.some(event => event.workflow?.deliberationId === deliberationId)
    ) {
      new Notice('This approved plan has already started.');
      return;
    }
    const synthesisEvent = room.events.find(event => (
      event.id === outcomeEvent.deliberationOutcome?.synthesisEventId
    )) ?? [...room.events].reverse().find(event => (
      event.deliberationId === deliberationId
      && event.deliberationPhase === 'synthesis'
      && event.authorId !== 'system'
    ));
    const originalEvent = room.events.find(event => (
      event.deliberationId === deliberationId
      && event.deliberationPhase === 'position'
      && event.authorId === 'user'
    ));
    if (!synthesisEvent || !originalEvent) {
      throw new Error('Approved plan context is incomplete');
    }
    const activeParticipantIds = getRoutableCollaborationParticipantIds(
      room,
      originalEvent.content,
      true,
    );
    if (activeParticipantIds.length < 2) {
      new Notice('Autonomous workflows require at least two active agents for cross-review.');
      throw new Error('Not enough active agents for autonomous cross-review');
    }
    const workflowId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    new Notice('Approved plan started. The room will stop at a human review checkpoint.');
    await this.routeCollaborationMessage(
      originTabId,
      originalEvent.content,
      undefined,
      {
        id: workflowId,
        deliberationId,
        originalGoal: originalEvent.content,
        approvedSynthesis: synthesisEvent.content,
      },
    );
  }

  private async appendCollaborationWorkflowDecision(
    roomId: string,
    workflowId: string,
    deliberationId: string,
    decision: 'approved' | 'changes-requested',
    content: string,
  ): Promise<void> {
    await this.plugin.storage.rooms.appendEvent(roomId, {
      id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      kind: 'system',
      authorId: 'system',
      recipientIds: ['user'],
      content,
      createdAt: Date.now(),
      delivery: {},
      workflow: {
        id: workflowId,
        deliberationId,
        phase: 'checkpoint',
      },
      workflowDecision: decision,
    });
    this.refreshCollaborationTimelines(roomId);
  }

  private async handleTabConversationRebind(
    tabId: TabId,
    conversationId: string | null,
    previousConversationId: string | null,
  ): Promise<void> {
    const previousMembership = previousConversationId
      ? this.plugin.getConversationSync(previousConversationId)?.collaboration
      : null;
    if (conversationId && previousMembership) {
      await this.rebindCollaborationParticipant(
        previousMembership.roomId,
        previousMembership.participantId,
        conversationId,
      );
    }
    await this.reconcileCollaborationTimelines();
    this.collaborationTimelines.get(tabId)?.refresh();
  }

  private async rebindCollaborationParticipant(
    roomId: string,
    participantId: string,
    conversationId: string,
  ) {
    const room = await this.plugin.storage.rooms.updateParticipantConversation(
      roomId,
      participantId,
      conversationId,
    );
    const conversationIds = Object.fromEntries(
      room.participants.map(participant => [
        getCollaborationParticipantId(participant),
        participant.conversationId,
      ]),
    );
    const memberships = createCollaborationMemberships(room.id, conversationIds);
    await Promise.all(room.participants.map(participant => (
      this.plugin.updateConversation(participant.conversationId, {
        collaboration: memberships[getCollaborationParticipantId(participant)],
      })
    )));
    return room;
  }

  private stopCollaborationDelivery(roomId: string, participantId: string): void {
    const key = this.getCollaborationDeliveryKey(roomId, participantId);
    const eventId = this.activeCollaborationDeliveries.get(key);
    if (!eventId) return;
    this.collaborationCoordinator.cancel(roomId, eventId, participantId);
  }

  private getCollaborationDeliveryKey(roomId: string, participantId: string): string {
    return `${roomId}:${participantId}`;
  }

  private refreshCollaborationTimelines(roomId: string): void {
    if (!this.collaborationTimelines) return;
    for (const tab of this.tabManager?.getAllTabs() ?? []) {
      if (!tab.conversationId) continue;
      const membership = this.plugin.getConversationSync(tab.conversationId)?.collaboration;
      if (membership?.roomId === roomId) {
        this.collaborationTimelines.get(tab.id)?.refresh();
      }
    }
  }

  private refreshAllCollaborationTimelines(): void {
    for (const timeline of this.collaborationTimelines?.values() ?? []) timeline.refresh();
  }

  private updateTabBar(): void {
    if (!this.tabManager || !this.tabBar) return;

    // Debounce tab bar updates using requestAnimationFrame
    if (this.pendingTabBarUpdate !== null) {
      cancelScheduledAnimationFrame(this.pendingTabBarUpdate);
    }

    this.pendingTabBarUpdate = scheduleAnimationFrame(() => {
      this.pendingTabBarUpdate = null;
      if (!this.tabManager || !this.tabBar) return;

      const items = this.getVisibleTabBarItems();
      this.tabBar.update(items);
      this.updateTabBarVisibility();
    }, this.containerEl.ownerDocument.defaultView ?? null);
  }

  private updateTabBarVisibility(): void {
    if (!this.tabBarContainerEl || !this.tabManager) return;

    const showTabBar = this.tabManager.getTabCount() >= 2;

    this.tabBarContainerEl.toggleClass('claudian-hidden', !showTabBar);

    this.updateNewTabButtonVisibility();
  }

  private getVisibleTabBarItems(): TabBarItem[] {
    if (!this.tabManager) return [];
    if (typeof this.tabManager.getTabBarItems !== 'function') return [];
    return groupCollaborationTabBarItems(this.tabManager.getTabBarItems(), (tabId) => {
      const item = this.tabManager?.getTab(tabId);
      if (!item?.conversationId) return null;
      return this.plugin.getConversationSync(item.conversationId)?.collaboration?.roomId ?? null;
    });
  }

  private updateNewTabButtonVisibility(): void {
    if (!this.newTabButtonEl || !this.tabManager) return;

    const canCreateTab = this.tabManager.canCreateTab();
    this.newTabButtonEl.toggleClass('claudian-hidden', !canCreateTab);
    if (canCreateTab) {
      this.newTabButtonEl.removeAttribute('aria-disabled');
      this.newTabButtonEl.removeAttribute('aria-hidden');
      return;
    }

    this.newTabButtonEl.setAttribute('aria-disabled', 'true');
    this.newTabButtonEl.setAttribute('aria-hidden', 'true');
  }

  /** Sets `data-provider` on the root container so CSS brand color follows the active provider. */
  private syncProviderBrandColor(): void {
    if (!this.viewContainerEl) return;
    const activeTab = this.tabManager?.getActiveTab();
    const providerId = activeTab ? getTabProviderId(activeTab, this.plugin) : DEFAULT_CHAT_PROVIDER_ID;
    this.viewContainerEl.dataset.provider = providerId;
  }

  // ============================================
  // History Dropdown
  // ============================================

  private toggleHistoryDropdown(): void {
    if (!this.historyDropdown) return;

    const isVisible = this.historyDropdown.hasClass('visible');
    if (isVisible) {
      this.historyDropdown.removeClass('visible');
      this.cancelHistoryRendering();
    } else {
      this.historyDropdown.addClass('visible');
      this.renderHistoryDropdown();
    }
  }

  private historyDropdownDirty = true;
  private historyDropdownRendered = false;

  private updateHistoryDropdown(): void {
    this.historyDropdownDirty = true;
    if (this.historyDropdown?.hasClass('visible')) {
      this.renderHistoryDropdown();
    }
  }

  private renderHistoryDropdown(): void {
    if (!this.historyDropdown || !this.historyDropdownDirty) return;

    this.cancelHistoryRendering();
    const abortController = new AbortController();
    this.historyRenderAbortController = abortController;

    const span = this.historyDropdownRendered ? null : StartupProfiler.start('history-list-render');
    this.historyDropdownRendered = true;

    try {
      this.historyDropdown.empty();

      const activeTab = this.tabManager?.getActiveTab();
      const conversationController = activeTab?.controllers.conversationController;

      if (conversationController) {
        conversationController.renderHistoryDropdown(this.historyDropdown, {
          onSelectConversation: (id) => this.openHistoryConversation(id),
          onOpenConversationInNewTab: (id, activate) =>
            this.openHistoryConversationInNewTab(id, activate),
          getConversationStatus: (id) => this.getHistoryConversationStatus(id),
          signal: abortController.signal,
        });
      }
      this.historyDropdownDirty = false;
    } finally {
      if (span) {
        StartupProfiler.finish(span);
      }
    }
  }

  private async openHistoryConversation(conversationId: string): Promise<void> {
    await this.tabManager?.openConversation(conversationId);
    this.historyDropdown?.removeClass('visible');
    this.cancelHistoryRendering();
  }

  private async openHistoryConversationInNewTab(
    conversationId: string,
    activate = true,
  ): Promise<void> {
    await this.tabManager?.openConversation(conversationId, {
      preferNewTab: true,
      activate,
    });
    this.historyDropdown?.removeClass('visible');
    this.cancelHistoryRendering();
  }

  private cancelHistoryRendering(): void {
    this.historyRenderAbortController?.abort();
    this.historyRenderAbortController = null;
  }

  private getHistoryConversationStatus(conversationId: string): HistoryConversationStatus {
    const activeTab = this.tabManager?.getActiveTab();
    if (activeTab?.conversationId === conversationId) {
      return {
        openState: 'current',
        isRunning: activeTab.state.isStreaming,
        location: 'current-view',
        tabIndex: this.getHistoryTabIndex(activeTab),
      };
    }

    const localTab = this.findTabWithConversation(conversationId);
    if (localTab) {
      return {
        openState: 'open',
        isRunning: localTab.state.isStreaming,
        location: 'current-view',
        tabIndex: this.getHistoryTabIndex(localTab),
      };
    }

    const crossViewResult = this.plugin.findConversationAcrossViews(conversationId);
    if (crossViewResult && crossViewResult.view !== this) {
      const crossViewTab = crossViewResult.view.getTabManager()?.getTab(crossViewResult.tabId);
      return {
        openState: 'open',
        isRunning: crossViewTab?.state.isStreaming ?? false,
        location: 'other-view',
      };
    }

    return {
      openState: 'closed',
      isRunning: false,
      location: 'current-view',
    };
  }

  private findTabWithConversation(conversationId: string): TabData | null {
    const tabs = this.tabManager?.getAllTabs() ?? [];
    return tabs.find(tab => tab.conversationId === conversationId) ?? null;
  }

  private getHistoryTabIndex(tab: TabData): number | undefined {
    const index = this.tabManager?.getAllTabs().findIndex(candidate => candidate.id === tab.id) ?? -1;
    return index >= 0 ? index + 1 : undefined;
  }

  // ============================================
  // Event Wiring
  // ============================================

  private wireEventHandlers(): void {
    const activeDocument = this.containerEl.ownerDocument;

    // Document-level click to close dropdowns
    this.registerDomEvent(activeDocument, 'click', () => {
      this.historyDropdown?.removeClass('visible');
    });

    // View-level Shift+Tab to toggle plan mode (works from any focused element)
    this.registerDomEvent(this.containerEl, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const activeTab = this.tabManager?.getActiveTab();
        if (!activeTab) return;
        const providerId = getTabProviderId(activeTab, this.plugin);
        if (!ProviderRegistry.getCapabilities(providerId).supportsPlanMode) return;
        const current = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
          this.plugin.settings,
          providerId,
        ).permissionMode as string;
        if (current === 'plan') {
          const restoreMode = activeTab.state.prePlanPermissionMode ?? 'normal';
          void updatePlanModeUI(activeTab, this.plugin, restoreMode, { syncRuntime: true })
            .finally(() => {
              const activeMode = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
                this.plugin.settings,
                providerId,
              ).permissionMode;
              if (activeMode !== 'plan') {
                activeTab.state.prePlanPermissionMode = null;
              }
            })
            .catch((error: unknown) => {
              new Notice(error instanceof Error ? error.message : 'Failed to change permission mode.');
            });
        } else {
          activeTab.state.prePlanPermissionMode = current;
          void updatePlanModeUI(activeTab, this.plugin, 'plan', { syncRuntime: true }).catch((error: unknown) => {
            const activeMode = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
              this.plugin.settings,
              providerId,
            ).permissionMode;
            if (activeMode !== 'plan') {
              activeTab.state.prePlanPermissionMode = null;
            }
            new Notice(error instanceof Error ? error.message : 'Failed to change permission mode.');
          });
        }
      }
    });

    // View scopes are the Obsidian-owned boundary for main-area tab hotkeys.
    // Returning false consumes Escape before Obsidian uses it for pane navigation.
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!e.defaultPrevented) {
        const activeTab = this.tabManager?.getActiveTab();
        if (activeTab?.state.isStreaming) {
          activeTab.controllers.inputController?.cancelStreaming();
        }
      }
      return false;
    });
    this.scope.register(['Mod'], 'Enter', (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const activeTab = this.tabManager?.getActiveTab();
      if (!activeTab) return;
      if (sendTabInputMessageFromExplicitEnterShortcut(activeTab, e, { requireInputFocus: true })) {
        return false;
      }
    });

    this.eventRefs.push(
      this.plugin.app.vault.on('create', () => this.mentionCacheCoordinator?.markStructureDirty()),
      this.plugin.app.vault.on('delete', () => this.mentionCacheCoordinator?.markStructureDirty()),
      this.plugin.app.vault.on('rename', () => this.mentionCacheCoordinator?.markStructureDirty()),
      this.plugin.app.vault.on('modify', () => this.mentionCacheCoordinator?.markFilesDirty())
    );

    // File open event
    this.registerEvent(
      this.plugin.app.workspace.on('file-open', (file) => {
        if (file) {
          this.tabManager?.getActiveTab()?.ui.fileContextManager?.handleFileOpen(file);
        }
      })
    );

    // Click outside to close mention dropdown
    this.registerDomEvent(activeDocument, 'click', (e) => {
      const activeTab = this.tabManager?.getActiveTab();
      if (activeTab) {
        const fcm = activeTab.ui.fileContextManager;
        if (fcm && !fcm.containsElement(e.target as Node) && e.target !== activeTab.dom.inputEl) {
          fcm.hideMentionDropdown();
        }
      }
    });
  }

  // ============================================
  // Persistence
  // ============================================

  private async restoreOrCreateTabs(): Promise<void> {
    const span = StartupProfiler.start('tab-restore');
    try {
      if (!this.tabManager) return;

      // Try to restore from persisted state
      const persistedState = await this.plugin.storage.getTabManagerState();
      if (persistedState && persistedState.openTabs.length > 0) {
        StartupProfiler.recordCount('restored-tab-count', persistedState.openTabs.length);
        await StartupProfiler.runAsync('tab-restore-internal', () => this.tabManager!.restoreState(persistedState));
        this.tabBar?.setExpandedTitleTabIds(persistedState.expandedTitleTabIds ?? []);
        this.updateTabBar();
        return;
      }

      // Fallback: create a new empty tab
      await this.tabManager.createTab();
    } finally {
      StartupProfiler.finish(span);
    }
  }

  private persistTabState(): void {
    const state = this.getPersistedTabState();
    if (!state) return;
    this.tabStatePersistence.update(state);
  }

  /** Force immediate persistence (for onClose/onunload). */
  private async persistTabStateImmediate(): Promise<void> {
    const state = this.getPersistedTabState();
    if (!state) return;
    this.tabStatePersistence.update(state);
    await this.tabStatePersistence.flush();
  }

  getPersistedTabState(): AppTabManagerState | null {
    if (!this.tabManager) return null;

    const state = this.tabManager.getPersistedState();
    const openTabIds = new Set(state.openTabs.map(tab => tab.tabId));
    const expandedTitleTabIds = (this.tabBar?.getExpandedTitleTabIds() ?? [])
      .filter(tabId => openTabIds.has(tabId));

    return {
      ...state,
      ...(expandedTitleTabIds.length > 0 ? { expandedTitleTabIds } : {}),
    };
  }

  // ============================================
  // Public API
  // ============================================

  /** Gets the currently active tab. */
  getActiveTab(): TabData | null {
    return this.tabManager?.getActiveTab() ?? null;
  }

  /** Appends text to the active composer without sending it. */
  appendToActiveInput(text: string): boolean {
    const inputEl = this.tabManager?.getActiveTab()?.dom.inputEl;
    if (!inputEl || !text) return false;

    const currentValue = inputEl.value;
    const separator = currentValue && !/\s$/.test(currentValue) ? ' ' : '';
    inputEl.value = `${currentValue}${separator}${text}`;

    const cursorPosition = inputEl.value.length;
    inputEl.selectionStart = cursorPosition;
    inputEl.selectionEnd = cursorPosition;

    const EventConstructor = inputEl.ownerDocument.defaultView?.Event ?? Event;
    inputEl.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    inputEl.focus();
    return true;
  }

  notifyConversationListChanged(): void {
    this.updateHistoryDropdown();
  }

  /** Gets the tab manager. */
  getTabManager(): TabManager | null {
    return this.tabManager;
  }

  /** Gets shared view controls that should preserve active tab selection context. */
  getSharedSelectionFocusScopeEls(): HTMLElement[] {
    return [
      this.inputNavRowHostEl,
    ].filter((el): el is HTMLElement => el !== null);
  }
}
