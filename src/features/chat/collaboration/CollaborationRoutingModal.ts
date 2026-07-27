import { type App, Modal, Notice, Setting } from 'obsidian';

import type { CollaborationRoutingSettings } from '../../../core/types';

export class CollaborationRoutingModal extends Modal {
  private readonly draft: CollaborationRoutingSettings;

  constructor(
    app: App,
    settings: CollaborationRoutingSettings,
    private readonly participantLabels: Record<string, string>,
    private readonly onSave: (settings: CollaborationRoutingSettings) => Promise<void>,
  ) {
    super(app);
    this.draft = structuredClone(settings);
  }

  onOpen(): void {
    this.setTitle('Collaboration routing');
    this.modalEl.addClass('claudian-collaboration-routing-modal');

    new Setting(this.contentEl)
      .setName('Automatic mode selection')
      .setDesc('Choose a mode from prompt intent while preserving explicit recipients and modes.')
      .addToggle(toggle => toggle
        .setValue(this.draft.selection === 'auto')
        .onChange(value => { this.draft.selection = value ? 'auto' : 'manual'; }));

    new Setting(this.contentEl)
      .setName('Round-table starter')
      .setDesc('The first participant in each fixed-start cycle.')
      .addDropdown(dropdown => {
        for (const [id, label] of Object.entries(this.participantLabels)) {
          dropdown.addOption(id, label);
        }
        dropdown
          .setValue(
            this.draft.roundTable.startingParticipantId
              ?? this.draft.roundTable.participantOrder[0]
              ?? '',
          )
          .onChange(value => { this.draft.roundTable.startingParticipantId = value; });
      });

    new Setting(this.contentEl)
      .setName('Round-table cycles')
      .setDesc('How many complete passes run for one message.')
      .addSlider(slider => slider
        .setLimits(1, 5, 1)
        .setDynamicTooltip()
        .setValue(this.draft.roundTable.cycles)
        .onChange(value => { this.draft.roundTable.cycles = value; }));

    new Setting(this.contentEl)
      .setName('Rotate starter')
      .setDesc('Advance the first participant by one position on each later cycle.')
      .addToggle(toggle => toggle
        .setValue(this.draft.roundTable.rotateStarter)
        .onChange(value => { this.draft.roundTable.rotateStarter = value; }));

    this.renderParticipantOrder();
    this.addRoleDropdown(
      'Facilitator',
      'facilitatorParticipantId',
      'Recorded on each route; agent-assisted prompt relay is not enabled yet.',
    );
    this.addRoleDropdown(
      'Deliberation synthesizer',
      'synthesizerParticipantId',
      'Writes the synthesis before all participants ratify it.',
    );

    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const save = actions.createEl('button', { cls: 'mod-cta', text: 'Save routing' });
    save.addEventListener('click', () => {
      save.disabled = true;
      void this.onSave(structuredClone(this.draft))
        .then(() => this.close())
        .catch((error: unknown) => {
          new Notice(
            error instanceof Error
              ? `Could not save collaboration routing: ${error.message}`
              : 'Could not save collaboration routing.',
          );
        })
        .finally(() => { save.disabled = false; });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderParticipantOrder(): void {
    const container = this.contentEl.createDiv({
      cls: 'claudian-collaboration-routing-order',
    });
    container.createEl('h3', { text: 'Round-table order' });
    const list = container.createDiv();
    const render = () => {
      list.empty();
      this.draft.roundTable.participantOrder.forEach((id, index) => {
        const row = new Setting(list).setName(`${index + 1}. ${this.participantLabels[id] ?? id}`);
        row.addButton(button => button
          .setButtonText('Up')
          .setDisabled(index === 0)
          .onClick(() => {
            [this.draft.roundTable.participantOrder[index - 1],
              this.draft.roundTable.participantOrder[index]] = [
              this.draft.roundTable.participantOrder[index],
              this.draft.roundTable.participantOrder[index - 1],
            ];
            render();
          }));
        row.addButton(button => button
          .setButtonText('Down')
          .setDisabled(index === this.draft.roundTable.participantOrder.length - 1)
          .onClick(() => {
            [this.draft.roundTable.participantOrder[index],
              this.draft.roundTable.participantOrder[index + 1]] = [
              this.draft.roundTable.participantOrder[index + 1],
              this.draft.roundTable.participantOrder[index],
            ];
            render();
          }));
      });
    };
    render();
  }

  private addRoleDropdown(
    name: string,
    key: 'facilitatorParticipantId' | 'synthesizerParticipantId',
    description: string,
  ): void {
    new Setting(this.contentEl)
      .setName(name)
      .setDesc(description)
      .addDropdown(dropdown => {
        dropdown.addOption('', 'Automatic');
        for (const [id, label] of Object.entries(this.participantLabels)) {
          dropdown.addOption(id, label);
        }
        dropdown
          .setValue(this.draft[key] ?? '')
          .onChange(value => { this.draft[key] = value || undefined; });
      });
  }
}
