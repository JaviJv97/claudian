import type { EventRef, WorkspaceLeaf } from 'obsidian';
import { ItemView, Notice, Scope, setIcon } from 'obsidian';

import { CollaborationCoordinator } from '../../core/collaboration/CollaborationCoordinator';
import {
  createCollaborationMemberships,
  createCollaborationRoomId,
  getCollaborationParticipantId,
  resolveCollaborationTurn,
} from '../../core/collaboration/collaborationRoom';
import { StartupProfiler } from '../../core/performance/StartupProfiler';
import { getHiddenProviderCommandSet } from '../../core/providers/commands/hiddenCommands';
import {
  getProviderSettingsSnapshotWithModel,
  resolveConversationModel,
} from '../../core/providers/conversationModel';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import { type AppTabManagerState, DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from '../../core/providers/types';
import type { ImageAttachment } from '../../core/types';
import { VIEW_TYPE_CLAUDIAN } from '../../core/types';
import {
  cancelScheduledAnimationFrame,
  scheduleAnimationFrame,
  type ScheduledAnimationFrame,
} from '../../utils/animationFrame';
import type { FeatureHost } from '../FeatureHost';
import {
  captureCollaborationFileSnapshot,
  findChangedSharedFiles,
  findSharedReferencedFiles,
} from './collaboration/collaborationFileConflicts';
import { findCollaborationRebindCandidates } from './collaboration/collaborationRebinding';
import { findFreshAssistantMessage } from './collaboration/collaborationResponse';
import {
  chooseCollaborationParticipants,
  toClaudeParticipantChoices,
} from './collaboration/CollaborationRoomModal';
import { groupCollaborationTabBarItems } from './collaboration/collaborationTabs';
import { CollaborationTimeline } from './collaboration/CollaborationTimeline';
import type { HistoryConversationStatus } from './controllers/ConversationController';
import { MentionCacheCoordinator } from './services/MentionCacheCoordinator';
import { TabStatePersistenceCoordinator } from './services/TabStatePersistenceCoordinator';
import {
  getTabProviderId,
  sendTabInputMessageFromExplicitEnterShortcut,
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
    this.syncProviderBrandColor();
    this.attachNavRowContentToInputFooter();
    this.updateInputLocation();
    this.updateTabBarVisibility();
  }

  async onClose() {
    this.cancelHistoryRendering();
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

    const collaborationTurn = resolveCollaborationTurn(
      content,
      room.participants.map(getCollaborationParticipantId),
    );
    const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
    const sharedReferencedFiles = findSharedReferencedFiles(
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
    const fileBaseline = await captureSharedFileSnapshot();
    const turn = await this.collaborationCoordinator.send(room, {
      content: collaborationTurn.content,
      recipientIds: collaborationTurn.recipientIds,
      recipientContent: collaborationTurn.recipientContent,
      attachments: images,
      dispatch: async (participant, request, signal) => {
        const participantId = getCollaborationParticipantId(participant);
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
          await this.plugin.storage.rooms.appendEvent(room.id, {
            id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            kind: 'message',
            authorId: participantId,
            recipientIds: ['user'],
            content: assistantMessage.content,
            createdAt: assistantMessage.timestamp,
            delivery: {},
            sourceMessageId: assistantMessage.id,
          });
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
        return {
          providerMessageId: assistantMessage?.assistantMessageId,
          conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
        };
      },
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
          plugin: this.plugin,
          roomId,
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
            );
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
  ): Promise<void> {
    const currentRoom = await this.plugin.storage.rooms.get(roomId);
    const event = currentRoom?.events.find(candidate => candidate.id === eventId);
    if (!event) throw new Error(`Collaboration event not found: ${eventId}`);

    await Promise.all(Object.entries(event.delivery).map(async ([providerId, delivery]) => {
      if (delivery.status !== 'conflict') return;
      await this.plugin.storage.rooms.updateDelivery(roomId, eventId, providerId, {
        ...delivery,
        status: 'resolved',
        resolution,
        resolutionProviderId,
      });
    }));
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
