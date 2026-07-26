import * as fs from 'fs';
import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type { ProviderSettingsTabRenderer } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { McpSettingsManager } from '../../../shared/settings/McpSettingsManager';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import { getClaudeWorkspaceServices } from '../app/ClaudeWorkspaceServices';
import { resolveClaudeModelSelection } from '../modelOptions';
import {
  CLAUDE_SAFE_MODES,
  type ClaudeCollaborationProfile,
  type ClaudeSafeMode,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '../settings';
import { AgentSettings } from './AgentSettings';
import { claudeChatUIConfig } from './ClaudeChatUIConfig';
import { PluginSettingsManager } from './PluginSettingsManager';
import { SlashCommandSettings } from './SlashCommandSettings';

export const claudeSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const claudeWorkspace = getClaudeWorkspaceServices();
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const claudeSettings = getClaudeProviderSettings(settingsBag);

    const reconcileActiveClaudeModelSelection = (settings: Record<string, unknown>): void => {
      const activeProvider = settings.settingsProvider;
      if (activeProvider !== undefined && activeProvider !== 'claude') {
        return;
      }

      const currentModel = typeof settings.model === 'string' ? settings.model : '';
      const nextModel = resolveClaudeModelSelection(settings, currentModel);
      if (!nextModel || nextModel === currentModel) {
        return;
      }

      settings.model = nextModel;
      claudeChatUIConfig.applyModelDefaults(nextModel, settings);
    };

    // --- Setup ---

    new Setting(container).setName(t('settings.setup')).setHeading();

    const hostnameKey = getHostnameKey();
    const platformDesc = process.platform === 'win32'
      ? t('settings.cliPath.descWindows')
      : t('settings.cliPath.descUnix');
    const cliPathDescription = `${t('settings.cliPath.desc')} ${platformDesc}`;

    const cliPathSetting = new Setting(container)
      .setName(t('settings.cliPath.name'))
      .setDesc(cliPathDescription);

    const validationEl = container.createDiv({
      cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });

    const validatePath = (value: string): string | null => {
      const trimmed = value.trim();
      if (!trimmed) return null;

      const expandedPath = expandHomePath(trimmed);

      if (!fs.existsSync(expandedPath)) {
        return t('settings.cliPath.validation.notExist');
      }
      const stat = fs.statSync(expandedPath);
      if (!stat.isFile()) {
        return t('settings.cliPath.validation.isDirectory');
      }
      return null;
    };

    const updateCliPathValidation = (value: string, inputEl?: HTMLInputElement): boolean => {
      const error = validatePath(value);
      if (error) {
        validationEl.setText(error);
        validationEl.toggleClass('claudian-hidden', false);
        if (inputEl) {
          inputEl.toggleClass('claudian-input-error', true);
        }
        return false;
      }

      validationEl.toggleClass('claudian-hidden', true);
      if (inputEl) {
        inputEl.toggleClass('claudian-input-error', false);
      }
      return true;
    };

    const currentValue = claudeSettings.cliPathsByHost[hostnameKey] || '';
    const cliPathsByHost = { ...claudeSettings.cliPathsByHost };
    let cliPathInputEl: HTMLInputElement | null = null;

    const persistCliPath = async (value: string): Promise<boolean> => {
      const isValid = updateCliPathValidation(value, cliPathInputEl ?? undefined);
      if (!isValid) {
        return false;
      }

      const trimmed = value.trim();
      if (trimmed) {
        cliPathsByHost[hostnameKey] = trimmed;
      } else {
        delete cliPathsByHost[hostnameKey];
      }

      await context.plugin.mutateSettings((settings) => {
        updateClaudeProviderSettings(settings, { cliPathsByHost: { ...cliPathsByHost } });
      });
      claudeWorkspace.cliResolver.reset();
      await context.plugin.recycleProviderRuntimes?.('claude');
      return true;
    };

    cliPathSetting.addText((text) => {
      const placeholder = process.platform === 'win32'
        ? 'D:\\nodejs\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs'
        : '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs';

      text
        .setPlaceholder(placeholder)
        .setValue(currentValue)
        .onChange(async (value) => {
          await persistCliPath(value);
        });
      text.inputEl.addClass('claudian-settings-cli-path-input');
      cliPathInputEl = text.inputEl;

      updateCliPathValidation(currentValue, text.inputEl);
    });

    // --- Collaboration profiles ---

    new Setting(container).setName('Collaboration profiles').setHeading();
    container.createEl('p', {
      cls: 'setting-item-description',
      text: 'Add one profile per Claude account. Claudian checks only whether the config directory exists; credentials remain in Claude’s own files.',
    });
    const profilesContainer = container.createDiv({
      cls: 'claudian-collaboration-profile-settings',
    });
    let profiles = claudeSettings.collaborationProfiles.map(profile => ({ ...profile }));

    const persistProfiles = async (): Promise<void> => {
      await context.plugin.mutateSettings((settings) => {
        const updated = updateClaudeProviderSettings(settings, {
          collaborationProfiles: profiles.map(profile => ({ ...profile })),
        });
        profiles = updated.collaborationProfiles.map(profile => ({ ...profile }));
      });
      await context.plugin.recycleProviderRuntimes?.('claude');
    };

    const renderProfiles = (): void => {
      profilesContainer.empty();
      profiles.forEach((profile, index) => {
        const expandedPath = expandHomePath(profile.configDir);
        const directoryExists = (() => {
          try {
            return fs.statSync(expandedPath).isDirectory();
          } catch {
            return false;
          }
        })();

        const row = new Setting(profilesContainer)
          .setName(profile.label || 'Unnamed profile')
          .setDesc(directoryExists
            ? `Ready · ${profile.configDir}`
            : `Directory not found · ${profile.configDir}`);
        row.addToggle(toggle => toggle
          .setValue(profile.enabled)
          .onChange(async (enabled) => {
            profiles[index] = { ...profiles[index], enabled };
            await persistProfiles();
            renderProfiles();
          }));
        const removeButton = (row.controlEl ?? profilesContainer).createEl('button', {
          cls: 'clickable-icon',
          text: '×',
          attr: { 'aria-label': `Remove ${profile.label || 'profile'}` },
        });
        removeButton.onclick = async () => {
          profiles = profiles.filter((_, candidateIndex) => candidateIndex !== index);
          await persistProfiles();
          renderProfiles();
        };

        const fields = profilesContainer.createDiv({
          cls: 'claudian-collaboration-profile-fields',
        });
        const commitField = async (
          updates: Partial<ClaudeCollaborationProfile>,
        ): Promise<void> => {
          profiles[index] = { ...profiles[index], ...updates };
          await persistProfiles();
          renderProfiles();
        };
        new Setting(fields).setName('Name').addText(text => {
          text.setValue(profile.label).setPlaceholder('Claude work');
          text.inputEl.addEventListener('blur', () => {
            const label = text.getValue().trim();
            if (label && label !== profile.label) void commitField({ label });
          });
        });
        new Setting(fields).setName('Profile ID').addText(text => {
          text.setValue(profile.id).setPlaceholder('Profile-id');
          text.inputEl.addEventListener('blur', () => {
            const id = text.getValue().trim();
            if (id && id !== profile.id) void commitField({ id });
          });
        });
        new Setting(fields).setName('Config directory').addText(text => {
          text.setValue(profile.configDir).setPlaceholder('Config directory');
          text.inputEl.addEventListener('blur', () => {
            const configDir = text.getValue().trim();
            if (configDir && configDir !== profile.configDir) {
              void commitField({ configDir });
            }
          });
        });
      });
    };

    const addProfileSetting = new Setting(container)
      .setName('Add another Claude account')
      .setDesc('Use a unique profile ID and a separate Claude config directory.');
    const addProfileButton = (addProfileSetting.controlEl ?? container).createEl('button', {
      text: 'Add profile',
    });
    addProfileButton.onclick = () => {
      let suffix = profiles.length + 1;
      while (profiles.some(profile => profile.id === `profile-${suffix}`)) suffix += 1;
      profiles.push({
        id: `profile-${suffix}`,
        label: `Claude Profile ${suffix}`,
        configDir: `~/.claude-profile-${suffix}`,
        enabled: false,
      });
      void persistProfiles().then(renderProfiles);
    };
    renderProfiles();

    // --- Safety ---

    new Setting(container).setName(t('settings.safety')).setHeading();

    new Setting(container)
      .setName(t('settings.claudeSafeMode.name'))
      .setDesc(t('settings.claudeSafeMode.desc'))
      .addDropdown((dropdown) => {
        for (const mode of CLAUDE_SAFE_MODES) {
          dropdown.addOption(mode, mode);
        }
        dropdown
          .setValue(claudeSettings.safeMode)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(
                settings,
                { safeMode: value as ClaudeSafeMode },
              );
            });
          });
      });

    new Setting(container)
      .setName(t('settings.loadUserSettings.name'))
      .setDesc(t('settings.loadUserSettings.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(claudeSettings.loadUserSettings)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(settings, { loadUserSettings: value });
            });
          })
      );

    // --- Models ---

    new Setting(container).setName(t('settings.models')).setHeading();

    new Setting(container)
      .setName(t('settings.customModels.name'))
      .setDesc(t('settings.customModels.desc'))
      .addTextArea((text) => {
        let pendingCustomModels = claudeSettings.customModels;
        let savedCustomModels = claudeSettings.customModels;

        const commitCustomModels = async (): Promise<void> => {
          if (pendingCustomModels === savedCustomModels) {
            return;
          }

          const nextCustomModels = pendingCustomModels;
          await context.plugin.mutateSettings((settings) => {
            updateClaudeProviderSettings(settings, { customModels: nextCustomModels });
            reconcileActiveClaudeModelSelection(settings);
            ProviderSettingsCoordinator.reconcileTitleGenerationModelSelection(settings);
          });
          savedCustomModels = nextCustomModels;
          context.notifyProviderModelOptionsChanged('claude');
        };

        text
          .setPlaceholder(t('settings.customModels.placeholder'))
          .setValue(claudeSettings.customModels)
          .onChange((value) => {
            pendingCustomModels = value;
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
        text.inputEl.addEventListener('blur', () => {
          void commitCustomModels();
        });
      });

    // --- Slash Commands ---

    new Setting(container).setName(t('settings.slashCommands.name')).setHeading();

    const slashCommandsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    const descP = slashCommandsDesc.createEl('p', { cls: 'setting-item-description' });
    descP.appendText(t('settings.slashCommands.desc') + ' ');
    descP.createEl('a', {
      text: 'Learn more',
      href: 'https://code.claude.com/docs/en/skills',
    });

    const slashCommandsContainer = container.createDiv({ cls: 'claudian-slash-commands-container' });
    new SlashCommandSettings(
      slashCommandsContainer,
      context.plugin.app,
      claudeWorkspace.vaultCommandRepository,
    );

    context.renderHiddenProviderCommandSetting(container, 'claude', {
      name: t('settings.hiddenSlashCommands.name'),
      desc: t('settings.hiddenSlashCommands.desc'),
      placeholder: t('settings.hiddenSlashCommands.placeholder'),
    });

    // --- Subagents ---

    new Setting(container).setName(t('settings.subagents.name')).setHeading();

    const agentsDesc = container.createDiv({ cls: 'claudian-sp-settings-desc' });
    agentsDesc.createEl('p', {
      text: t('settings.subagents.desc'),
      cls: 'setting-item-description',
    });

    const agentsContainer = container.createDiv({ cls: 'claudian-agents-container' });
    new AgentSettings(agentsContainer, {
      app: context.plugin.app,
      agentManager: claudeWorkspace.agentManager,
      agentStorage: claudeWorkspace.agentStorage,
    });

    // --- MCP Servers ---

    new Setting(container).setName(t('settings.mcpServers.name')).setHeading();

    const mcpDesc = container.createDiv({ cls: 'claudian-mcp-settings-desc' });
    mcpDesc.createEl('p', {
      text: t('settings.mcpServers.desc'),
      cls: 'setting-item-description',
    });

    const mcpContainer = container.createDiv({ cls: 'claudian-mcp-container' });
    new McpSettingsManager(mcpContainer, {
      app: context.plugin.app,
      mcpStorage: claudeWorkspace.mcpStorage,
      broadcastMcpReload: async () => {
        await context.plugin.broadcastToAllViewRuntimes?.(
          (service) => service.reloadMcpServers(),
        );
      },
    });

    // --- Plugins ---

    new Setting(container).setName(t('settings.plugins.name')).setHeading();

    const pluginsDesc = container.createDiv({ cls: 'claudian-plugin-settings-desc' });
    pluginsDesc.createEl('p', {
      text: t('settings.plugins.desc'),
      cls: 'setting-item-description',
    });

    const pluginsContainer = container.createDiv({ cls: 'claudian-plugins-container' });
    new PluginSettingsManager(pluginsContainer, {
      pluginManager: claudeWorkspace.pluginManager,
      agentManager: claudeWorkspace.agentManager,
      restartTabs: async () => {
        await context.plugin.broadcastToActiveViewRuntimes?.(
          async (service) => { await service.ensureReady({ force: true }); },
        );
      },
    });

    // --- Environment ---

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:claude',
      heading: t('settings.environment'),
      name: t('settings.customVariables.name'),
      desc: 'Claude-owned runtime variables only. Use this for ANTHROPIC_* and Claude-specific toggles.',
      placeholder: 'ANTHROPIC_API_KEY=your-key\nANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_MODEL=custom-model\nCLAUDE_CODE_USE_BEDROCK=1',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'claude'),
    });

    // --- Experimental ---

    new Setting(container).setName(t('settings.experimental')).setHeading();

    new Setting(container)
      .setName(t('settings.enableChrome.name'))
      .setDesc(t('settings.enableChrome.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(claudeSettings.enableChrome)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(settings, { enableChrome: value });
            });
          })
      );

    new Setting(container)
      .setName(t('settings.enableBangBash.name'))
      .setDesc(t('settings.enableBangBash.desc'))
      .addToggle((toggle) =>
        toggle
          .setValue(claudeSettings.enableBangBash)
          .onChange(async (value) => {
            bangBashValidationEl.toggleClass('claudian-hidden', true);
            if (value) {
              const { findNodeExecutable, getEnhancedPath } = await import('../../../utils/env');
              const nodePath = findNodeExecutable(getEnhancedPath());
              if (!nodePath) {
                bangBashValidationEl.setText(t('settings.enableBangBash.validation.noNode'));
                bangBashValidationEl.toggleClass('claudian-hidden', false);
                toggle.setValue(false);
                return;
              }
            }
            await context.plugin.mutateSettings((settings) => {
              updateClaudeProviderSettings(settings, { enableBangBash: value });
            });
          })
      );

    const bangBashValidationEl = container.createDiv({
      cls: 'claudian-bang-bash-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
    });
  },
};
