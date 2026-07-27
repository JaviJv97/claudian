import type { ChatMessage } from '../../../core/types';

export function findFreshAssistantMessage(
  messages: readonly ChatMessage[],
  existingMessageIds: ReadonlySet<string>,
): ChatMessage | null {
  return [...messages].reverse().find(message => (
    message.role === 'assistant'
    && !existingMessageIds.has(message.id)
    && message.content.trim().length > 0
  )) ?? null;
}

export interface WaitForFreshAssistantMessageOptions {
  getMessages: () => readonly ChatMessage[];
  existingMessageIds: ReadonlySet<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  wait?: (durationMs: number) => Promise<void>;
  now?: () => number;
}

export const COLLABORATION_RESPONSE_HYDRATION_TIMEOUT_MS = 30_000;

function defaultWait(durationMs: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, durationMs));
}

/**
 * Provider runtimes can resolve sendMessage before their final assistant
 * message has propagated into the tab state. Give that state a bounded,
 * abort-aware hydration window instead of immediately recording a false
 * delivery failure.
 */
export async function waitForFreshAssistantMessage(
  options: WaitForFreshAssistantMessageOptions,
): Promise<ChatMessage | null> {
  const timeoutMs = Math.max(
    0,
    options.timeoutMs ?? COLLABORATION_RESPONSE_HYDRATION_TIMEOUT_MS,
  );
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const wait = options.wait ?? defaultWait;
  const now = options.now ?? Date.now;
  const startedAt = now();

  while (true) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const message = findFreshAssistantMessage(
      options.getMessages(),
      options.existingMessageIds,
    );
    if (message) return message;
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) return null;
    await wait(Math.min(pollIntervalMs, timeoutMs - elapsed));
  }
}
