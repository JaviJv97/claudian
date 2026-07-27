import { Modal, Setting } from 'obsidian';

import type { CollaborationParticipantResourcePolicy } from '../../../core/types';
import type { FeatureHost } from '../../FeatureHost';

export class CollaborationResourcePolicyModal extends Modal {
  private mode: CollaborationParticipantResourcePolicy['mode'];
  private weeklyUsagePercent: number | undefined;

  constructor(
    plugin: FeatureHost,
    private readonly participantLabel: string,
    current: CollaborationParticipantResourcePolicy | undefined,
    private readonly onSave: (policy: CollaborationParticipantResourcePolicy) => void,
  ) {
    super(plugin.app);
    this.mode = current?.mode ?? 'active';
    this.weeklyUsagePercent = current?.weeklyUsagePercent;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.setTitle(`${this.participantLabel} usage`);
    this.contentEl.createEl('p', {
      text: 'Weekly quota is user-reported because provider account limits are not exposed reliably.',
    });
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
          });
          this.close();
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
