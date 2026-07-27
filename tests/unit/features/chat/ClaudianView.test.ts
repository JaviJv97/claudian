import { createMockEl } from '@test/helpers/mockElement';
import { Platform, Scope } from 'obsidian';

import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ClaudianView } from '@/features/chat/ClaudianView';
import { chooseCollaborationParticipants } from '@/features/chat/collaboration/CollaborationRoomModal';

const mockTabManagerConstructor = jest.fn();
jest.mock('@/features/chat/tabs/TabManager', () => ({
  TabManager: jest.fn().mockImplementation((...args: unknown[]) =>
    mockTabManagerConstructor(...args)),
}));
jest.mock('@/features/chat/collaboration/CollaborationRoomModal', () => ({
  ...jest.requireActual('@/features/chat/collaboration/CollaborationRoomModal'),
  chooseCollaborationParticipants: jest.fn(),
}));

const MockScope = Scope as typeof Scope & { instances: Scope[] };

function createModelRefreshTab(providerId: 'codex' | 'grok') {
  return {
    conversationId: null,
    dom: {
      inputWrapper: {
        toggleClass: jest.fn(),
      },
    },
    lifecycleState: 'bound_cold',
    providerId,
    service: null,
    state: { usage: null },
    ui: {
      modeSelector: {
        renderOptions: jest.fn(),
        updateDisplay: jest.fn(),
      },
      modelSelector: {
        renderOptions: jest.fn(),
        updateDisplay: jest.fn(),
      },
      permissionToggle: { updateDisplay: jest.fn() },
      serviceTierToggle: { updateDisplay: jest.fn() },
      thinkingBudgetSelector: { updateDisplay: jest.fn() },
    },
  };
}

function createBlankModelRefreshTab(providerId: 'codex' | 'grok') {
  return {
    ...createModelRefreshTab(providerId),
    draftModel: null,
    lifecycleState: 'blank',
    services: {
      instructionRefineService: null,
      subagentManager: {
        setTaskResultInterpreter: jest.fn(),
      },
    },
    ui: {
      ...createModelRefreshTab(providerId).ui,
      permissionToggle: {
        setVisible: jest.fn(),
        updateDisplay: jest.fn(),
      },
    },
  };
}

describe('ClaudianView model refresh routing', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refreshes matching bound tabs and all blank tabs without priming runtimes', () => {
    jest.spyOn(ProviderSettingsCoordinator, 'getProviderSettingsSnapshot')
      .mockImplementation((_settings, providerId) => ({
        customContextLimits: {},
        model: `${providerId}-model`,
        permissionMode: 'normal',
      }));
    jest.spyOn(ProviderRegistry, 'getChatUIConfig').mockReturnValue({
      getContextWindowSize: jest.fn().mockReturnValue(200_000),
      getPermissionModeToggle: jest.fn().mockReturnValue(null),
    } as any);
    jest.spyOn(ProviderRegistry, 'getCapabilities').mockImplementation(providerId => ({
      providerId,
      supportsImageAttachments: false,
      supportsMcpTools: false,
      supportsPlanMode: false,
    } as any));
    jest.spyOn(ProviderRegistry, 'getEnabledProviderIds').mockReturnValue(['codex', 'grok']);
    jest.spyOn(ProviderRegistry, 'createInstructionRefineService')
      .mockReturnValue(null as any);
    jest.spyOn(ProviderRegistry, 'getTaskResultInterpreter')
      .mockReturnValue(null as any);

    const codexTab = createModelRefreshTab('codex');
    const grokTab = createModelRefreshTab('grok');
    const blankGrokTab = createBlankModelRefreshTab('grok');
    const primeProviderRuntime = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    view.plugin = {
      getConversationSync: jest.fn().mockReturnValue(null),
      providerHost: {},
      settings: {},
    };
    view.tabManager = {
      getAllTabs: jest.fn().mockReturnValue([codexTab, grokTab, blankGrokTab]),
      primeProviderRuntime,
      reconcileProviderAvailability: jest.fn(),
    };

    view.refreshModelSelector('codex');

    expect(codexTab.ui.modelSelector.updateDisplay).toHaveBeenCalledTimes(1);
    expect(codexTab.ui.modelSelector.renderOptions).toHaveBeenCalledTimes(1);
    expect(grokTab.ui.modelSelector.updateDisplay).not.toHaveBeenCalled();
    expect(grokTab.ui.modelSelector.renderOptions).not.toHaveBeenCalled();
    expect(blankGrokTab.ui.modelSelector.updateDisplay).toHaveBeenCalled();
    expect(blankGrokTab.ui.modelSelector.renderOptions).toHaveBeenCalled();
    expect(view.tabManager.reconcileProviderAvailability).toHaveBeenCalledTimes(1);
    expect(primeProviderRuntime).not.toHaveBeenCalled();
  });
});

