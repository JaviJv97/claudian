import { Modal, setIcon } from 'obsidian';

import {
  getQuotaProjection,
  getQuotaRoutingRecommendation,
  isQuotaSnapshotStale,
} from '../../../core/collaboration/collaborationResourcePolicy';
import { getCollaborationParticipantId } from '../../../core/collaboration/collaborationRoom';
import { ClaudeProcessRegistry } from '../../../core/runtime/ClaudeProcessRegistry';
import type { ProviderQuotaWindow } from '../../../core/runtime/types';
import type {
  CollaborationParticipant,
  CollaborationQuotaHistoryPoint,
  CollaborationRoom,
} from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';

interface CollaborationUsageDashboardOptions {
  roomId: string;
  loadRoom: () => Promise<CollaborationRoom | null>;
  refreshAll: () => Promise<void>;
  applyRecommendation: (participantId: string) => Promise<void>;
}

function getWeeklyWindow(participant: CollaborationParticipant): ProviderQuotaWindow | undefined {
  return participant.resourcePolicy?.quotaSnapshot?.windows.find(window => (
    window.id === 'seven-day' || window.id === 'secondary'
  ));
}

function getFiveHourWindow(participant: CollaborationParticipant): ProviderQuotaWindow | undefined {
  return participant.resourcePolicy?.quotaSnapshot?.windows.find(window => (
    window.id === 'five-hour' || window.id === 'primary'
  ));
}

function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const delta = timestamp - now;
  const absolute = Math.abs(delta);
  const minutes = Math.max(1, Math.round(absolute / 60_000));
  const value = minutes >= 24 * 60
    ? `${Math.round(minutes / (24 * 60))}d`
    : minutes >= 60
      ? `${Math.round(minutes / 60)}h`
      : `${minutes}m`;
  return delta >= 0 ? `in ${value}` : `${value} ago`;
}

function getHistoryValues(
  history: CollaborationQuotaHistoryPoint[] | undefined,
  windowId: string,
): number[] {
  return (history ?? []).flatMap((sample) => {
    const window = sample.windows.find(candidate => candidate.id === windowId);
    return window ? [window.utilizationPercent] : [];
  });
}

