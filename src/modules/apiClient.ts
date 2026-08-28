import { getPref } from "../utils/prefs";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * Client for OpenAI-compatible chat completion APIs with SSE streaming.
 * Works with OpenAI, DeepSeek, SiliconFlow, OpenRouter, Ollama, one-api, etc.
 */
export class ApiClient {
  private abortController?: AbortController;

  get generating() {
    return !!this.abortController;
  }

  stop() {
    this.abortController?.abort();
  }

  /**
   * Send a chat completion request and stream deltas through callbacks.
   * Returns the full response text (also accumulated via onDelta).
   */
  async chatStream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
  ): Promise<string> {
    const baseURL = (getPref("baseURL") || "").replace(/\/+$/, "");
    const apiKey = getPref("apiKey");
    const model = getPref("model");
    if (!baseURL) {
      callbacks.onError("Base URL is not configured.");
      return "";
    }
    if (!model) {
      callbacks.onError("Model is not configured.");
      return "";
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      temperature: getPref("temperature"),
    };
    const maxTokens = getPref("maxTokens");
    if (maxTokens > 0) {
      body.max_tokens = maxTokens;
    }

    this.abortController = new AbortController();
    let fullText = "";
    try {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        let detail = "";
        try {
          detail = (await response.text()) || "";
        } catch {
          // Ignore body read failures
        }
        callbacks.onError(
          `HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        );
        return "";
      }

      fullText = await this.consumeSSE(response, (delta) => {
        fullText += delta;
        callbacks.onDelta(delta);
      });
      callbacks.onDone();
      return fullText;
    } catch (e: any) {
      if (e?.name === "AbortError") {
        // User stopped generation; keep what we have received
        callbacks.onDone();
        return fullText;
      }
      ztoolkit.log("Zotero AI: request failed", e);
      callbacks.onError(String(e?.message || e));
      return fullText;
    } finally {
      this.abortController = undefined;
    }
  }

  /**
   * Parse an SSE response body and invoke the callback for each content delta.
   */
  private async consumeSSE(
    response: Response,
    onDelta: (text: string) => void,
  ): Promise<string> {
    if (!response.body) {
      throw new Error("Empty response body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    for (;;) {
      const { done, value } = await (reader as any).read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by blank lines
      const events = buffer.split(/\r?\n\r?\n/);
      // Keep the last (possibly incomplete) chunk in the buffer
      buffer = events.pop() || "";
      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") {
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              fullText += delta;
              onDelta(delta);
            }
            // Surface upstream errors delivered as SSE payloads
            if (parsed?.error?.message) {
              throw new Error(parsed.error.message);
            }
          } catch (e: any) {
            if (e instanceof SyntaxError) {
              // Malformed JSON chunk; skip it
              continue;
            }
            throw e;
          }
        }
      }
    }
    return fullText;
  }
}