describe('ClaudianView collaboration quota refresh', () => {
  it('records a quota error without resetting or replacing the participant runtime', async () => {
    const quotaError = new Error('Quota endpoint unavailable');
    const runtime = {
      ensureReady: jest.fn().mockResolvedValue(false),
      getQuotaSnapshot: jest.fn().mockRejectedValue(quotaError),
      resetSession: jest.fn(),
      runtimeProfileId: 'personal',
    };
    const participant = {
      id: 'claude-personal',
      providerId: 'claude',
      conversationId: 'conversation-1',
      label: 'Claude Personal',
      runtimeProfileId: 'personal',
      resourcePolicy: { mode: 'active' },
    };
    const room = {
      id: 'room-1',
      participants: [participant],
    };
    const updateParticipantResourcePolicy = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    view.plugin = {
      storage: {
        rooms: {
          get: jest.fn().mockResolvedValue(room),
          updateParticipantResourcePolicy,
        },
      },
    };
    view.tabManager = {
      getAllTabs: jest.fn().mockReturnValue([{
        conversationId: 'conversation-1',
        service: runtime,
        serviceInitialized: true,
      }]),
    };
    view.quotaRefreshBackoff = new Map();
    view.quotaRefreshFlights = new Map();

    await expect(view.refreshCollaborationParticipantQuota(
      'room-1',
      'claude-personal',
      false,
    )).rejects.toThrow('Quota endpoint unavailable');

    expect(runtime.ensureReady).toHaveBeenCalledTimes(1);
    expect(runtime.getQuotaSnapshot).toHaveBeenCalledTimes(1);
    expect(runtime.resetSession).not.toHaveBeenCalled();
    expect(updateParticipantResourcePolicy).toHaveBeenCalledWith(
      'room-1',
      'claude-personal',
      expect.objectContaining({ quotaRefreshError: 'Quota endpoint unavailable' }),
    );

    await expect(view.refreshCollaborationParticipantQuota(
      'room-1',
      'claude-personal',
      false,
    )).resolves.toBeUndefined();
    expect(runtime.getQuotaSnapshot).toHaveBeenCalledTimes(1);
  });

  it('updates only the matching participant profile with its live weekly quota', async () => {
    const companyRuntime = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      getQuotaSnapshot: jest.fn().mockResolvedValue({
        fetchedAt: 100,
        source: 'claude-local',
        runtimeProfileId: 'company',
        windows: [{
          id: 'seven-day',
          label: '7 day',
          utilizationPercent: 21,
        }],
      }),
      runtimeProfileId: 'company',
    };
    const room: any = {
      id: 'room-1',
      participants: [
        {
          id: 'personal',
          providerId: 'claude',
          runtimeProfileId: 'personal',
          conversationId: 'personal-conversation',
          resourcePolicy: { mode: 'active', weeklyUsagePercent: 97 },
        },
        {
          id: 'company',
          providerId: 'claude',
          runtimeProfileId: 'company',
          conversationId: 'company-conversation',
          resourcePolicy: { mode: 'active', weeklyUsagePercent: 96 },
        },
      ],
    };
    const updateParticipantResourcePolicy = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        storage: {
          rooms: {
            get: jest.fn().mockResolvedValue(room),
            updateParticipantResourcePolicy,
          },
        },
      },
      quotaRefreshBackoff: new Map(),
      quotaRefreshFlights: new Map(),
      tabManager: {
        getAllTabs: jest.fn().mockReturnValue([
          {
            conversationId: 'personal-conversation',
            service: { runtimeProfileId: 'personal' },
            serviceInitialized: true,
          },
          {
            conversationId: 'company-conversation',
            service: companyRuntime,
            serviceInitialized: true,
          },
        ]),
      },
    });

    await view.refreshCollaborationParticipantQuota('room-1', 'company', false);

    expect(companyRuntime.getQuotaSnapshot).toHaveBeenCalledTimes(1);
    expect(updateParticipantResourcePolicy).toHaveBeenCalledWith(
      'room-1',
      'company',
      expect.objectContaining({ weeklyUsagePercent: 21 }),
    );
    expect(updateParticipantResourcePolicy).not.toHaveBeenCalledWith(
      'room-1',
      'personal',
      expect.anything(),
    );
  });

  it('discards a quota result whose account profile does not match the participant', async () => {
    const runtime = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      getQuotaSnapshot: jest.fn().mockResolvedValue({
        fetchedAt: 100,
        source: 'provider',
        runtimeProfileId: 'personal',
        windows: [{ id: 'seven-day', label: '7 day', utilizationPercent: 97 }],
      }),
      runtimeProfileId: 'company',
    };
    const participant = {
      id: 'company',
      label: 'Claude Company',
      providerId: 'claude',
      runtimeProfileId: 'company',
      conversationId: 'company-conversation',
    };
    const room: any = { id: 'room-1', participants: [participant] };
    const tab = {
      conversationId: participant.conversationId,
      service: runtime,
      serviceInitialized: true,
    };
    const updateParticipantResourcePolicy = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        storage: {
          rooms: {
            get: jest.fn().mockResolvedValue(room),
            updateParticipantResourcePolicy,
          },
        },
      },
      quotaRefreshBackoff: new Map(),
      quotaRefreshFlights: new Map(),
      tabManager: { getAllTabs: jest.fn().mockReturnValue([tab]) },
    });

    await expect(view.refreshCollaborationParticipantQuota('room-1', 'company', false))
      .rejects.toThrow('stale usage result was discarded');
    expect(updateParticipantResourcePolicy).not.toHaveBeenCalledWith(
      'room-1',
      'company',
      expect.objectContaining({ quotaSnapshot: expect.anything() }),
    );
  });
});

