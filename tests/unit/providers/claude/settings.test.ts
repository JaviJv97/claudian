import {
  DEFAULT_CLAUDE_COLLABORATION_PROFILES,
  getClaudeProviderSettings,
  updateClaudeProviderSettings,
} from '@/providers/claude/settings';

describe('Claude collaboration profiles', () => {
  it('provides personal and company defaults without persisting credentials', () => {
    const settings = getClaudeProviderSettings({});

    expect(settings.collaborationProfiles).toEqual(DEFAULT_CLAUDE_COLLABORATION_PROFILES);
    expect(settings.collaborationProfiles).toEqual([
      { id: 'personal', label: 'Claude Personal', configDir: '~/.claude-personal', enabled: true },
      { id: 'company', label: 'Claude Company', configDir: '~/.claude', enabled: true },
    ]);
  });

  it('normalizes invalid, duplicate, and unsafe profile entries', () => {
    const settings = getClaudeProviderSettings({
      providerConfigs: {
        claude: {
          collaborationProfiles: [
            { id: 'work', label: ' Work ', configDir: ' ~/.claude-work ', enabled: true },
            { id: 'work', label: 'Duplicate', configDir: '~/.other', enabled: true },
            { id: '../escape', label: 'Unsafe', configDir: '~/.unsafe', enabled: true },
            { id: 'empty', label: '', configDir: '', enabled: true },
          ],
        },
      },
    });

    expect(settings.collaborationProfiles).toEqual([
      { id: 'work', label: 'Work', configDir: '~/.claude-work', enabled: true },
    ]);
  });

  it('persists a normalized profile list', () => {
    const bag: Record<string, unknown> = {};
    updateClaudeProviderSettings(bag, {
      collaborationProfiles: [
        { id: 'work', label: ' Work ', configDir: '~/.claude-work', enabled: true },
      ],
    });

    expect(getClaudeProviderSettings(bag).collaborationProfiles).toEqual([
      { id: 'work', label: 'Work', configDir: '~/.claude-work', enabled: true },
    ]);
  });
});
