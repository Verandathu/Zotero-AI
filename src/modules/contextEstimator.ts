import { ChatMessage } from "./apiClient";

export interface ContextUsage {
  used: number;
  reserved: number;
  limit: number;
  remaining: number;
  percent: number;
}

/** Provider-neutral, conservative local token estimate. */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  const cjk = (text.match(/[\u2e80-\u9fff\uf900-\ufaff]/g) || []).length;
  const other = text.length - cjk;
  return cjk + Math.ceil(other / 4);
}

export function estimateContextUsage(
  messages: ChatMessage[],
  limit: number,
  outputReserve = 0,
): ContextUsage {
  const safeLimit = Math.max(1, Math.floor(limit));
  const used = messages.reduce(
    (sum, message) => sum + estimateTokens(message.content) + 4,
    2,
  );
  const reserved = Math.max(0, Math.floor(outputReserve));
  const remaining = Math.max(0, safeLimit - used - reserved);
  return {
    used,
    reserved,
    limit: safeLimit,
    remaining,
    percent: Math.min(100, ((used + reserved) / safeLimit) * 100),
  };
}