describe('ClaudianView collaboration turn queue', () => {
  it('holds a follow-up until every active room delivery finishes', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.activeCollaborationDeliveries = new Map([
      ['room-1:claude-company', 'event-1'],
    ]);
    view.queuedCollaborationMessages = new Map();
    view.routeCollaborationMessage = jest.fn().mockResolvedValue(true);

    view.queueCollaborationMessage('room-1', {
      originTabId: 'tab-1',
      content: 'Additional context',
    });
    await view.drainNextCollaborationMessage('room-1');

    expect(view.routeCollaborationMessage).not.toHaveBeenCalled();

    view.activeCollaborationDeliveries.clear();
    await view.drainNextCollaborationMessage('room-1');

    expect(view.routeCollaborationMessage).toHaveBeenCalledWith(
      'tab-1',
      'Additional context',
      undefined,
    );
    expect(view.queuedCollaborationMessages.has('room-1')).toBe(false);
  });

  it('dispatches queued follow-ups one at a time', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.activeCollaborationDeliveries = new Map();
    view.queuedCollaborationMessages = new Map();
    view.routeCollaborationMessage = jest.fn().mockImplementation(async (
      _tabId: string,
      content: string,
    ) => {
      view.activeCollaborationDeliveries.set('room-1:codex', content);
      return true;
    });

    view.queueCollaborationMessage('room-1', {
      originTabId: 'tab-1',
      content: 'First',
    });
    view.queueCollaborationMessage('room-1', {
      originTabId: 'tab-1',
      content: 'Second',
    });

    await view.drainNextCollaborationMessage('room-1');

    expect(view.routeCollaborationMessage).toHaveBeenCalledTimes(1);
    expect(view.routeCollaborationMessage).toHaveBeenCalledWith('tab-1', 'First', undefined);
    expect(view.queuedCollaborationMessages.get('room-1')).toHaveLength(1);
  });

  it('does not enqueue the same follow-up more than once', () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.queuedCollaborationMessages = new Map();
    const message = {
      originTabId: 'tab-1',
      content: 'Additional context',
    };

    expect(view.queueCollaborationMessage('room-1', message)).toBe(true);
    expect(view.queueCollaborationMessage('room-1', { ...message })).toBe(false);
    expect(view.queuedCollaborationMessages.get('room-1')).toEqual([message]);
  });

  it('keeps a follow-up queued when routing cannot handle it', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.activeCollaborationDeliveries = new Map();
    view.queuedCollaborationMessages = new Map();
    view.routeCollaborationMessage = jest.fn().mockResolvedValue(false);
    const message = { originTabId: 'tab-1', content: 'Do not lose this' };
    view.queueCollaborationMessage('room-1', message);

    await view.drainNextCollaborationMessage('room-1');

    expect(view.queuedCollaborationMessages.get('room-1')).toEqual([message]);
  });

  it('uses another open room tab when the original queued tab was closed', async () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.activeCollaborationDeliveries = new Map();
    view.queuedCollaborationMessages = new Map();
    view.routeCollaborationMessage = jest.fn().mockResolvedValue(true);
    view.plugin = {
      getConversationSync: jest.fn().mockReturnValue({
        collaboration: { roomId: 'room-1' },
      }),
    };
    view.tabManager = {
      getTab: jest.fn().mockReturnValue(undefined),
      getAllTabs: jest.fn().mockReturnValue([{
        id: 'tab-2',
        conversationId: 'conversation-2',
      }]),
    };
    view.queueCollaborationMessage('room-1', {
      originTabId: 'closed-tab',
      content: 'Continue',
    });

    await view.drainNextCollaborationMessage('room-1');

    expect(view.routeCollaborationMessage)
      .toHaveBeenCalledWith('tab-2', 'Continue', undefined);
    expect(view.queuedCollaborationMessages.has('room-1')).toBe(false);
  });
});

