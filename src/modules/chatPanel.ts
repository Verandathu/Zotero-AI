import { getLocaleID, getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { ApiClient, ChatMessage } from "./apiClient";
import { ChatManager } from "./chatManager";
import { ContextProvider, ItemContext } from "./contextProvider";
import { getQuickPrompts } from "./quickPrompts";

// Module top-level code must not reference the global `addon` — bundled
// modules evaluate before index.ts assigns it. The ref is fixed at build time.
const PANE_ID = "zoteroai-chat";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

interface PanelContext {
  body: HTMLElement;
  doc: Document;
  convID: string | null;
  /** Item key the panel is currently bound to (for the filter view) */
  filterKey: string | null;
}

export class ChatPanel {
  apiClient = new ApiClient();
  chatManager = new ChatManager();
  contextProvider = new ContextProvider();

  // One panel context per mounted UI (library section, reader overlay, ...)
  private panels = new Map<HTMLElement, PanelContext>();

  register() {
    let result: false | string;
    try {
      result = this.doRegister();
    } catch (e) {
      ztoolkit.log("Zotero AI: registerSection threw", e);
      return;
    }
    ztoolkit.log(`Zotero AI: section registered, result = ${result}`);
  }

  private doRegister(): false | string {
    return Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: addon.data.config.addonID,
      header: {
        l10nID: getLocaleID("section-chat-header"),
        icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      },
      sidenav: {
        l10nID: getLocaleID("section-chat-sidenav"),
        icon: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
      },
      bodyXHTML: `<html:div class="zoteroai-root" xmlns:html="${XHTML_NS}" style="display:flex;flex-direction:column;height:100%"></html:div>`,
      onRender: ({ body, item, tabType }: any) => {
        void this.mountSection(body, item, tabType);
      },
      onItemChange: ({ item, tabType, setEnabled }: any) => {
        // In reader tabs the chat lives in the reader's left sidebar instead
        setEnabled(tabType === "library" && !!item);
      },
    });
  }

  unregister() {
    try {
      Zotero.ItemPaneManager.unregisterSection(PANE_ID);
    } catch (e) {
      ztoolkit.log("Zotero AI: unregisterSection failed", e);
    }
  }

  /**
   * Mount (or update) the chat inside a library item pane section body.
   */
  private async mountSection(
    body: HTMLElement,
    item?: Zotero.Item,
    _tabType?: string,
  ) {
    await this.chatManager.load();
    const ctx = this.ensurePanel(body, body.ownerDocument!);
    if (item) {
      this.updateItemBadge(ctx, item);
    }
    this.renderToolbar(ctx, item);
    this.renderQuickPrompts(ctx);
    this.renderMessages(ctx);
  }

  /**
   * Mount the chat inside a reader sidebar overlay container.
   */
  async mountReaderPanel(root: HTMLElement, doc: Document) {
    await this.chatManager.load();
    const ctx = this.ensurePanel(root, doc);
    const item = this.contextProvider.getCurrentItem();
    if (item) {
      this.updateItemBadge(ctx, item);
      if (
        (root.querySelector(".zoteroai-ctx-follow") as HTMLInputElement)
          ?.checked
      ) {
        ctx.filterKey = item.key;
      }
    }
    this.renderToolbar(ctx, item);
    this.renderQuickPrompts(ctx);
    this.renderMessages(ctx);
  }

  /** Build the UI structure into the container once, and bind events. */
  private ensurePanel(body: HTMLElement, doc: Document): PanelContext {
    let ctx = this.panels.get(body);
    if (ctx) {
      return ctx;
    }
    ctx = { body, doc, convID: null, filterKey: null };
    this.panels.set(body, ctx);
    this.buildUI(ctx);
    this.bindEvents(ctx);
    return ctx;
  }

  private el(
    doc: Document,
    tag: string,
    cls?: string,
    text?: string,
  ): HTMLElement {
    const e = doc.createElementNS(XHTML_NS, tag) as HTMLElement;
    if (cls) {
      e.className = cls;
    }
    if (text !== undefined) {
      e.textContent = text;
    }
    return e;
  }

  /** Programmatically build the chat UI (works in XUL and HTML documents). */
  private buildUI(ctx: PanelContext) {
    const { body, doc } = ctx;
    const toolbar = this.el(doc, "div", "zoteroai-toolbar");

    const select = this.el(
      doc,
      "select",
      "zoteroai-conversation-select",
    ) as HTMLSelectElement;
    select.title = "Conversation";
    toolbar.appendChild(select);

    const btnNew = this.el(doc, "button", "zoteroai-btn-new", "+");
    btnNew.title = getString("tooltip-new");
    btnNew.textContent = "＋";
    toolbar.appendChild(btnNew);

    const btnDel = this.el(doc, "button", "zoteroai-btn-delete");
    btnDel.title = getString("tooltip-delete");
    btnDel.textContent = "🗑";
    toolbar.appendChild(btnDel);

    const followLabel = this.el(doc, "label", "zoteroai-mini-toggle");
    const follow = this.el(doc, "input") as HTMLInputElement;
    follow.type = "checkbox";
    follow.checked = true;
    follow.classList.add("zoteroai-ctx-follow");
    followLabel.appendChild(follow);
    followLabel.appendChild(
      this.el(doc, "span", undefined, getString("toggle-follow")),
    );
    toolbar.appendChild(followLabel);

    const fullTextLabel = this.el(doc, "label", "zoteroai-mini-toggle");
    const fullText = this.el(doc, "input") as HTMLInputElement;
    fullText.type = "checkbox";
    fullText.checked = !!getPref("includeFullText");
    fullText.classList.add("zoteroai-ctx-fulltext");
    fullTextLabel.appendChild(fullText);
    fullTextLabel.appendChild(
      this.el(doc, "span", undefined, getString("toggle-fulltext")),
    );
    toolbar.appendChild(fullTextLabel);

    const badge = this.el(doc, "div", "zoteroai-context-badge");
    toolbar.appendChild(badge);

    body.appendChild(toolbar);
    body.appendChild(this.el(doc, "div", "zoteroai-messages"));
    body.appendChild(this.el(doc, "div", "zoteroai-quick-prompts"));

    // Floating rounded input bar with a circular send button (Gemini style)
    const inputRow = this.el(doc, "div", "zoteroai-input-row");
    const input = this.el(
      doc,
      "textarea",
      "zoteroai-input",
    ) as HTMLTextAreaElement;
    input.rows = 1;
    input.placeholder = getString("panel-input-hint");
    inputRow.appendChild(input);
    const btnCol = this.el(doc, "div", "zoteroai-btn-col");
    const btnSend = this.el(doc, "button", "zoteroai-btn-send");
    btnSend.title = getString("panel-send");
    btnSend.textContent = "➤";
    btnCol.appendChild(btnSend);
    const btnStop = this.el(doc, "button", "zoteroai-btn-stop", "■");
    btnStop.title = getString("panel-stop");
    btnStop.hidden = true;
    btnCol.appendChild(btnStop);
    inputRow.appendChild(btnCol);
    body.appendChild(inputRow);

    // Auto-grow the textarea while typing
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });
  }

  private bindEvents(ctx: PanelContext) {
    const { body } = ctx;
    const $ = (sel: string) => body.querySelector(sel);

    ($(".zoteroai-conversation-select") as HTMLSelectElement)?.addEventListener(
      "change",
      (e: any) => {
        this.chatManager.setActive(e.target.value);
        ctx.convID = e.target.value;
        this.renderMessages(ctx);
      },
    );

    $(".zoteroai-btn-new")?.addEventListener("click", () => {
      const item = this.contextProvider.getCurrentItem();
      const conv = this.chatManager.createConversation(
        item
          ? { key: item.key, title: this.contextProvider.getItemTitle(item) }
          : undefined,
      );
      ctx.convID = conv.id;
      this.renderToolbar(ctx, item);
      this.renderMessages(ctx);
    });

    $(".zoteroai-btn-delete")?.addEventListener("click", () => {
      if (ctx.convID) {
        this.chatManager.deleteConversation(ctx.convID);
        ctx.convID = this.chatManager.active?.id || null;
        this.renderToolbar(ctx, this.contextProvider.getCurrentItem());
        this.renderMessages(ctx);
      }
    });

    $(".zoteroai-btn-send")?.addEventListener(
      "click",
      () => void this.send(ctx),
    );
    $(".zoteroai-btn-stop")?.addEventListener("click", () =>
      this.apiClient.stop(),
    );

    ($(".zoteroai-ctx-fulltext") as HTMLInputElement)?.addEventListener(
      "click",
      (e: any) => {
        setPref("includeFullText", e.target.checked);
      },
    );

    const input = $(".zoteroai-input") as HTMLTextAreaElement;
    input?.addEventListener("keydown", (e: any) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send(ctx);
      }
    });
  }

  private updateItemBadge(ctx: PanelContext, item: Zotero.Item) {
    const badge = ctx.body.querySelector(
      ".zoteroai-context-badge",
    ) as HTMLElement;
    if (badge) {
      badge.textContent = this.contextProvider.getItemTitle(item);
      badge.title = this.contextProvider.getItemTitle(item);
    }
  }

  /** Fill the conversation dropdown for the current filter view. */
  private renderToolbar(ctx: PanelContext, item?: Zotero.Item) {
    const { body, doc } = ctx;
    const select = body.querySelector(
      ".zoteroai-conversation-select",
    ) as HTMLSelectElement;
    if (!select) {
      return;
    }
    const fullTextCheckbox = body.querySelector(
      ".zoteroai-ctx-fulltext",
    ) as HTMLInputElement;
    if (fullTextCheckbox) {
      fullTextCheckbox.checked = !!getPref("includeFullText");
    }

    const conversations = this.chatManager.listFor(ctx.filterKey);
    select.innerHTML = "";
    for (const conv of conversations) {
      const option = this.el(
        doc,
        "option",
        undefined,
        conv.title,
      ) as HTMLOptionElement;
      option.value = conv.id;
      select.appendChild(option);
    }
    if (!conversations.length) {
      const option = this.el(
        doc,
        "option",
        undefined,
        "—",
      ) as HTMLOptionElement;
      option.value = "";
      select.appendChild(option);
    }
    const active = this.chatManager.active;
    ctx.convID = active?.id || null;
    if (active) {
      select.value = active.id;
    }
  }

  private renderQuickPrompts(ctx: PanelContext) {
    const container = ctx.body.querySelector(".zoteroai-quick-prompts");
    if (!container) {
      return;
    }
    container.innerHTML = "";
    for (const qp of getQuickPrompts()) {
      const btn = this.el(ctx.doc, "button", "zoteroai-quick-btn", qp.label);
      btn.addEventListener("click", () => {
        if (qp.forSelection) {
          void this.sendSelectionPrompt(ctx, qp.prompt);
        } else {
          const input = ctx.body.querySelector(
            ".zoteroai-input",
          ) as HTMLTextAreaElement;
          input.value = qp.prompt;
          void this.send(ctx);
        }
      });
      container.appendChild(btn);
    }
    const insertBtn = this.el(
      ctx.doc,
      "button",
      "zoteroai-quick-btn",
      getString("panel-insert-selection"),
    );
    insertBtn.addEventListener("click", () => {
      const input = ctx.body.querySelector(
        ".zoteroai-input",
      ) as HTMLTextAreaElement;
      const selection = this.getSelection();
      if (selection && input) {
        input.value = input.value
          ? `${input.value}\n\n${selection}`
          : selection;
      }
    });
    container.appendChild(insertBtn);
  }

  private renderMessages(ctx: PanelContext) {
    const container = ctx.body.querySelector(".zoteroai-messages");
    if (!container) {
      return;
    }
    container.innerHTML = "";
    const conv = this.chatManager.active;
    if (!conv || !conv.messages.length) {
      // Gemini-style zero state: large centered greeting
      const item = this.contextProvider.getCurrentItem();
      const title = item ? this.contextProvider.getItemTitle(item) : "";
      const wrap = this.el(ctx.doc, "div", "zoteroai-empty-state");
      const icon = this.el(ctx.doc, "div", "zoteroai-empty-icon", "✦");
      const greeting = this.el(
        ctx.doc,
        "div",
        "zoteroai-empty-greeting",
        getString("panel-empty-hint"),
      );
      wrap.appendChild(icon);
      wrap.appendChild(greeting);
      if (title) {
        wrap.appendChild(
          this.el(ctx.doc, "div", "zoteroai-empty-title", title),
        );
      }
      container.appendChild(wrap);
      return;
    }
    for (const msg of conv.messages) {
      container.appendChild(
        this.createMessageElement(ctx, msg.role, msg.content),
      );
    }
    container.scrollTop = container.scrollHeight;
  }

  private createMessageElement(
    ctx: PanelContext,
    role: ChatMessage["role"] | "error",
    content: string,
  ): HTMLElement {
    const el = this.el(ctx.doc, "div", `zoteroai-msg zoteroai-msg-${role}`);
    if (role === "user" || role === "error") {
      el.textContent = content;
      return el;
    }
    // Assistant messages: render markdown with a copy button
    const copyBtn = this.el(
      ctx.doc,
      "button",
      "zoteroai-copy",
      getString("panel-copy"),
    );
    copyBtn.addEventListener("click", () => {
      const win = ctx.doc.defaultView as any;
      if (win?.Zotero?.Utilities?.Internal?.copyTextToClipboard) {
        win.Zotero.Utilities.Internal.copyTextToClipboard(content);
      } else {
        Zotero.Utilities.Internal.copyTextToClipboard(content);
      }
    });
    const rendered = this.el(ctx.doc, "div");
    rendered.dataset.role = "zoteroai-markdown";
    this.renderMarkdown(ctx, rendered, content);
    el.appendChild(copyBtn);
    el.appendChild(rendered);
    return el;
  }

  /** Minimal, dependency-free markdown rendering (escaped HTML + basics). */
  private renderMarkdown(ctx: PanelContext, el: HTMLElement, text: string) {
    el.innerHTML = "";
    // Escape HTML first to prevent injection from model output
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const html = escaped
      // fenced code blocks
      .replace(
        /```(\w*)\n([\s\S]*?)```/g,
        (_m, lang, code) => `<pre><code>${code}</code></pre>`,
      )
      // inline code
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      // headings
      .replace(/^### (.*)$/gm, "<h4>$1</h4>")
      .replace(/^## (.*)$/gm, "<h3>$1</h3>")
      .replace(/^# (.*)$/gm, "<h2>$1</h2>")
      // bold / italic
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
      // links
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank">$1</a>',
      )
      // unordered lists
      .replace(/^(?:[-*] (.*)\n?)+/gm, (block: string) => {
        const items = block
          .trim()
          .split("\n")
          .map((line) => `<li>${line.replace(/^[-*] /, "")}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      })
      // paragraphs
      .replace(/^(?!<[huplo])(.+)$/gm, "<p>$1</p>");
    const frag = ctx.doc.createRange().createContextualFragment(html);
    el.appendChild(frag);
  }

  /** Selected text in the active reader, if any. */
  private getSelection(): string | null {
    try {
      const win = Zotero.getMainWindow();
      const reader = Zotero.Reader.getByTabID(
        (win as any).Zotero_Tabs.selectedID,
      );
      if (!reader) {
        return null;
      }
      const iframeWin = (reader as any)._internalReader?._primaryView
        ?._iframeWindow;
      const selection = iframeWin?.getSelection?.()?.toString();
      return selection?.trim() || null;
    } catch (e) {
      ztoolkit.log("Zotero AI: getSelection failed", e);
      return null;
    }
  }

  private setGeneratingUI(ctx: PanelContext, generating: boolean) {
    const send = ctx.body.querySelector(".zoteroai-btn-send") as HTMLElement;
    const stop = ctx.body.querySelector(".zoteroai-btn-stop") as HTMLElement;
    if (send) {
      send.hidden = generating;
    }
    if (stop) {
      stop.hidden = !generating;
    }
  }

  private buildSystemPrompt(ctx: ItemContext | null): string {
    const custom = getPref("systemPrompt");
    let prompt =
      custom ||
      "You are a research assistant embedded in Zotero, a reference manager. Answer accurately and concisely; use Markdown formatting.";
    if (ctx) {
      const parts = [
        `The user is currently viewing this paper:\nTitle: ${ctx.title}`,
        ctx.meta,
        ctx.fullText
          ? `Full text (may be truncated):\n"""\n${ctx.fullText}\n"""`
          : "",
      ].filter(Boolean);
      prompt += `\n\n${parts.join("\n\n")}`;
      if (ctx.truncated) {
        prompt +=
          "\n\nNote: the full text was truncated; say so if the answer may depend on the missing part.";
      }
    }
    return prompt;
  }

  private async send(ctx: PanelContext) {
    if (this.apiClient.generating) {
      return;
    }
    const input = ctx.body.querySelector(
      ".zoteroai-input",
    ) as HTMLTextAreaElement;
    const content = input?.value.trim();
    if (!content) {
      return;
    }
    // Ensure an active conversation exists
    let conv = this.chatManager.active;
    if (!conv) {
      const item = this.contextProvider.getCurrentItem();
      conv = this.chatManager.createConversation(
        item
          ? { key: item.key, title: this.contextProvider.getItemTitle(item) }
          : undefined,
      );
      ctx.convID = conv.id;
    }
    const convID = conv.id;

    const userMsg: ChatMessage = { role: "user", content };
    this.chatManager.appendMessages(convID, [userMsg]);

    // Build item context (metadata + optional full text)
    const item = this.contextProvider.getCurrentItem();
    let itemCtx: ItemContext | null = null;
    if (item) {
      try {
        itemCtx = await this.contextProvider.buildContext(item);
      } catch (e) {
        ztoolkit.log("Zotero AI: buildContext failed", e);
      }
    }

    const container = ctx.body.querySelector(
      ".zoteroai-messages",
    ) as HTMLElement | null;
    if (input) {
      input.value = "";
      input.style.height = "auto";
    }
    if (container) {
      container.querySelector(".zoteroai-thinking")?.remove();
      const userEl = this.createMessageElement(ctx, "user", content);
      container.appendChild(userEl);
      const pending = this.el(
        ctx.doc,
        "div",
        "zoteroai-msg zoteroai-msg-assistant zoteroai-thinking",
        "…",
      );
      container.appendChild(pending);
      // Scroll just enough to bring the new message into view instead of
      // jumping to the very bottom (which would push earlier content away)
      userEl.scrollIntoView({ block: "end" });
    }

    this.setGeneratingUI(ctx, true);
    const history: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt(itemCtx) },
      ...this.chatManager.active!.messages.filter((m) => m.role !== "system"),
    ];

    let streamed = "";
    let reasoning = "";
    let el: HTMLElement | null = null;
    let reasoningEl: HTMLElement | null = null;
    let lastRender = 0;
    // While streaming, only auto-follow when the user is already near the
    // bottom; if they scrolled up to read, don't yank the view around
    const nearBottom = () => {
      if (!container) {
        return false;
      }
      return (
        container.scrollHeight - container.scrollTop - container.clientHeight <
        60
      );
    };
    await this.apiClient.chatStream(history, {
      onDelta: (delta) => {
        streamed += delta;
        const now = Date.now();
        if (!el && container) {
          container.querySelector(".zoteroai-thinking")?.remove();
          el = this.createMessageElement(ctx, "assistant", streamed);
          container.appendChild(el);
          lastRender = now;
        } else if (el && now - lastRender >= 100) {
          // Throttle markdown re-rendering during streaming
          lastRender = now;
          const rendered = el.querySelector(
            '[data-role="zoteroai-markdown"]',
          ) as HTMLElement;
          if (rendered) {
            this.renderMarkdown(ctx, rendered, streamed);
          }
        }
        if (container && nearBottom()) {
          container.scrollTop = container.scrollHeight;
        }
      },
      onReasoning: (delta) => {
        reasoning += delta;
        if (!container) {
          return;
        }
        if (!reasoningEl) {
          container.querySelector(".zoteroai-thinking")?.remove();
          reasoningEl = this.el(
            ctx.doc,
            "div",
            "zoteroai-msg zoteroai-msg-reasoning",
          );
          container.appendChild(reasoningEl);
        }
        // Reasoning deltas arrive fast; textContent update is cheap
        reasoningEl.textContent = reasoning;
        if (nearBottom()) {
          container.scrollTop = container.scrollHeight;
        }
      },
      onDone: () => {
        this.chatManager.updateLastAssistant(convID, streamed);
        this.setGeneratingUI(ctx, false);
        // Final full render
        if (el && container) {
          const rendered = el.querySelector(
            '[data-role="zoteroai-markdown"]',
          ) as HTMLElement;
          if (rendered) {
            this.renderMarkdown(ctx, rendered, streamed);
          }
          if (nearBottom()) {
            container.scrollTop = container.scrollHeight;
          }
        }
        this.renderToolbar(ctx, this.contextProvider.getCurrentItem());
      },
      onError: (message) => {
        this.setGeneratingUI(ctx, false);
        container?.querySelector(".zoteroai-thinking")?.remove();
        if (container) {
          container.appendChild(
            this.createMessageElement(ctx, "error", message),
          );
          container.scrollTop = container.scrollHeight;
        }
      },
    });
  }

  private async sendSelectionPrompt(ctx: PanelContext, promptTemplate: string) {
    const selection = this.getSelection();
    const input = ctx.body.querySelector(
      ".zoteroai-input",
    ) as HTMLTextAreaElement;
    if (!selection) {
      const container = ctx.body.querySelector(".zoteroai-messages");
      if (container) {
        container.appendChild(
          this.createMessageElement(
            ctx,
            "error",
            getString("panel-no-selection"),
          ),
        );
      }
      return;
    }
    input.value = promptTemplate.replace("$text", selection);
    await this.send(ctx);
  }
}
