import { type App, Modal, Setting } from 'obsidian';

import type { ProviderId, ProviderRuntimeProfile } from '../../../core/providers/types';

export interface CollaborationParticipantChoice {
  id: string;
  providerId: ProviderId;
  label: string;
  runtimeProfileId?: string;
  available: boolean;
  unavailableReason?: string;
  selected: boolean;
}

export interface CollaborationRoomSelection {
  title: string;
  participants: CollaborationParticipantChoice[];
}

export interface CollaborationParticipantPickerOptions {
  title?: string;
  help?: string;
  submitLabel?: string;
  minimum?: number;
  maximum?: number;
}

export function chooseCollaborationParticipants(
  app: App,
  choices: CollaborationParticipantChoice[],
  options: CollaborationParticipantPickerOptions = {},
): Promise<CollaborationRoomSelection | null> {
  return new Promise(resolve => new CollaborationRoomModal(app, choices, options, resolve).open());
}

export function toClaudeParticipantChoices(
  profiles: ProviderRuntimeProfile[],
): CollaborationParticipantChoice[] {
  return profiles.map(profile => ({
    id: `claude-${profile.id}`,
    providerId: 'claude',
    label: profile.label,
    runtimeProfileId: profile.id,
    available: profile.available,
    unavailableReason: profile.unavailableReason,
    selected: profile.available,
  }));
}

class CollaborationRoomModal extends Modal {
  private resolved = false;
  private title = '';
  private readonly choices: CollaborationParticipantChoice[];

  constructor(
    app: App,
    choices: CollaborationParticipantChoice[],
    private readonly options: CollaborationParticipantPickerOptions,
    private readonly resolve: (selection: CollaborationRoomSelection | null) => void,
  ) {
    super(app);
    this.choices = choices.map(choice => ({ ...choice }));
  }

  onOpen(): void {
    const minimum = this.options.minimum ?? 2;
    const maximum = this.options.maximum ?? Number.POSITIVE_INFINITY;
    const submitLabel = this.options.submitLabel ?? 'Start collaboration';
    this.setTitle(this.options.title ?? 'Start collaboration');
    this.modalEl.addClass('claudian-collaboration-room-modal');

    const intro = this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: this.options.help
        ?? 'Choose at least two participants. Each participant opens in its own tab.',
    });
    intro.id = 'claudian-collaboration-room-help';

    new Setting(this.contentEl)
      .setName('Room name')
      .setDesc('Optional. A participant summary is used when left blank.')
      .addText(text => text
        .setPlaceholder('Project review')
        .onChange(value => { this.title = value.trim(); }));

    const participantGroup = this.contentEl.createDiv({
      cls: 'claudian-collaboration-participants',
      attr: { role: 'group', 'aria-label': 'Room participants' },
    });
    for (const choice of this.choices) {
      const setting = new Setting(participantGroup)
        .setName(choice.label)
        .setDesc(choice.available
          ? 'Available'
          : choice.unavailableReason ?? 'Unavailable');
      setting.addToggle(toggle => toggle
        .setValue(choice.selected && choice.available)
        .setDisabled(!choice.available)
        .onChange(value => { choice.selected = value; }));
    }

    const errorEl = this.contentEl.createDiv({
      cls: 'claudian-collaboration-room-error claudian-hidden',
      attr: { role: 'alert', 'aria-live': 'polite' },
    });

    const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const createButton = actions.createEl('button', {
      cls: 'mod-cta',
      text: submitLabel,
    });
    createButton.addEventListener('click', () => {
      const participants = this.choices.filter(choice => choice.selected && choice.available);
      if (participants.length < minimum || participants.length > maximum) {
        errorEl.setText(minimum === maximum
          ? `Choose exactly ${minimum} available participant${minimum === 1 ? '' : 's'}.`
          : `Choose between ${minimum} and ${maximum} available participants.`);
        errorEl.removeClass('claudian-hidden');
        return;
      }
      this.resolved = true;
      this.resolve({
        title: this.title || participants.map(participant => participant.label).join(' + '),
        participants,
      });
      this.close();
    });
  }

  onClose(): void {
    if (!this.resolved) this.resolve(null);
    this.contentEl.empty();
  }
}