describe('ClaudianView collaboration room capacity', () => {
  it('reuses the initial blank agent tab when opening a three-participant room', async () => {
    jest.spyOn(ProviderRegistry, 'isEnabled').mockReturnValue(true);
    jest.spyOn(ProviderRegistry, 'getRuntimeProfiles').mockReturnValue([
      { id: 'personal', label: 'Claude Personal', available: true },
      { id: 'company', label: 'Claude Company', available: true },
    ]);
    (chooseCollaborationParticipants as jest.Mock).mockResolvedValue({
      title: 'Build room',
      participants: [
        {
          id: 'claude-personal',
          providerId: 'claude',
          label: 'Claude Personal',
          runtimeProfileId: 'personal',
        },
        {
          id: 'claude-company',
          providerId: 'claude',
          label: 'Claude Company',
          runtimeProfileId: 'company',
        },
        { id: 'codex', providerId: 'codex', label: 'Codex' },
      ],
    });

    const blankTab: any = {
      conversationId: null,
      controllers: {
        conversationController: {
          createNew: jest.fn().mockResolvedValue(undefined),
        },
      },
      id: 'blank-tab',
      lifecycleState: 'blank',
      state: { isRewinding: false, isStreaming: false },
    };
    const createdTabs: any[] = [];
    const openConversation = jest.fn(async (conversationId: string) => {
      blankTab.conversationId = conversationId;
      blankTab.lifecycleState = 'bound_cold';
    });
    const createTab = jest.fn(async (conversationId: string) => {
      const tab = { id: `created-${createdTabs.length}`, conversationId };
      createdTabs.push(tab);
      return tab;
    });
    const roomCreate = jest.fn().mockResolvedValue(undefined);
    let conversationIndex = 0;
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      app: {},
      plugin: {
        app: {},
        createConversation: jest.fn(async ({ providerId, runtimeProfileId }) => ({
          id: `conversation-${conversationIndex++}`,
          providerId,
          runtimeProfileId,
        })),
        deleteConversation: jest.fn().mockResolvedValue(undefined),
        settings: { maxTabs: 3 },
        storage: {
          rooms: {
            create: roomCreate,
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        updateConversation: jest.fn().mockResolvedValue(undefined),
      },
      reconcileCollaborationTimelines: jest.fn().mockResolvedValue(undefined),
      verifyCollaborationParticipantRuntimes: jest.fn().mockResolvedValue(undefined),
      tabManager: {
        createTab,
        getAllTabs: jest.fn().mockReturnValue([blankTab]),
        getTab: jest.fn().mockReturnValue(blankTab),
        getTabCount: jest.fn().mockReturnValue(1),
        openConversation,
        switchToTab: jest.fn().mockResolvedValue(undefined),
      },
      updateTabBarVisibility: jest.fn(),
    });

    await expect(view.startClaudeCodexCollaboration()).resolves.toBe(true);

    expect(openConversation).toHaveBeenCalledWith(
      'conversation-0',
      expect.objectContaining({ preferNewTab: false }),
    );
    expect(createTab).toHaveBeenCalledTimes(2);
    expect(roomCreate).toHaveBeenCalledTimes(1);
  });

  it('reuses a blank tab when reopening an archived room at capacity', async () => {
    const blankTab: any = {
      id: 'blank-tab',
      conversationId: null,
      lifecycleState: 'blank',
      state: { isRewinding: false, isStreaming: false },
      controllers: {
        conversationController: { createNew: jest.fn().mockResolvedValue(undefined) },
      },
    };
    const room = {
      version: 1,
      id: 'room-1',
      title: 'Restored room',
      status: 'archived',
      createdAt: 1,
      updatedAt: 2,
      events: [],
      participants: [
        { id: 'personal', providerId: 'claude', conversationId: 'conversation-1' },
        { id: 'company', providerId: 'claude', conversationId: 'conversation-2' },
        { id: 'codex', providerId: 'codex', conversationId: 'conversation-3' },
      ],
    };
    const createTab = jest.fn(async (conversationId: string) => ({
      id: `created-${conversationId}`,
      conversationId,
    }));
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const reopen = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        settings: { maxTabs: 3 },
        storage: { rooms: { list: jest.fn().mockResolvedValue([room]), reopen } },
      },
      reconcileCollaborationTimelines: jest.fn().mockResolvedValue(undefined),
      tabManager: {
        closeTab: jest.fn().mockResolvedValue(undefined),
        createTab,
        getAllTabs: jest.fn().mockReturnValue([blankTab]),
        getTab: jest.fn().mockReturnValue(blankTab),
        getTabCount: jest.fn().mockReturnValue(1),
        openConversation,
        switchToTab: jest.fn().mockResolvedValue(undefined),
      },
      updateTabBarVisibility: jest.fn(),
    });

    await expect(view.reopenLatestCollaboration()).resolves.toBe(true);

    expect(openConversation).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({ preferNewTab: false }),
    );
    expect(createTab).toHaveBeenCalledTimes(2);
    expect(reopen).toHaveBeenCalledWith('room-1');
  });

  it('reuses a blank tab when restoring a missing room participant', async () => {
    const blankTab: any = {
      id: 'blank-tab',
      conversationId: null,
      lifecycleState: 'blank',
      state: { isRewinding: false, isStreaming: false },
      controllers: {
        conversationController: { createNew: jest.fn().mockResolvedValue(undefined) },
      },
    };
    const openConversation = jest.fn().mockResolvedValue(undefined);
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        getConversationSync: jest.fn().mockReturnValue({ id: 'conversation-1' }),
      },
      reconcileCollaborationTimelines: jest.fn().mockResolvedValue(undefined),
      tabManager: {
        closeTab: jest.fn().mockResolvedValue(undefined),
        createTab: jest.fn(),
        getAllTabs: jest.fn().mockReturnValue([blankTab]),
        getTab: jest.fn().mockReturnValue(blankTab),
        openConversation,
        switchToTab: jest.fn().mockResolvedValue(undefined),
      },
      updateTabBarVisibility: jest.fn(),
    });

    await expect(view.restoreMissingCollaborationParticipants({
      participants: [{
        id: 'company',
        providerId: 'claude',
        conversationId: 'conversation-1',
      }],
    }, ['company'])).resolves.toBe(true);

    expect(openConversation).toHaveBeenCalledWith(
      'conversation-1',
      { activate: false, preferNewTab: false },
    );
    expect(view.tabManager.createTab).not.toHaveBeenCalled();
  });

  it('does not duplicate participant tabs that are already open during room recovery', async () => {
    const room = {
      version: 1,
      id: 'room-1',
      title: 'Partially open room',
      status: 'archived',
      createdAt: 1,
      updatedAt: 2,
      events: [],
      participants: [
        { id: 'company', providerId: 'claude', conversationId: 'conversation-open' },
        { id: 'codex', providerId: 'codex', conversationId: 'conversation-missing' },
      ],
    };
    const existingTab = {
      id: 'existing',
      conversationId: 'conversation-open',
      lifecycleState: 'bound_warm',
      state: { isRewinding: false, isStreaming: false },
    };
    const createTab = jest.fn().mockResolvedValue({
      id: 'created',
      conversationId: 'conversation-missing',
    });
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      plugin: {
        settings: { maxTabs: 2 },
        storage: {
          rooms: {
            list: jest.fn().mockResolvedValue([room]),
            reopen: jest.fn().mockResolvedValue(undefined),
          },
        },
      },
      reconcileCollaborationTimelines: jest.fn().mockResolvedValue(undefined),
      tabManager: {
        closeTab: jest.fn().mockResolvedValue(undefined),
        createTab,
        getAllTabs: jest.fn().mockReturnValue([existingTab]),
        getTabCount: jest.fn().mockReturnValue(1),
      },
      updateTabBarVisibility: jest.fn(),
    });

    await expect(view.reopenLatestCollaboration()).resolves.toBe(true);

    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith(
      'conversation-missing',
      undefined,
      { activate: true },
    );
  });

  it('hydrates a participant tab created during send readiness recovery', async () => {
    const tabs: any[] = [];
    const restoredTab: any = {
      id: 'restored-tab',
      conversationId: 'conversation-company',
      state: { currentConversationId: null },
      hydrationState: 'idle',
    };
    const switchToTab = jest.fn(async (tabId: string) => {
      if (tabId === restoredTab.id) {
        restoredTab.state.currentConversationId = restoredTab.conversationId;
        restoredTab.hydrationState = 'ready';
      }
    });
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      restoreMissingCollaborationParticipants: jest.fn(async () => {
        tabs.push(restoredTab);
        return true;
      }),
      tabManager: {
        getAllTabs: jest.fn(() => tabs),
        getTab: jest.fn((tabId: string) => (
          tabId === 'origin-tab' ? { id: 'origin-tab' } : undefined
        )),
        switchToTab,
      },
    });

    await expect(view.ensureCollaborationRecipientsReady({
      participants: [{
        id: 'company',
        providerId: 'claude',
        conversationId: 'conversation-company',
      }],
    }, ['company'], 'origin-tab')).resolves.toBe(true);

    expect(view.restoreMissingCollaborationParticipants)
      .toHaveBeenCalledWith(expect.anything(), ['company']);
    expect(switchToTab).toHaveBeenNthCalledWith(1, 'restored-tab');
    expect(switchToTab).toHaveBeenLastCalledWith('origin-tab');
  });
});

