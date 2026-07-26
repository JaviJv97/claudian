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
