import type { ChatMessage } from '@/core/types';
import { findFreshAssistantMessage } from '@/features/chat/collaboration/collaborationResponse';

function assistant(id: string, content: string, isInterrupt = false): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: 1,
    isInterrupt,
  };
}

describe('findFreshAssistantMessage', () => {
  it('returns only an assistant message created after dispatch began', () => {
    const messages = [
      assistant('old-assistant', 'Old response'),
      { id: 'user-1', role: 'user' as const, content: 'New prompt', timestamp: 2 },
      assistant('new-assistant', 'New response'),
    ];

    expect(findFreshAssistantMessage(messages, new Set(['old-assistant']))?.id)
      .toBe('new-assistant');
  });

  it('does not reuse the previous assistant when no new response exists', () => {
    expect(findFreshAssistantMessage(
      [assistant('old-assistant', 'Old response')],
      new Set(['old-assistant']),
    )).toBeNull();
  });

  it('retains a fresh interrupted partial response', () => {
    expect(findFreshAssistantMessage(
      [assistant('partial', 'Partial response', true)],
      new Set(),
    )).toEqual(expect.objectContaining({
      id: 'partial',
      content: 'Partial response',
      isInterrupt: true,
    }));
  });
});