function createViewHarness(options: {
  canCreateTab: boolean;
  tabCount?: number;
}): {
  newTabButtonEl: ReturnType<typeof createMockEl>;
  view: any;
} {
  const newTabButtonEl = createMockEl();
  const view = Object.create(ClaudianView.prototype) as any;

  view.plugin = {
    settings: {},
  };
  view.tabManager = {
    canCreateTab: jest.fn().mockReturnValue(options.canCreateTab),
    getTabCount: jest.fn().mockReturnValue(options.tabCount ?? 1),
  };
  view.tabBarContainerEl = createMockEl();
  view.newTabButtonEl = newTabButtonEl;

  return { newTabButtonEl, view };
}

describe('ClaudianView tab controls', () => {
  it('hides the new-tab button when the tab manager is at capacity', () => {
    const { newTabButtonEl, view } = createViewHarness({ canCreateTab: false });

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('claudian-hidden')).toBe(true);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBe('true');
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the new-tab button when another tab can be created', () => {
    const { newTabButtonEl, view } = createViewHarness({ canCreateTab: true });
    newTabButtonEl.addClass('claudian-hidden');
    newTabButtonEl.setAttribute('aria-disabled', 'true');
    newTabButtonEl.setAttribute('aria-hidden', 'true');

    view.refreshTabControls();

    expect(newTabButtonEl.hasClass('claudian-hidden')).toBe(false);
    expect(newTabButtonEl.getAttribute('aria-disabled')).toBeNull();
    expect(newTabButtonEl.getAttribute('aria-hidden')).toBeNull();
  });

  it('keeps tab controls in the view-owned input row', () => {
    const navRowContent = createMockEl();
    const inputNavRowHostEl = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    view.containerEl = createMockEl();
    view.navRowContent = navRowContent;
    view.inputNavRowHostEl = inputNavRowHostEl;
    view.tabBar = {
      captureScrollPosition: jest.fn(),
      restoreScrollPosition: jest.fn(),
    };

    view.attachNavRowContentToInputFooter();

    expect(inputNavRowHostEl.children).toContain(navRowContent);
    expect(view.tabBar.captureScrollPosition).toHaveBeenCalledTimes(1);
    expect(view.tabBar.restoreScrollPosition).toHaveBeenCalledTimes(1);
  });

  it('moves only the active tab input into the stable input slot', () => {
    const activeInputSlotEl = createMockEl();
    const tab1 = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const tab2 = {
      id: 'tab-2',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl: createMockEl(),
        inputContainerEl: createMockEl(),
      },
    };
    const view = Object.create(ClaudianView.prototype) as any;

    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn()
        .mockReturnValueOnce(tab1)
        .mockReturnValueOnce(tab2),
      getTab: jest.fn((id: string) => id === 'tab-1' ? tab1 : tab2),
    };

    view.updateInputLocation();
    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(tab2.dom.inputComposerEl);
    expect(activeInputSlotEl.children).not.toContain(tab1.dom.inputComposerEl);
    expect(tab1.dom.contentEl.children).toContain(tab1.dom.inputComposerEl);
  });

  it('preserves active pending prompt siblings during same-tab input updates', () => {
    const activeInputSlotEl = createMockEl();
    const inputComposerEl = activeInputSlotEl.createDiv();
    const pendingPromptEl = inputComposerEl.createDiv({ cls: 'claudian-ask-question-inline' });
    const tab = {
      id: 'tab-1',
      dom: {
        contentEl: createMockEl(),
        inputComposerEl,
        inputContainerEl: inputComposerEl.createDiv({ cls: 'claudian-input-container' }),
      },
    };
    const view = Object.create(ClaudianView.prototype) as any;

    Object.defineProperty(inputComposerEl, 'parentElement', {
      configurable: true,
      get: () => activeInputSlotEl,
    });
    view.activeInputTabId = 'tab-1';
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(tab),
      getTab: jest.fn().mockReturnValue(tab),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).toContain(inputComposerEl);
    expect(inputComposerEl.children).toContain(pendingPromptEl);
  });

  it('clears the stable input slot when no tab is active', () => {
    const activeInputSlotEl = createMockEl();
    const staleInputEl = activeInputSlotEl.createDiv();
    const view = Object.create(ClaudianView.prototype) as any;

    view.activeInputTabId = 'tab-1';
    view.activeInputSlotEl = activeInputSlotEl;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    view.updateInputLocation();

    expect(activeInputSlotEl.children).not.toContain(staleInputEl);
    expect(view.activeInputTabId).toBeNull();
  });

  it('toggles the history dropdown when the history button is clicked', () => {
    const historyDropdown = createMockEl();
    const view = Object.create(ClaudianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(true);

    view.toggleHistoryDropdown();

    expect(historyDropdown.hasClass('visible')).toBe(false);
  });

  it('defers hidden history rendering and coalesces invalidations until the dropdown opens', () => {
    const historyDropdown = createMockEl();
    const renderHistoryDropdown = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;

    view.historyDropdown = historyDropdown;
    view.historyDropdownDirty = true;
    view.historyDropdownRendered = false;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        controllers: {
          conversationController: { renderHistoryDropdown },
        },
      }),
    };

    view.updateHistoryDropdown();
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).not.toHaveBeenCalled();

    view.toggleHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(1);
    const firstRenderSignal = renderHistoryDropdown.mock.calls[0][1].signal as AbortSignal;
    expect(firstRenderSignal.aborted).toBe(false);

    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);

    view.toggleHistoryDropdown();
    expect(firstRenderSignal.aborted).toBe(true);
    view.updateHistoryDropdown();

    expect(renderHistoryDropdown).toHaveBeenCalledTimes(2);
  });

  it('persists expanded title tab ids with the tab layout snapshot', () => {
    const view = Object.create(ClaudianView.prototype) as any;

    view.tabManager = {
      getPersistedState: jest.fn().mockReturnValue({
        openTabs: [
          { tabId: 'tab-1', conversationId: null },
          { tabId: 'tab-2', conversationId: 'conv-2' },
        ],
        activeTabId: 'tab-2',
      }),
    };
    view.tabBar = {
      getExpandedTitleTabIds: jest.fn().mockReturnValue(['tab-2', 'closed-tab']),
    };

    expect(view.getPersistedTabState()).toEqual({
      openTabs: [
        { tabId: 'tab-1', conversationId: null },
        { tabId: 'tab-2', conversationId: 'conv-2' },
      ],
      activeTabId: 'tab-2',
      expandedTitleTabIds: ['tab-2'],
    });
  });

  it('restores expanded title tab ids after restoring tabs', async () => {
    const persistedState = {
      openTabs: [{ tabId: 'tab-1', conversationId: null }],
      activeTabId: 'tab-1',
      expandedTitleTabIds: ['tab-1'],
    };
    const view = Object.create(ClaudianView.prototype) as any;

    view.plugin = {
      storage: {
        getTabManagerState: jest.fn().mockResolvedValue(persistedState),
      },
    };
    view.tabManager = {
      restoreState: jest.fn().mockResolvedValue(undefined),
      createTab: jest.fn(),
    };
    view.tabBar = {
      setExpandedTitleTabIds: jest.fn(),
    };
    view.updateTabBar = jest.fn();

    await view.restoreOrCreateTabs();

    expect(view.tabManager.restoreState).toHaveBeenCalledWith(persistedState);
    expect(view.tabBar.setExpandedTitleTabIds).toHaveBeenCalledWith(['tab-1']);
    expect(view.updateTabBar).toHaveBeenCalledTimes(1);
    expect(view.tabManager.createTab).not.toHaveBeenCalled();
  });
});

