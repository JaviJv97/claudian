import { Modal, Setting } from 'obsidian';

import type { CollaborationParticipantResourcePolicy } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';

export class CollaborationResourcePolicyModal extends Modal {
  private mode: CollaborationParticipantResourcePolicy['mode'];
  private weeklyUsagePercent: number | undefined;

  constructor(
    plugin: FeatureHost,
    private readonly participantLabel: string,
    private readonly current: CollaborationParticipantResourcePolicy | undefined,
    private readonly onSave: (policy: CollaborationParticipantResourcePolicy) => void,
    private readonly onRefresh?: () => Promise<void>,
  ) {
    super(plugin.app);
    this.mode = current?.mode ?? 'active';
    this.weeklyUsagePercent = current?.weeklyUsagePercent;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.setTitle(`${this.participantLabel} usage`);
    this.contentEl.createEl('p', {
      text: 'Refresh reads account limits from the local provider runtime without sending a model prompt. Manual weekly usage remains available as a fallback.',
    });
    if (this.current?.quotaSnapshot) {
      const snapshot = this.current.quotaSnapshot;
      this.contentEl.createEl('p', {
        text: snapshot.windows.length > 0
          ? snapshot.windows.map(window => `${window.label}: ${window.utilizationPercent}%`).join(' · ')
          : snapshot.unavailableReason ?? 'Provider quota unavailable',
      });
    }
    new Setting(this.contentEl)
      .setName('Routing mode')
      .setDesc('Preserve skips group and autonomous turns but still allows an explicit @mention.')
      .addDropdown(dropdown => dropdown
        .addOption('active', 'Active')
        .addOption('preserve', 'Preserve quota')
        .addOption('unavailable', 'Unavailable')
        .setValue(this.mode)
        .onChange((value) => {
          this.mode = value as CollaborationParticipantResourcePolicy['mode'];
        }));
    new Setting(this.contentEl)
      .setName('Provider quota')
      .setDesc('Fetch the latest provider-reported limits for this account.')
      .addButton(button => button
        .setButtonText('Refresh from provider')
        .onClick(() => {
          if (!this.onRefresh) return;
          button.setDisabled(true);
          button.setButtonText('Refreshing…');
          void this.onRefresh()
            .then(() => this.close())
            .catch(() => {
              button.setDisabled(false);
              button.setButtonText('Refresh from provider');
            });
        }));
    new Setting(this.contentEl)
      .setName('Weekly usage')
      .setDesc('Optional percentage shown in the room. Enter 0–100.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '0';
        text.inputEl.max = '100';
        text.inputEl.inputMode = 'numeric';
        text
          .setPlaceholder('96')
          .setValue(this.weeklyUsagePercent?.toString() ?? '')
          .onChange((value) => {
          const parsed = Number(value);
          this.weeklyUsagePercent = value.trim() && Number.isFinite(parsed)
            ? Math.max(0, Math.min(100, Math.round(parsed)))
            : undefined;
          });
      });
    new Setting(this.contentEl)
      .addButton(button => button
        .setButtonText('Save usage policy')
        .setCta()
        .onClick(() => {
          this.onSave({
            mode: this.mode,
            weeklyUsagePercent: this.weeklyUsagePercent,
            quotaSnapshot: this.current?.quotaSnapshot,
          });
          this.close();
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