function renderSparkline(container: HTMLElement, values: number[]): void {
  const samples = values.length > 1 ? values : [values[0] ?? 0, values[0] ?? 0];
  const svg = container.createSvg('svg');
  svg.addClass('claudian-usage-dashboard-sparkline');
  svg.setAttr('viewBox', '0 0 120 32');
  svg.setAttr('role', 'img');
  svg.setAttr('aria-label', `Usage trend from ${samples[0]}% to ${samples.at(-1)}%`);
  const points = samples.map((value, index) => {
    const x = samples.length === 1 ? 0 : index * (120 / (samples.length - 1));
    const y = 30 - Math.max(0, Math.min(100, value)) * 0.28;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  svg.createSvg('polyline', {
    attr: {
      points,
      fill: 'none',
      'vector-effect': 'non-scaling-stroke',
    },
  });
}

export class CollaborationUsageDashboardModal extends Modal {
  constructor(
    plugin: FeatureHost,
    private readonly options: CollaborationUsageDashboardOptions,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass('claudian-usage-dashboard-modal');
    this.setTitle('Collaboration usage');
    void this.render();
  }

  private async render(): Promise<void> {
    const room = await this.options.loadRoom();
    if (!room) {
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: 'This collaboration room is unavailable.' });
      return;
    }

    this.contentEl.empty();
    const header = this.contentEl.createDiv({ cls: 'claudian-usage-dashboard-header' });
    const context = header.createDiv();
    context.createEl('h3', { text: room.title });
    context.createEl('p', {
      text: 'Provider quota, projected exhaustion, and workflow context consumption.',
    });
    const refreshButton = header.createEl('button', {
      cls: 'claudian-usage-dashboard-refresh',
      attr: { type: 'button' },
    });
    const refreshIcon = refreshButton.createSpan();
    setIcon(refreshIcon, 'refresh-cw');
    refreshButton.createSpan({ text: 'Refresh all' });
    refreshButton.addEventListener('click', () => {
      refreshButton.disabled = true;
      refreshButton.addClass('is-loading');
      void this.options.refreshAll()
        .then(() => this.render())
        .finally(() => {
          refreshButton.disabled = false;
          refreshButton.removeClass('is-loading');
        });
    });

    const constrained = room.participants
      .map(participant => ({ participant, weekly: getWeeklyWindow(participant) }))
      .filter((entry): entry is { participant: CollaborationParticipant; weekly: ProviderQuotaWindow } => (
        !!entry.weekly
      ))
      .sort((left, right) => right.weekly.utilizationPercent - left.weekly.utilizationPercent)[0];
    const summary = this.contentEl.createDiv({ cls: 'claudian-usage-dashboard-summary' });
    const hero = summary.createDiv({ cls: 'claudian-usage-dashboard-hero' });
    hero.createSpan({ cls: 'claudian-usage-dashboard-metric-label', text: 'Tightest weekly headroom' });
    hero.createSpan({
      cls: 'claudian-usage-dashboard-hero-value',
      text: constrained ? `${Math.max(0, 100 - constrained.weekly.utilizationPercent)}%` : '—',
    });
    hero.createSpan({
      cls: 'claudian-usage-dashboard-metric-context',
      text: constrained
        ? constrained.participant.label ?? getCollaborationParticipantId(constrained.participant)
        : 'Waiting for provider data',
    });
    const supports = summary.createDiv({ cls: 'claudian-usage-dashboard-supports' });
    const activeCount = room.participants.filter(participant => (
      (participant.resourcePolicy?.mode ?? 'active') === 'active'
    )).length;
    this.renderSupportMetric(supports, 'Active routing', `${activeCount}/${room.participants.length}`);
    const freshCount = room.participants.filter(participant => (
      participant.resourcePolicy?.quotaSnapshot
      && !isQuotaSnapshotStale(participant.resourcePolicy.quotaSnapshot)
    )).length;
    this.renderSupportMetric(supports, 'Fresh snapshots', `${freshCount}/${room.participants.length}`);
    const runtimeHealth = ClaudeProcessRegistry.getSnapshot();
    this.renderSupportMetric(
      supports,
      'Claude runtimes',
      `${runtimeHealth.activeGroups}/6`,
    );

    this.renderRuntimeHealth();
    this.renderParticipants(room);
    this.renderWorkflowUsage(room);
  }

  private renderSupportMetric(container: HTMLElement, label: string, value: string): void {
    const metric = container.createDiv({ cls: 'claudian-usage-dashboard-support' });
    metric.createSpan({ cls: 'claudian-usage-dashboard-metric-label', text: label });
    metric.createSpan({ cls: 'claudian-usage-dashboard-support-value', text: value });
  }

  private renderRuntimeHealth(): void {
    const snapshot = ClaudeProcessRegistry.getSnapshot();
    const section = this.contentEl.createEl('section', {
      cls: 'claudian-usage-dashboard-runtime',
      attr: {
        'aria-label': 'Claude runtime health',
        'data-health': snapshot.health,
      },
    });
    const status = section.createDiv({ cls: 'claudian-usage-dashboard-runtime-status' });
    status.createSpan({
      cls: 'claudian-usage-dashboard-runtime-dot',
      attr: { 'aria-hidden': 'true' },
    });
    const text = status.createDiv();
    text.createEl('strong', { text: `Runtime health: ${snapshot.health}` });
    text.createSpan({
      text: snapshot.residentBytes === null
        ? `${snapshot.activeGroups} plugin-owned process groups · memory unavailable`
        : `${snapshot.activeGroups} plugin-owned process groups · ${
          Math.round(snapshot.residentBytes / 1024 ** 2).toLocaleString()
        } MiB`,
    });
    if (snapshot.terminatingGroups > 0) {
      const cleanup = section.createEl('button', {
        text: 'Clean up stopped runtimes',
        attr: { type: 'button' },
      });
      cleanup.addEventListener('click', () => {
        ClaudeProcessRegistry.cleanupStoppedGroups();
        void this.render();
      });
    }
  }

  private renderParticipants(room: CollaborationRoom): void {
    const section = this.contentEl.createEl('section', {
      cls: 'claudian-usage-dashboard-section',
      attr: { 'aria-labelledby': 'claudian-usage-participants-heading' },
    });
    section.createEl('h4', {
      text: 'Provider headroom',
      attr: { id: 'claudian-usage-participants-heading' },
    });
    const list = section.createDiv({ cls: 'claudian-usage-dashboard-participants' });

    for (const participant of room.participants) {
      const participantId = getCollaborationParticipantId(participant);
      const policy = participant.resourcePolicy;
      const snapshot = policy?.quotaSnapshot;
      const fiveHour = getFiveHourWindow(participant);
      const weekly = getWeeklyWindow(participant);
      const row = list.createDiv({ cls: 'claudian-usage-dashboard-participant' });
      const identity = row.createDiv({ cls: 'claudian-usage-dashboard-identity' });
      identity.createSpan({
        cls: 'claudian-usage-dashboard-participant-name',
        text: participant.label ?? participantId,
      });
      identity.createSpan({
        cls: 'claudian-usage-dashboard-participant-mode',
        text: policy?.mode ?? 'active',
        attr: { 'data-mode': policy?.mode ?? 'active' },
      });

      const windows = row.createDiv({ cls: 'claudian-usage-dashboard-windows' });
      this.renderWindow(windows, fiveHour);
      this.renderWindow(windows, weekly);

      const trend = row.createDiv({ cls: 'claudian-usage-dashboard-trend' });
      renderSparkline(
        trend,
        getHistoryValues(policy?.quotaHistory, weekly?.id ?? 'seven-day'),
      );
      const detail = trend.createSpan({
        text: snapshot
          ? isQuotaSnapshotStale(snapshot)
            ? `Stale · ${formatRelativeTime(snapshot.fetchedAt)}`
            : `Updated ${formatRelativeTime(snapshot.fetchedAt)}`
          : 'No provider snapshot',
      });
      if (policy?.quotaRefreshError) {
        detail.setText(
          `Refresh failed · ${policy.quotaRefreshError}${
            policy.quotaNextRetryAt
              ? ` · retry ${formatRelativeTime(policy.quotaNextRetryAt)}`
              : ''
          }`,
        );
        detail.addClass('is-error');
      }

      const recommendation = getQuotaRoutingRecommendation(policy);
      if (recommendation) {
        const action = row.createEl('button', {
          cls: 'claudian-usage-dashboard-recommendation',
          text: 'Apply preserve mode',
          attr: {
            type: 'button',
            title: recommendation.reason,
          },
        });
        action.addEventListener('click', () => {
          action.disabled = true;
          void this.options.applyRecommendation(participantId)
            .then(() => this.render())
            .finally(() => { action.disabled = false; });
        });
      }
    }
  }

  private renderWindow(container: HTMLElement, window: ProviderQuotaWindow | undefined): void {
    const item = container.createDiv({ cls: 'claudian-usage-dashboard-window' });
    if (!window) {
      item.createSpan({ text: 'Window unavailable' });
      return;
    }
    const heading = item.createDiv();
    heading.createSpan({ text: window.label });
    heading.createSpan({
      cls: 'claudian-usage-dashboard-window-value',
      text: `${window.utilizationPercent}%`,
    });
    const track = item.createDiv({
      cls: 'claudian-usage-dashboard-track',
      attr: {
        role: 'progressbar',
        'aria-label': `${window.label} usage`,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.min(100, window.utilizationPercent)),
      },
    });
    track.createDiv({
      cls: 'claudian-usage-dashboard-track-fill',
      attr: {
        style: `width: ${Math.min(100, window.utilizationPercent)}%`,
        'data-level': window.utilizationPercent >= 90
          ? 'critical'
          : window.utilizationPercent >= 70
            ? 'warning'
            : 'normal',
      },
    });
    const projection = getQuotaProjection(window);
    item.createSpan({
      cls: 'claudian-usage-dashboard-window-context',
      text: [
        window.resetsAt ? `Resets ${formatRelativeTime(window.resetsAt)}` : '',
        projection?.projectedEndPercent !== undefined
          ? `Projects ${projection.projectedEndPercent}%`
          : '',
        projection?.exhaustionAt ? `Exhaustion ${formatRelativeTime(projection.exhaustionAt)}` : '',
      ].filter(Boolean).join(' · ') || 'Reset time unavailable',
    });
  }

  private renderWorkflowUsage(room: CollaborationRoom): void {
    const checkpoints = [...room.events]
      .reverse()
      .filter(event => event.workflow?.phase === 'checkpoint' && event.resourceUsage?.length)
      .filter((event, index, events) => (
        events.findIndex(candidate => candidate.workflow?.id === event.workflow?.id) === index
      ))
      .slice(0, 5);
    const section = this.contentEl.createEl('section', {
      cls: 'claudian-usage-dashboard-section',
      attr: { 'aria-labelledby': 'claudian-workflow-usage-heading' },
    });
    section.createEl('h4', {
      text: 'Recent workflow consumption',
      attr: { id: 'claudian-workflow-usage-heading' },
    });
    if (checkpoints.length === 0) {
      section.createEl('p', {
        cls: 'claudian-usage-dashboard-empty',
        text: 'Workflow token deltas will appear after the next autonomous checkpoint.',
      });
      return;
    }
    const table = section.createEl('table', {
      cls: 'claudian-usage-dashboard-table',
      attr: { 'aria-label': 'Recent workflow context consumption' },
    });
    const header = table.createEl('thead').createEl('tr');
    for (const label of ['Workflow', 'Context delta', 'Turns', 'Completed']) {
      header.createEl('th', { text: label });
    }
    const body = table.createEl('tbody');
    for (const checkpoint of checkpoints) {
      const row = body.createEl('tr');
      row.createEl('td', { text: checkpoint.workflow?.id ?? 'Workflow' });
      const contextDelta = checkpoint.resourceUsage?.reduce(
        (total, usage) => total + usage.contextTokenDelta,
        0,
      ) ?? 0;
      row.createEl('td', { text: contextDelta.toLocaleString() });
      row.createEl('td', {
        text: String(checkpoint.resourceUsage?.reduce(
          (total, usage) => total + (usage.turns ?? 0),
          0,
        ) ?? 0),
      });
      row.createEl('td', { text: new Date(checkpoint.createdAt).toLocaleString() });
    }
    section.createEl('p', {
      cls: 'claudian-usage-dashboard-footnote',
      text: 'Context-token deltas are local workflow measurements. Subscription-backed providers do not expose per-turn monetary cost.',
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