describe('ClaudianView tab persistence wiring', () => {
  it('schedules persistence from the tab manager persisted-state signal', async () => {
    let tabManagerCallbacks: any;
    mockTabManagerConstructor.mockReset();
    mockTabManagerConstructor.mockImplementation(
      (_plugin, _containerEl, _view, callbacks) => {
        tabManagerCallbacks = callbacks;
        return {
          getAllTabs: jest.fn().mockReturnValue([]),
        };
      },
    );

    const persistTabState = jest.fn();
    const view = Object.create(ClaudianView.prototype) as any;
    Object.assign(view, {
      attachNavRowContentToInputFooter: jest.fn(),
      buildInputFooter: jest.fn(),
      buildNavRowContent: jest.fn().mockReturnValue(createMockEl()),
      containerEl: createMockEl(),
      contentEl: createMockEl(),
      persistTabState,
      plugin: {},
      restoreOrCreateTabs: jest.fn().mockResolvedValue(undefined),
      syncProviderBrandColor: jest.fn(),
      updateInputLocation: jest.fn(),
      updateTabBarVisibility: jest.fn(),
      wireEventHandlers: jest.fn(),
    });

    await view.onOpenImpl();
    tabManagerCallbacks.onPersistedStateChanged();

    expect(persistTabState).toHaveBeenCalledTimes(1);
  });
});

