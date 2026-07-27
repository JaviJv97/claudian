import { Menu } from 'obsidian';

import {
  CollaborationTimeline,
  formatCollaborationRoutePreview,
  getAvailableReviewParticipantIds,
  resolveParticipantActivity,
} from '@/features/chat/collaboration/CollaborationTimeline';

import { createMockEl } from '../../../../helpers/mockElement';

describe('getAvailableReviewParticipantIds', () => {
  it('offers every other available account without collapsing same-provider profiles', () => {
    expect(getAvailableReviewParticipantIds(
      ['claude-personal', 'claude-company', 'codex', 'claude-company'],
      'codex',
      {
        'claude-personal': { mode: 'active' },
        'claude-company': { mode: 'preserve' },
      },
    )).toEqual(['claude-personal', 'claude-company']);
  });

  it('excludes the source account and unavailable reviewers', () => {
    expect(getAvailableReviewParticipantIds(
      ['claude-personal', 'claude-company', 'codex'],
      'claude-personal',
      { 'claude-company': { mode: 'unavailable' } },
    )).toEqual(['codex']);
  });
});

describe('formatCollaborationRoutePreview', () => {
  it('estimates round-table and deliberation turns', () => {
    const base = {
      source: 'deterministic' as const,
      recipientIds: ['a', 'b', 'c'],
      orderedParticipantIds: ['a', 'b', 'c'],
      cycleOrders: [['a', 'b', 'c']],
      facilitatorParticipantId: undefined,
      synthesizerParticipantId: 'c',
      reasons: [],
      warnings: [],
    };
    expect(formatCollaborationRoutePreview({
      ...base,
      mode: 'round-table',
      cycles: 2,
    })).toBe('Estimate · Auto → round-table · 3 agents · 6 projected turns');
    expect(formatCollaborationRoutePreview({
      ...base,
      mode: 'deliberation',
      cycles: 1,
    })).toBe('Estimate · Auto → deliberation · 3 agents · 10 projected turns');
  });
});

describe('CollaborationTimeline routing controls', () => {
  it('renders grouped participants, an explicit state menu, and an automatic route preview', () => {
    const contentEl = createMockEl();
    const messageWrapper = createMockEl();
    const messagesEl = createMockEl();
    messagesEl.parentElement = messageWrapper;
    const inputEl = createMockEl('textarea');
    const onQuickResourceModeChange = jest.fn().mockResolvedValue(undefined);
    const menuClass = Menu as unknown as {
      instances: Array<{
        items: Array<{ title: string; clickHandler: (() => void) | null }>;
      }>;
    };
    menuClass.instances.length = 0;

    const timeline = new CollaborationTimeline({
      hostTab: {
        dom: { contentEl, messagesEl, inputEl },
      },
      participantTabs: [],
      participantLabels: { claude: 'Claude', codex: 'Codex' },
      participantResourcePolicies: {
        claude: { mode: 'active' },
        codex: { mode: 'active' },
      },
      participantUsageSnapshots: {},
      plugin: {
        storage: {
          rooms: { get: jest.fn().mockResolvedValue(null) },
        },
      },
      roomId: 'room-1',
      discussionMode: 'round-table',
      routingSettings: {
        selection: 'auto',
        defaultMode: 'round-table',
        roundTable: {
          participantOrder: ['claude', 'codex'],
          cycles: 2,
          rotateStarter: false,
        },
      },
      onDiscussionModeChange: jest.fn().mockResolvedValue(undefined),
      onEditRoutingSettings: jest.fn(),
      onQuickResourceModeChange,
      onApplyQuotaRecommendation: jest.fn().mockResolvedValue(undefined),
      canStop: jest.fn().mockReturnValue(false),
      onStop: jest.fn(),
      onOpenUsageDashboard: jest.fn(),
      onEditResourcePolicy: jest.fn(),
    } as never);

    const rootEl = contentEl.querySelector('.claudian-collaboration');
    expect(rootEl?.querySelectorAll('.claudian-collaboration-participant-control')).toHaveLength(2);
    const resourceButton = rootEl?.querySelectorAll('.claudian-collaboration-resource')
      .find((button: ReturnType<typeof createMockEl>) => button.dataset.provider === 'claude');
    resourceButton?.click();
    expect(menuClass.instances).toHaveLength(1);
    expect(menuClass.instances[0].items.map(item => item.title)).toEqual([
      '✓ Active',
      'Preserve',
      'Muted',
      'Usage details',
    ]);
    menuClass.instances[0].items[2].clickHandler?.();
    expect(onQuickResourceModeChange).toHaveBeenCalledWith('claude', 'muted');

    inputEl.value = 'Challenge both positions and reach final consensus';
    inputEl.dispatchEvent({ type: 'input' });
    const preview = rootEl?.querySelector('.claudian-collaboration-route-preview');
    expect(preview?.textContent).toContain('Auto → deliberation');
    expect(preview?.textContent).toContain('7 projected turns');

    timeline.destroy();
  });
});

describe('resolveParticipantActivity', () => {
  it('shows the live deliberation stage while an agent is working', () => {
    expect(resolveParticipantActivity({
      isStreaming: true,
      needsAttention: false,
      phase: 'critique',
    })).toEqual({
      state: 'working',
      label: 'Working',
      stage: 'Critique',
    });
  });

  it('distinguishes queued work from an idle participant', () => {
    expect(resolveParticipantActivity({
      isStreaming: false,
      needsAttention: false,
      deliveryStatus: 'pending',
      phase: 'position',
    })).toEqual({
      state: 'queued',
      label: 'Queued',
      stage: 'Position',
    });
  });

  it('gives attention precedence over streaming state', () => {
    expect(resolveParticipantActivity({
      isStreaming: true,
      needsAttention: true,
      phase: 'verification',
    })).toEqual({
      state: 'attention',
      label: 'Needs attention',
      stage: 'Verification',
    });
  });

  it('uses a calm ready state after work completes', () => {
    expect(resolveParticipantActivity({
      isStreaming: false,
      needsAttention: false,
      deliveryStatus: 'completed',
    })).toEqual({
      state: 'ready',
      label: 'Ready',
      stage: null,
    });
  });
});
