import { getPref } from "../utils/prefs";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  /** Chain-of-thought deltas from reasoning models (shown separately) */
  onReasoning?: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

/**
 * Client for OpenAI-compatible chat completion APIs with SSE streaming.
 * Works with OpenAI, DeepSeek, SiliconFlow, OpenRouter, Ollama, one-api, etc.
 */
export class ApiClient {
  private abortController?: AbortController;
  // Set when AbortController is unavailable and stop() relies on a flag
  private softStopped = false;

  /**
   * The plugin sandbox has no top-level DOM globals (AbortController,
   * fetch, TextDecoder) — resolve them from the main window.
   */
  private win(): any {
    return (
      Zotero.getMainWindow() || (Zotero as any).getActiveZoteroPane?.()?.window
    );
  }

  get generating() {
    return !!this.abortController || this.softStopped;
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
    } else {
      this.softStopped = true;
    }
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

    this.softStopped = false;
    const win = this.win();
    const Ctor = win?.AbortController;
    const doFetch =
      win?.fetch?.bind(win) || (globalThis as any).fetch?.bind(globalThis);
    if (!doFetch) {
      callbacks.onError("fetch is not available in this environment.");
      return "";
    }
    if (Ctor) {
      this.abortController = new Ctor();
    }
    let fullText = "";
    try {
      const response = await doFetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        ...(this.abortController
          ? { signal: this.abortController.signal }
          : {}),
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

      fullText = await this.consumeSSE(
        response,
        (delta) => {
          fullText += delta;
          callbacks.onDelta(delta);
        },
        (reasoning) => {
          callbacks.onReasoning?.(reasoning);
        },
      );
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
      this.softStopped = false;
    }
  }

  /**
   * Send a single non-streaming completion and return the plain text.
   * Used for lightweight side tasks (e.g. generating conversation titles)
   * that should not disturb the streaming chat loop.
   */
  async complete(
    messages: ChatMessage[],
    options: { maxTokens?: number; temperature?: number } = {},
  ): Promise<string> {
    const baseURL = (getPref("baseURL") || "").replace(/\/+$/, "");
    const apiKey = getPref("apiKey");
    const model = getPref("model");
    if (!baseURL || !model) {
      return "";
    }
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      temperature: options.temperature ?? getPref("temperature"),
    };
    const maxTokens = options.maxTokens ?? getPref("maxTokens");
    if (maxTokens > 0) {
      body.max_tokens = maxTokens;
    }
    const win = this.win();
    const doFetch =
      win?.fetch?.bind(win) || (globalThis as any).fetch?.bind(globalThis);
    if (!doFetch) {
      return "";
    }
    try {
      const response = await doFetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        return "";
      }
      const data = await response.json();
      return (
        data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? ""
      );
    } catch (e) {
      ztoolkit.log("Zotero AI: completion request failed", e);
      return "";
    }
  }

  /**
   * Summarize a conversation's opening message(s) into a short title,
   * mirroring Gemini's auto-generated chat names.
   */
  async summarizeTitle(text: string): Promise<string> {
    const raw = await this.complete(
      [
        {
          role: "system",
          content:
            "You generate short, descriptive titles. Given a user's opening message, reply with a title of at most 6 words that captures its topic. Output only the title — no quotes, no period, no explanation.",
        },
        { role: "user", content: text.slice(0, 3000) },
      ],
      { maxTokens: 16, temperature: 0.2 },
    );
    const title = raw
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .replace(/[.。]$/, "")
      .trim();
    return title.slice(0, 72);
  }

  /**
   * Parse an SSE response body and invoke the callback for each content delta.
   */
  private async consumeSSE(
    response: Response,
    onDelta: (text: string) => void,
    onReasoning: (text: string) => void,
  ): Promise<string> {
    if (!response.body) {
      throw new Error("Empty response body");
    }
    const reader = response.body.getReader();
    const win = this.win();
    const Decoder = win?.TextDecoder || (globalThis as any).TextDecoder;
    const decoder = Decoder ? new Decoder() : undefined;
    let buffer = "";
    let fullText = "";
    for (;;) {
      if (this.softStopped) {
        // AbortController unavailable; polling flag for stop requests
        try {
          await reader.cancel();
        } catch {
          // Ignore
        }
        break;
      }
      const { done, value } = await (reader as any).read();
      if (done) {
        break;
      }
      buffer += decoder
        ? decoder.decode(value, { stream: true })
        : String.fromCharCode(...new Uint8Array(value));
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
            const delta = parsed?.choices?.[0]?.delta;
            // Standard OpenAI delta content
            if (typeof delta?.content === "string" && delta.content) {
              fullText += delta.content;
              onDelta(delta.content);
            }
            // Reasoning models (GLM, DeepSeek-R1, QwQ...) stream their chain
            // of thought in `reasoning_content`; show it in the bubble but
            // don't store it as the answer
            if (
              typeof delta?.reasoning_content === "string" &&
              delta.reasoning_content
            ) {
              onReasoning(delta.reasoning_content);
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