describe('ClaudianView composer input', () => {
  function createComposerHarness(existingContent: string): {
    inputEl: HTMLTextAreaElement;
    inputHandler: jest.Mock;
    view: any;
  } {
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    const inputHandler = jest.fn();
    inputEl.value = existingContent;
    inputEl.selectionStart = 0;
    inputEl.selectionEnd = 0;
    inputEl.focus = jest.fn();
    inputEl.addEventListener('input', inputHandler);

    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({ dom: { inputEl } }),
    };

    return { inputEl, inputHandler, view };
  }

  it('appends text after existing composer content', () => {
    const { inputEl, inputHandler, view } = createComposerHarness('Review this note');

    const appended = view.appendToActiveInput('@projects/plan.md ');

    expect(appended).toBe(true);
    expect(inputEl.value).toBe('Review this note @projects/plan.md ');
    expect(inputEl.selectionStart).toBe(inputEl.value.length);
    expect(inputEl.selectionEnd).toBe(inputEl.value.length);
    expect(inputHandler).toHaveBeenCalledTimes(1);
    expect(inputEl.focus).toHaveBeenCalledTimes(1);
  });

  it('does not add another separator when existing content ends in whitespace', () => {
    const { inputEl, view } = createComposerHarness('Review this note\n');

    view.appendToActiveInput('@projects/plan.md ');

    expect(inputEl.value).toBe('Review this note\n@projects/plan.md ');
  });

  it('returns false when there is no active composer', () => {
    const view = Object.create(ClaudianView.prototype) as any;
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue(null),
    };

    expect(view.appendToActiveInput('@projects/plan.md ')).toBe(false);
  });
});

