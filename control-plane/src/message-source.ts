import type { ContextFormed } from "@deepseek-ai/dsh-llm";

/**
 * The message-source kind this package produces. dsh 0.1.7 replaced the
 * shared `plugin` source kind with merge-extensible producer kinds, so this
 * package declares its own: managed instructions carry `form: 'instructions'`
 * and sandbox notices carry `form: 'notice'`.
 */
export const YAWN_MESSAGE_SOURCE = "dsh-yawn" as const;

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    [YAWN_MESSAGE_SOURCE]: { kind: typeof YAWN_MESSAGE_SOURCE } & ContextFormed;
  }
}
