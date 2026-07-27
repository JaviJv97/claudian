import type { ChatMessage } from '@/core/types';
import {
  findFreshAssistantMessage,
  waitForFreshAssistantMessage,
} from '@/features/chat/collaboration/collaborationResponse';

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

describe('waitForFreshAssistantMessage', () => {
  it('waits for a provider response that hydrates after sendMessage resolves', async () => {
    const messages: ChatMessage[] = [assistant('old-assistant', 'Old response')];
    let elapsed = 0;

    const result = await waitForFreshAssistantMessage({
      getMessages: () => messages,
      existingMessageIds: new Set(['old-assistant']),
      timeoutMs: 200,
      pollIntervalMs: 50,
      now: () => elapsed,
      wait: async (durationMs) => {
        elapsed += durationMs;
        if (elapsed === 100) messages.push(assistant('late-assistant', 'Late response'));
      },
    });

    expect(result?.id).toBe('late-assistant');
  });

  it('returns null after the bounded hydration window', async () => {
    let elapsed = 0;

    const result = await waitForFreshAssistantMessage({
      getMessages: () => [],
      existingMessageIds: new Set(),
      timeoutMs: 100,
      pollIntervalMs: 25,
      now: () => elapsed,
      wait: async (durationMs) => { elapsed += durationMs; },
    });

    expect(result).toBeNull();
    expect(elapsed).toBe(100);
  });

  it('aborts while waiting instead of recording a response failure', async () => {
    let elapsed = 0;
    const controller = new AbortController();

    await expect(waitForFreshAssistantMessage({
      getMessages: () => [],
      existingMessageIds: new Set(),
      signal: controller.signal,
      timeoutMs: 100,
      pollIntervalMs: 25,
      now: () => elapsed,
      wait: async (durationMs) => {
        elapsed += durationMs;
        controller.abort();
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not accept a newly hydrated message after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForFreshAssistantMessage({
      getMessages: () => [assistant('late-assistant', 'Late response')],
      existingMessageIds: new Set(),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('handles a zero timeout without polling', async () => {
    const wait = jest.fn(async () => undefined);

    await expect(waitForFreshAssistantMessage({
      getMessages: () => [],
      existingMessageIds: new Set(),
      timeoutMs: 0,
      wait,
    })).resolves.toBeNull();
    expect(wait).not.toHaveBeenCalled();
  });
});