describe('ClaudianView shutdown', () => {
  it('disposes view resources when the final tab-state flush fails', async () => {
    const error = new Error('disk full');
    const view = Object.create(ClaudianView.prototype) as any;
    const destroy = jest.fn().mockResolvedValue(undefined);
    const tabBarDestroy = jest.fn();
    const persistenceDispose = jest.fn();

    Object.assign(view, {
      cancelHistoryRendering: jest.fn(),
      eventRefs: [],
      mentionCacheCoordinator: {},
      pendingTabBarUpdate: null,
      persistTabStateImmediate: jest.fn().mockRejectedValue(error),
      plugin: { app: { vault: { offref: jest.fn() } } },
      restoreActiveInputToTabContent: jest.fn(),
      scope: {},
      tabBar: { destroy: tabBarDestroy },
      tabManager: { destroy },
      tabStatePersistence: { dispose: persistenceDispose },
    });

    await expect(view.onClose()).resolves.toBeUndefined();

    expect(persistenceDispose).toHaveBeenCalledTimes(1);
    expect(view.restoreActiveInputToTabContent).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(tabBarDestroy).toHaveBeenCalledTimes(1);
    expect(view.tabManager).toBeNull();
    expect(view.scope).toBeNull();
  });
});

describe('ClaudianView Escape handling', () => {
  beforeEach(() => {
    MockScope.instances.length = 0;
  });

  function createEscapeHarness(options: {
    isStreaming: boolean;
  }): {
    cancelStreaming: jest.Mock;
    eventRefs: unknown[];
    view: any;
  } {
    const cancelStreaming = jest.fn();
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(ClaudianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: options.isStreaming },
        controllers: {
          inputController: { cancelStreaming },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { cancelStreaming, eventRefs, view };
  }

  function createScopedSendHarness(options: {
    inputFocused: boolean;
  }): {
    inputEl: HTMLTextAreaElement;
    sendMessage: jest.Mock;
    view: any;
  } {
    const sendMessage = jest.fn();
    const inputEl = createMockEl('textarea') as unknown as HTMLTextAreaElement;
    Object.defineProperty(inputEl.ownerDocument, 'activeElement', {
      configurable: true,
      get: () => options.inputFocused ? inputEl : null,
    });
    const eventRefs: unknown[] = [];
    const parentScope = new Scope();
    const view = Object.create(ClaudianView.prototype) as any;

    view.app = { scope: parentScope };
    view.containerEl = createMockEl();
    view.historyDropdown = createMockEl();
    view.registerDomEvent = jest.fn();
    view.registerEvent = jest.fn();
    view.eventRefs = eventRefs;
    view.plugin = {
      app: {
        vault: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
        workspace: {
          on: jest.fn((_event: string, handler: unknown) => {
            const ref = { handler };
            eventRefs.push(ref);
            return ref;
          }),
        },
      },
    };
    view.tabManager = {
      getActiveTab: jest.fn().mockReturnValue({
        state: { isStreaming: false },
        dom: { inputEl },
        controllers: {
          inputController: { sendMessage },
        },
        ui: {
          fileContextManager: {
            markFileCacheDirty: jest.fn(),
            markFolderCacheDirty: jest.fn(),
            handleFileOpen: jest.fn(),
            handleClickOutside: jest.fn(),
          },
        },
      }),
    };

    return { inputEl, sendMessage, view };
  }

  it('registers Escape on the Obsidian view scope instead of document keydown capture', () => {
    const { view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();

    expect(view.scope).toBeInstanceOf(Scope);
    expect(view.scope.parent).toBe(view.app.scope);
    expect(view.scope.register).toHaveBeenCalledWith([], 'Escape', expect.any(Function));
    expect(view.registerDomEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      'keydown',
      expect.any(Function),
      { capture: true }
    );
  });

  it('cancels streaming and consumes scoped Escape', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('consumes scoped Escape without cancelling when not streaming', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: false });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({ key: 'Escape', isComposing: false } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('consumes already handled scoped Escape without cancelling again', () => {
    const { cancelStreaming, view } = createEscapeHarness({ isStreaming: true });

    view.wireEventHandlers();
    const escapeHandler = view.scope.handlers.find((handler: any) => handler.key === 'Escape');
    const result = escapeHandler.func({
      key: 'Escape',
      isComposing: false,
      defaultPrevented: true,
    } as KeyboardEvent);

    expect(cancelStreaming).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('sends from focused composer through scoped Mod+Enter', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: true });

    view.wireEventHandlers();
    const sendHandler = view.scope.handlers.find(
      (handler: any) => handler.key === 'Enter' && handler.modifiers?.includes('Mod')
    );
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('ignores scoped Mod+Enter when composer is not focused', () => {
    Platform.isMacOS = true;
    const { sendMessage, view } = createScopedSendHarness({ inputFocused: false });

    view.wireEventHandlers();
    const sendHandler = view.scope.handlers.find(
      (handler: any) => handler.key === 'Enter' && handler.modifiers?.includes('Mod')
    );
    const event = {
      key: 'Enter',
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;
    const result = sendHandler.func(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
