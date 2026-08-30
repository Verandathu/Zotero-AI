import { getLocaleID, getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { ApiClient, ChatMessage } from "./apiClient";
import { ChatManager, Conversation, ConversationMessage } from "./chatManager";
import { estimateContextUsage } from "./contextEstimator";
import { ContextProvider, ItemContext } from "./contextProvider";
import { getQuickPrompts } from "./quickPrompts";

const PANE_ID = "zoteroai-chat";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

type HistoryFilter = "all" | "item";
type GenerationPhase = "preparing" | "waiting" | "streaming";

interface PanelContext {
  body: HTMLElement;
  doc: Document;
  convID: string | null;
  currentItemKey: string | null;
  filter: HistoryFilter;
  contextPrompt: string;
  contextLoading: boolean;
  contextVersion: number;
  meterBlocked: boolean;
  drawerReturnFocus?: HTMLElement;
  inputTimer?: any;
}

interface GenerationState {
  convID: string;
  phase: GenerationPhase;
  cancelled: boolean;
}

const ICONS: Record<string, string> = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  edit: '<path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z"/><path d="m13.5 7 3.5 3.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  retry: '<path d="M20 6v5h-5"/><path d="M19 11a8 8 0 1 0 1 5"/>',
  send: '<path d="m4 4 17 8-17 8 3-8-3-8Z"/><path d="M7 12h14"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
  quote: '<path d="M6 8h5v5H7c0 2 1 3 3 4M14 8h5v5h-4c0 2 1 3 3 4"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};

export class ChatPanel {
  apiClient = new ApiClient();
  chatManager = new ChatManager();
  contextProvider = new ContextProvider();

  private panels = new Map<HTMLElement, PanelContext>();
  private contextCache = new Map<string, Promise<ItemContext | null>>();
  private sending = false;
  private generation: GenerationState | null = null;

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
    this.chatManager.dispose();
  }

  private async mountSection(
    body: HTMLElement,
    item?: Zotero.Item,
    _tabType?: string,
  ) {
    await this.chatManager.load();
    const ctx = this.ensurePanel(body, body.ownerDocument!);
    ctx.currentItemKey = item?.key || null;
    this.renderAll(ctx);
    void this.refreshContext(ctx);
  }

  async mountReaderPanel(root: HTMLElement, doc: Document) {
    await this.chatManager.load();
    const ctx = this.ensurePanel(root, doc);
    ctx.currentItemKey = this.contextProvider.getCurrentItem()?.key || null;
    this.renderAll(ctx);
    void this.refreshContext(ctx);
  }

  private ensurePanel(body: HTMLElement, doc: Document): PanelContext {
    const existing = this.panels.get(body);
    if (existing) {
      return existing;
    }
    const ctx: PanelContext = {
      body,
      doc,
      convID: null,
      currentItemKey: null,
      filter: "all",
      contextPrompt: this.buildSystemPrompt(null),
      contextLoading: false,
      contextVersion: 0,
      meterBlocked: false,
    };
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
    const element = doc.createElementNS(XHTML_NS, tag) as HTMLElement;
    if (cls) element.className = cls;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private icon(doc: Document, name: keyof typeof ICONS): HTMLElement {
    const icon = this.el(doc, "span", "zoteroai-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return icon;
  }

  private iconButton(
    doc: Document,
    cls: string,
    icon: keyof typeof ICONS,
    label: string,
  ): HTMLButtonElement {
    const button = this.el(
      doc,
      "button",
      `zoteroai-icon-btn ${cls}`,
    ) as HTMLButtonElement;
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.appendChild(this.icon(doc, icon));
    return button;
  }

  private buildUI(ctx: PanelContext) {
    const { body, doc } = ctx;
    body.innerHTML = "";

    const scrim = this.el(doc, "div", "zoteroai-history-scrim");
    const drawer = this.el(doc, "aside", "zoteroai-history-drawer");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", getString("history-title"));
    drawer.setAttribute("aria-hidden", "true");
    const drawerHead = this.el(doc, "div", "zoteroai-history-head");
    const drawerNew = this.el(doc, "button", "zoteroai-history-new");
    drawerNew.appendChild(this.icon(doc, "plus"));
    drawerNew.appendChild(
      this.el(doc, "span", undefined, getString("history-new")),
    );
    drawerHead.appendChild(drawerNew);
    drawerHead.appendChild(
      this.iconButton(
        doc,
        "zoteroai-history-close",
        "close",
        getString("panel-close"),
      ),
    );
    drawer.appendChild(drawerHead);

    const searchWrap = this.el(doc, "label", "zoteroai-history-search-wrap");
    searchWrap.appendChild(this.icon(doc, "search"));
    const search = this.el(
      doc,
      "input",
      "zoteroai-history-search",
    ) as HTMLInputElement;
    search.type = "search";
    search.placeholder = getString("history-search");
    search.setAttribute("aria-label", getString("history-search"));
    searchWrap.appendChild(search);
    drawer.appendChild(searchWrap);

    const filters = this.el(doc, "div", "zoteroai-history-filters");
    filters.setAttribute("role", "group");
    for (const [value, key] of [
      ["all", "history-filter-all"],
      ["item", "history-filter-item"],
    ] as const) {
      const button = this.el(
        doc,
        "button",
        "zoteroai-history-filter",
        getString(key),
      );
      button.dataset.filter = value;
      filters.appendChild(button);
    }
    drawer.appendChild(filters);
    drawer.appendChild(this.el(doc, "div", "zoteroai-history-list"));
    body.appendChild(scrim);
    body.appendChild(drawer);

    const header = this.el(doc, "header", "zoteroai-header");
    const topbar = this.el(doc, "div", "zoteroai-topbar");
    topbar.appendChild(
      this.iconButton(
        doc,
        "zoteroai-history-trigger",
        "menu",
        getString("history-open"),
      ),
    );
    const title = this.el(
      doc,
      "div",
      "zoteroai-conversation-title",
      getString("panel-title"),
    );
    title.setAttribute("aria-live", "polite");
    topbar.appendChild(title);
    topbar.appendChild(
      this.iconButton(
        doc,
        "zoteroai-new-trigger",
        "plus",
        getString("history-new"),
      ),
    );
    header.appendChild(topbar);

    const contextRow = this.el(doc, "div", "zoteroai-context-row");
    const badge = this.el(doc, "div", "zoteroai-context-badge");
    contextRow.appendChild(badge);
    const useCurrent = this.el(
      doc,
      "button",
      "zoteroai-use-current",
      getString("context-use-current"),
    ) as HTMLButtonElement;
    useCurrent.type = "button";
    useCurrent.hidden = true;
    contextRow.appendChild(useCurrent);
    const fullTextLabel = this.el(doc, "label", "zoteroai-toggle-pill");
    const fullText = this.el(doc, "input") as HTMLInputElement;
    fullText.type = "checkbox";
    fullText.checked = !!getPref("includeFullText");
    fullText.className = "zoteroai-ctx-fulltext";
    fullTextLabel.dataset.checked = String(fullText.checked);
    fullTextLabel.appendChild(fullText);
    fullTextLabel.appendChild(
      this.el(doc, "span", undefined, getString("toggle-fulltext")),
    );
    contextRow.appendChild(fullTextLabel);
    header.appendChild(contextRow);
    body.appendChild(header);

    const messages = this.el(doc, "main", "zoteroai-messages");
    messages.setAttribute("aria-live", "polite");
    body.appendChild(messages);
    body.appendChild(
      this.iconButton(
        doc,
        "zoteroai-scroll-bottom",
        "down",
        getString("scroll-bottom"),
      ),
    );

    const composer = this.el(doc, "footer", "zoteroai-composer");
    composer.appendChild(this.el(doc, "div", "zoteroai-quick-prompts"));
    const inputShell = this.el(doc, "div", "zoteroai-input-shell");
    const input = this.el(
      doc,
      "textarea",
      "zoteroai-input",
    ) as HTMLTextAreaElement;
    input.rows = 1;
    input.placeholder = getString("panel-input-hint");
    inputShell.appendChild(input);
    inputShell.appendChild(
      this.iconButton(
        doc,
        "zoteroai-insert-selection",
        "quote",
        getString("panel-insert-selection"),
      ),
    );
    inputShell.appendChild(
      this.iconButton(
        doc,
        "zoteroai-btn-action zoteroai-mode-send",
        "send",
        getString("panel-send"),
      ),
    );
    composer.appendChild(inputShell);

    const meter = this.el(doc, "div", "zoteroai-context-meter");
    const track = this.el(doc, "div", "zoteroai-context-track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.appendChild(this.el(doc, "div", "zoteroai-context-fill"));
    meter.appendChild(track);
    meter.appendChild(this.el(doc, "span", "zoteroai-context-meter-label"));
    composer.appendChild(meter);
    const liveRegion = this.el(doc, "div", "zoteroai-live-region");
    liveRegion.setAttribute("role", "status");
    liveRegion.setAttribute("aria-live", "polite");
    composer.appendChild(liveRegion);
    body.appendChild(composer);
    body.appendChild(this.el(doc, "div", "zoteroai-snackbar"));
  }

  private bindEvents(ctx: PanelContext) {
    const { body } = ctx;
    const $ = <T extends Element>(selector: string) =>
      body.querySelector(selector) as T | null;
    $(".zoteroai-history-trigger")?.addEventListener("click", (event: Event) =>
      this.openHistory(ctx, event.currentTarget as HTMLElement),
    );
    $(".zoteroai-history-close")?.addEventListener("click", () =>
      this.closeHistory(ctx),
    );
    $(".zoteroai-history-scrim")?.addEventListener("click", () =>
      this.closeHistory(ctx),
    );
    $(".zoteroai-history-new")?.addEventListener("click", () => {
      this.startNewConversation(ctx);
      this.closeHistory(ctx);
    });
    $(".zoteroai-new-trigger")?.addEventListener("click", () =>
      this.startNewConversation(ctx),
    );
    $(".zoteroai-use-current")?.addEventListener("click", () =>
      this.startNewConversation(ctx),
    );
    $(".zoteroai-history-search")?.addEventListener("input", () =>
      this.renderHistory(ctx),
    );
    body
      .querySelectorAll(".zoteroai-history-filter")
      .forEach((button: Element) => {
        button.addEventListener("click", () => {
          ctx.filter = (button as HTMLElement).dataset.filter as HistoryFilter;
          this.renderHistory(ctx);
        });
      });
    $(".zoteroai-history-drawer")?.addEventListener(
      "keydown",
      (event: Event) => {
        const keyboard = event as KeyboardEvent;
        if (keyboard.key === "Escape") {
          keyboard.preventDefault();
          this.closeHistory(ctx);
        } else if (keyboard.key === "Tab") {
          this.trapDrawerFocus(ctx, keyboard);
        }
      },
    );
    $(".zoteroai-ctx-fulltext")?.addEventListener("change", (event: Event) => {
      const checked = (event.target as HTMLInputElement).checked;
      setPref("includeFullText", checked);
      (
        (event.target as HTMLInputElement).parentElement as HTMLElement
      ).dataset.checked = String(checked);
      this.contextCache.clear();
      for (const panel of this.panels.values()) void this.refreshContext(panel);
    });
    $(".zoteroai-btn-action")?.addEventListener("click", () => {
      if (this.generation) this.stopGeneration();
      else void this.send(ctx);
    });
    $(".zoteroai-insert-selection")?.addEventListener("click", () =>
      this.insertSelection(ctx),
    );
    const input = $(".zoteroai-input") as HTMLTextAreaElement | null;
    input?.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
      clearTimeout(ctx.inputTimer);
      ctx.inputTimer = setTimeout(() => this.updateContextMeter(ctx), 120);
      this.setGeneratingUI(ctx);
    });
    input?.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send(ctx);
      }
    });
    const messages = $(".zoteroai-messages") as HTMLElement | null;
    messages?.addEventListener("scroll", () => this.updateScrollButton(ctx));
    $(".zoteroai-scroll-bottom")?.addEventListener("click", () => {
      messages?.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
    });
  }

  private renderAll(ctx: PanelContext) {
    ctx.convID = this.chatManager.active?.id || null;
    this.renderHeader(ctx);
    this.renderHistory(ctx);
    this.renderQuickPrompts(ctx);
    this.renderMessages(ctx);
    this.updateContextMeter(ctx);
    this.setGeneratingUI(ctx);
  }

  private renderHeader(ctx: PanelContext) {
    const conversation = this.chatManager.active;
    const current = this.contextProvider.getCurrentItem();
    ctx.currentItemKey = current?.key || ctx.currentItemKey;
    if (
      conversation &&
      current &&
      conversation.itemKey === current.key &&
      conversation.libraryID === undefined
    ) {
      conversation.libraryID = current.libraryID;
      this.chatManager.scheduleSave();
    }
    const title = ctx.body.querySelector(
      ".zoteroai-conversation-title",
    ) as HTMLElement;
    title.textContent = conversation?.title || getString("panel-title");
    title.title = title.textContent;
    const itemTitle =
      conversation?.itemTitle || this.contextProvider.getItemTitle(current);
    const badge = ctx.body.querySelector(
      ".zoteroai-context-badge",
    ) as HTMLButtonElement;
    badge.textContent = itemTitle || getString("context-none");
    badge.title = itemTitle || getString("context-none");
    badge.dataset.empty = itemTitle ? "false" : "true";
    const mismatch = !!(
      conversation?.itemKey &&
      current?.key &&
      conversation.itemKey !== current.key
    );
    const useCurrent = ctx.body.querySelector(
      ".zoteroai-use-current",
    ) as HTMLButtonElement;
    useCurrent.hidden = !mismatch;
    const fullText = ctx.body.querySelector(
      ".zoteroai-ctx-fulltext",
    ) as HTMLInputElement;
    if (fullText) {
      fullText.checked = !!getPref("includeFullText");
      (fullText.parentElement as HTMLElement).dataset.checked = String(
        fullText.checked,
      );
    }
  }

  private openHistory(ctx: PanelContext, trigger: HTMLElement) {
    ctx.drawerReturnFocus = trigger;
    ctx.body.classList.add("zoteroai-history-open");
    const drawer = ctx.body.querySelector(
      ".zoteroai-history-drawer",
    ) as HTMLElement;
    drawer.setAttribute("aria-hidden", "false");
    this.renderHistory(ctx);
    (
      drawer.querySelector(".zoteroai-history-search") as HTMLInputElement
    )?.focus();
  }

  private closeHistory(ctx: PanelContext) {
    ctx.body.classList.remove("zoteroai-history-open");
    const drawer = ctx.body.querySelector(
      ".zoteroai-history-drawer",
    ) as HTMLElement;
    drawer.setAttribute("aria-hidden", "true");
    ctx.drawerReturnFocus?.focus();
  }

  private trapDrawerFocus(ctx: PanelContext, event: KeyboardEvent) {
    const drawer = ctx.body.querySelector(
      ".zoteroai-history-drawer",
    ) as HTMLElement;
    const controls = [...drawer.querySelectorAll("button,input")].filter(
      (element) => !(element as HTMLButtonElement).disabled,
    ) as HTMLElement[];
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && ctx.doc.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && ctx.doc.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private startNewConversation(ctx: PanelContext) {
    const item = this.contextProvider.getCurrentItem();
    const conversation = this.chatManager.createConversation(
      item
        ? {
            libraryID: item.libraryID,
            key: item.key,
            title: this.contextProvider.getItemTitle(item),
          }
        : undefined,
    );
    ctx.convID = conversation.id;
    this.renderEveryPanel();
    void this.refreshContext(ctx);
    (ctx.body.querySelector(".zoteroai-input") as HTMLTextAreaElement)?.focus();
  }

  private switchConversation(ctx: PanelContext, id: string) {
    this.chatManager.setActive(id);
    ctx.convID = id;
    this.renderEveryPanel();
    void this.refreshContext(ctx);
  }

  private renderHistory(ctx: PanelContext) {
    const list = ctx.body.querySelector(
      ".zoteroai-history-list",
    ) as HTMLElement;
    if (!list) return;
    ctx.body
      .querySelectorAll(".zoteroai-history-filter")
      .forEach((button: Element) => {
        const active = (button as HTMLElement).dataset.filter === ctx.filter;
        button.classList.toggle("zoteroai-active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    const itemFilter = ctx.filter === "item" ? ctx.currentItemKey : null;
    const query =
      (ctx.body.querySelector(".zoteroai-history-search") as HTMLInputElement)
        ?.value || "";
    const conversations = this.chatManager.search(query, itemFilter);
    list.innerHTML = "";
    if (!conversations.length) {
      list.appendChild(
        this.el(
          ctx.doc,
          "div",
          "zoteroai-history-empty",
          getString(query ? "history-no-results" : "history-empty"),
        ),
      );
      return;
    }
    let previousGroup = "";
    for (const conversation of conversations) {
      const group = this.historyGroup(conversation.updatedAt);
      if (group !== previousGroup) {
        list.appendChild(
          this.el(ctx.doc, "div", "zoteroai-history-group", group),
        );
        previousGroup = group;
      }
      list.appendChild(this.createHistoryRow(ctx, conversation));
    }
  }

  private historyGroup(time: number): string {
    const days = Math.floor((Date.now() - time) / 86400000);
    if (days < 1) return getString("history-today");
    if (days < 7) return getString("history-week");
    return getString("history-older");
  }

  private createHistoryRow(
    ctx: PanelContext,
    conversation: Conversation,
  ): HTMLElement {
    const row = this.el(ctx.doc, "div", "zoteroai-history-item");
    row.classList.toggle(
      "zoteroai-active",
      conversation.id === this.chatManager.active?.id,
    );
    const main = this.el(ctx.doc, "button", "zoteroai-history-main");
    main.appendChild(
      this.el(
        ctx.doc,
        "span",
        "zoteroai-history-item-title",
        conversation.title,
      ),
    );
    if (conversation.itemTitle) {
      main.appendChild(
        this.el(
          ctx.doc,
          "span",
          "zoteroai-history-item-paper",
          conversation.itemTitle,
        ),
      );
    }
    main.addEventListener("click", () => {
      this.switchConversation(ctx, conversation.id);
      this.closeHistory(ctx);
    });
    row.appendChild(main);
    const actions = this.el(ctx.doc, "div", "zoteroai-history-item-actions");
    const rename = this.iconButton(
      ctx.doc,
      "",
      "edit",
      getString("history-rename"),
    );
    const remove = this.iconButton(
      ctx.doc,
      "",
      "trash",
      getString("tooltip-delete"),
    );
    rename.addEventListener("click", () =>
      this.beginRename(ctx, row, main, conversation),
    );
    remove.addEventListener("click", () =>
      this.deleteWithUndo(ctx, conversation.id),
    );
    actions.appendChild(rename);
    actions.appendChild(remove);
    row.appendChild(actions);
    return row;
  }

  private beginRename(
    ctx: PanelContext,
    row: HTMLElement,
    main: HTMLElement,
    conversation: Conversation,
  ) {
    const input = this.el(
      ctx.doc,
      "input",
      "zoteroai-history-rename",
    ) as HTMLInputElement;
    input.value = conversation.title;
    row.replaceChild(input, main);
    input.focus();
    input.select();
    let completed = false;
    const finish = (commit: boolean) => {
      if (completed) return;
      completed = true;
      if (commit && input.value.trim())
        this.chatManager.renameConversation(conversation.id, input.value);
      this.renderEveryPanel();
    };
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  private deleteWithUndo(ctx: PanelContext, id: string) {
    const deleted = this.chatManager.stageDeleteConversation(id);
    if (!deleted) return;
    this.renderEveryPanel();
    this.showSnackbar(
      ctx,
      getString("history-deleted"),
      getString("history-undo"),
      () => {
        this.chatManager.undoDeleteConversation(id);
        this.renderEveryPanel();
      },
    );
  }

  private showSnackbar(
    ctx: PanelContext,
    message: string,
    action?: string,
    callback?: () => void,
  ) {
    const bar = ctx.body.querySelector(".zoteroai-snackbar") as HTMLElement;
    bar.innerHTML = "";
    bar.appendChild(this.el(ctx.doc, "span", undefined, message));
    if (action && callback) {
      const button = this.el(ctx.doc, "button", undefined, action);
      button.addEventListener("click", () => {
        callback();
        bar.classList.remove("zoteroai-visible");
      });
      bar.appendChild(button);
    }
    bar.classList.add("zoteroai-visible");
    setTimeout(() => bar.classList.remove("zoteroai-visible"), 6000);
  }

  private renderQuickPrompts(ctx: PanelContext) {
    const container = ctx.body.querySelector(
      ".zoteroai-quick-prompts",
    ) as HTMLElement;
    if (!container) return;
    container.innerHTML = "";
    for (const quickPrompt of getQuickPrompts()) {
      const button = this.el(
        ctx.doc,
        "button",
        "zoteroai-quick-btn",
        quickPrompt.label,
      );
      button.addEventListener("click", () => {
        if (quickPrompt.forSelection)
          void this.sendSelectionPrompt(ctx, quickPrompt.prompt);
        else {
          const input = ctx.body.querySelector(
            ".zoteroai-input",
          ) as HTMLTextAreaElement;
          input.value = quickPrompt.prompt;
          input.dispatchEvent(new ctx.doc.defaultView!.Event("input"));
          void this.send(ctx);
        }
      });
      container.appendChild(button);
    }
  }

  private renderMessages(ctx: PanelContext) {
    const container = ctx.body.querySelector(
      ".zoteroai-messages",
    ) as HTMLElement;
    if (!container) return;
    container.innerHTML = "";
    const conversation = this.chatManager.active;
    if (!conversation || !conversation.messages.length) {
      const wrap = this.el(ctx.doc, "div", "zoteroai-empty-state");
      wrap.appendChild(this.el(ctx.doc, "div", "zoteroai-empty-icon", "✦"));
      wrap.appendChild(
        this.el(
          ctx.doc,
          "div",
          "zoteroai-empty-greeting",
          getString("panel-empty-hint"),
        ),
      );
      const title =
        conversation?.itemTitle ||
        this.contextProvider.getItemTitle(
          this.contextProvider.getCurrentItem(),
        );
      if (title)
        wrap.appendChild(
          this.el(ctx.doc, "div", "zoteroai-empty-title", title),
        );
      container.appendChild(wrap);
    } else {
      conversation.messages.forEach((message, index) => {
        container.appendChild(
          this.createMessageElement(ctx, conversation, message, index),
        );
      });
    }
    if (conversation?.lastError)
      container.appendChild(this.createErrorCard(ctx, conversation));
    const generation = this.generation;
    if (generation && generation.convID === conversation?.id)
      this.appendPending(ctx, generation.phase);
    container.scrollTop = container.scrollHeight;
    this.updateScrollButton(ctx);
  }

  private createMessageElement(
    ctx: PanelContext,
    conversation: Conversation,
    message: ConversationMessage,
    index: number,
  ): HTMLElement {
    const element = this.el(
      ctx.doc,
      "article",
      `zoteroai-msg zoteroai-msg-${message.role}`,
    );
    element.dataset.messageId = message.id;
    const content = this.el(ctx.doc, "div", "zoteroai-msg-content");
    if (message.role === "assistant")
      this.renderMarkdown(ctx, content, message.content);
    else content.textContent = message.content;
    element.appendChild(content);
    const footer = this.el(ctx.doc, "div", "zoteroai-msg-footer");
    if (message.role === "user") {
      const edit = this.iconButton(
        ctx.doc,
        "",
        "edit",
        getString("message-edit"),
      );
      edit.addEventListener("click", () =>
        this.beginMessageEdit(ctx, conversation, message, element, index),
      );
      footer.appendChild(edit);
    } else {
      const copy = this.iconButton(
        ctx.doc,
        "",
        "copy",
        getString("panel-copy"),
      );
      copy.addEventListener("click", () =>
        this.copyMessage(ctx, message.content, copy),
      );
      footer.appendChild(copy);
      if (index === conversation.messages.length - 1) {
        const retry = this.iconButton(
          ctx.doc,
          "",
          "retry",
          getString("message-regenerate"),
        );
        retry.addEventListener("click", () => {
          if (
            this.chatManager.truncateFromMessage(conversation.id, message.id)
          ) {
            this.renderEveryPanel();
            void this.runGeneration(ctx, conversation.id);
          }
        });
        footer.appendChild(retry);
      }
    }
    element.appendChild(footer);
    return element;
  }

  private beginMessageEdit(
    ctx: PanelContext,
    conversation: Conversation,
    message: ConversationMessage,
    element: HTMLElement,
    index: number,
  ) {
    element.innerHTML = "";
    element.classList.add("zoteroai-editing");
    const editor = this.el(
      ctx.doc,
      "textarea",
      "zoteroai-message-editor",
    ) as HTMLTextAreaElement;
    editor.value = message.content;
    element.appendChild(editor);
    if (index < conversation.messages.length - 1) {
      element.appendChild(
        this.el(
          ctx.doc,
          "div",
          "zoteroai-edit-warning",
          getString("message-edit-warning"),
        ),
      );
    }
    const actions = this.el(ctx.doc, "div", "zoteroai-edit-actions");
    const cancel = this.el(
      ctx.doc,
      "button",
      undefined,
      getString("action-cancel"),
    );
    const submit = this.el(
      ctx.doc,
      "button",
      "zoteroai-primary-action",
      getString("message-resend"),
    );
    cancel.addEventListener("click", () => this.renderMessages(ctx));
    submit.addEventListener("click", () => {
      if (
        this.chatManager.editAndTruncate(
          conversation.id,
          message.id,
          editor.value,
        )
      ) {
        this.renderEveryPanel();
        void this.runGeneration(ctx, conversation.id);
      }
    });
    actions.appendChild(cancel);
    actions.appendChild(submit);
    element.appendChild(actions);
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  private copyMessage(
    ctx: PanelContext,
    content: string,
    button: HTMLButtonElement,
  ) {
    const win = ctx.doc.defaultView as any;
    const utility =
      win?.Zotero?.Utilities?.Internal || Zotero.Utilities.Internal;
    utility.copyTextToClipboard(content);
    const live = ctx.body.querySelector(".zoteroai-live-region") as HTMLElement;
    live.textContent = getString("message-copied");
    button.classList.add("zoteroai-success");
    button.title = getString("message-copied");
    setTimeout(() => {
      button.classList.remove("zoteroai-success");
      button.title = getString("panel-copy");
      live.textContent = "";
    }, 1500);
  }

  private createErrorCard(
    ctx: PanelContext,
    conversation: Conversation,
  ): HTMLElement {
    const card = this.el(ctx.doc, "div", "zoteroai-error-card");
    card.appendChild(
      this.el(ctx.doc, "strong", undefined, getString("error-title")),
    );
    const details = this.el(ctx.doc, "details");
    details.appendChild(
      this.el(ctx.doc, "summary", undefined, getString("error-details")),
    );
    details.appendChild(
      this.el(ctx.doc, "pre", undefined, conversation.lastError),
    );
    card.appendChild(details);
    const retry = this.el(
      ctx.doc,
      "button",
      undefined,
      getString("error-retry"),
    );
    retry.addEventListener("click", () => {
      this.chatManager.setError(conversation.id);
      this.renderEveryPanel();
      void this.runGeneration(ctx, conversation.id);
    });
    card.appendChild(retry);
    return card;
  }

  private appendPending(ctx: PanelContext, phase: GenerationPhase) {
    const container = ctx.body.querySelector(
      ".zoteroai-messages",
    ) as HTMLElement;
    if (container.querySelector(".zoteroai-pending")) return;
    const pending = this.el(ctx.doc, "div", "zoteroai-pending");
    pending.appendChild(this.el(ctx.doc, "span", "zoteroai-spinner"));
    pending.appendChild(
      this.el(ctx.doc, "span", undefined, getString(`status-${phase}` as any)),
    );
    container.appendChild(pending);
  }

  private renderMarkdown(
    ctx: PanelContext,
    element: HTMLElement,
    text: string,
  ) {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const html = escaped
      .replace(
        /```(\w*)\n([\s\S]*?)```/g,
        (_match, _lang, code) => `<pre><code>${code}</code></pre>`,
      )
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/^### (.*)$/gm, "<h4>$1</h4>")
      .replace(/^## (.*)$/gm, "<h3>$1</h3>")
      .replace(/^# (.*)$/gm, "<h2>$1</h2>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" target="_blank">$1</a>',
      )
      .replace(
        /(^\|.+\|\n^\|(?:\s*:?-+:?\s*\|)+\n(?:^\|.+\|\n?)+)/gm,
        (table: string) => {
          const rows = table
            .trim()
            .split("\n")
            .map((line) =>
              line
                .slice(1, -1)
                .split("|")
                .map((cell) => cell.trim()),
            );
          const header = rows[0].map((cell) => `<th>${cell}</th>`).join("");
          const body = rows
            .slice(2)
            .map(
              (row) =>
                `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`,
            )
            .join("");
          return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
        },
      )
      .replace(
        /^(?:[-*] (.*)\n?)+/gm,
        (block: string) =>
          `<ul>${block
            .trim()
            .split("\n")
            .map((line) => `<li>${line.replace(/^[-*] /, "")}</li>`)
            .join("")}</ul>`,
      )
      .replace(/^(?!<[thuplo])(.+)$/gm, "<p>$1</p>");
    element.innerHTML = "";
    element.appendChild(ctx.doc.createRange().createContextualFragment(html));
  }

  private async send(ctx: PanelContext) {
    if (this.sending || this.generation || ctx.meterBlocked) return;
    const input = ctx.body.querySelector(
      ".zoteroai-input",
    ) as HTMLTextAreaElement;
    const content = input.value.trim();
    if (!content) return;
    let conversation = this.chatManager.active;
    if (!conversation) {
      this.startNewConversation(ctx);
      conversation = this.chatManager.active;
    }
    if (!conversation) return;
    this.chatManager.appendMessages(conversation.id, [
      { role: "user", content },
    ]);
    input.value = "";
    input.style.height = "auto";
    this.renderEveryPanel();
    await this.runGeneration(ctx, conversation.id);
  }

  private async runGeneration(ctx: PanelContext, convID: string) {
    if (this.sending || this.generation) return;
    this.sending = true;
    this.generation = { convID, phase: "preparing", cancelled: false };
    this.chatManager.setError(convID);
    this.renderEveryPanel();
    try {
      const conversation = this.chatManager.list.find(
        (entry) => entry.id === convID,
      );
      if (!conversation) return;
      const itemContext = await this.getConversationContext(conversation);
      if (!this.generation || this.generation.cancelled) return;
      const system = this.buildSystemPrompt(itemContext);
      const history: ChatMessage[] = [
        { role: "system", content: system },
        ...this.chatManager.toAPIMessages(convID),
      ];
      const usage = estimateContextUsage(
        history,
        Number(getPref("contextWindowTokens")) || 128000,
        Math.max(0, Number(getPref("maxTokens")) || 0),
      );
      if (usage.percent >= 100) {
        this.chatManager.setError(convID, getString("context-limit-error"));
        return;
      }
      this.generation.phase = "waiting";
      this.renderEveryPanel();
      let streamed = "";
      let reasoning = "";
      let responseElement: HTMLElement | null = null;
      let reasoningElement: HTMLElement | null = null;
      const container = ctx.body.querySelector(
        ".zoteroai-messages",
      ) as HTMLElement;
      await this.apiClient.chatStream(history, {
        onDelta: (delta) => {
          if (!this.generation || this.generation.convID !== convID) return;
          this.generation.phase = "streaming";
          streamed += delta;
          container.querySelector(".zoteroai-pending")?.remove();
          reasoningElement?.remove();
          reasoningElement = null;
          if (!responseElement) {
            responseElement = this.el(
              ctx.doc,
              "article",
              "zoteroai-msg zoteroai-msg-assistant zoteroai-streaming",
            );
            responseElement.appendChild(
              this.el(ctx.doc, "div", "zoteroai-msg-content"),
            );
            container.appendChild(responseElement);
          }
          const body = responseElement.querySelector(
            ".zoteroai-msg-content",
          ) as HTMLElement;
          this.renderMarkdown(ctx, body, streamed);
          if (this.isNearBottom(container))
            container.scrollTop = container.scrollHeight;
          this.setGeneratingUI(ctx);
        },
        onReasoning: (delta) => {
          reasoning += delta;
          container.querySelector(".zoteroai-pending")?.remove();
          if (!reasoningElement) {
            reasoningElement = this.el(
              ctx.doc,
              "div",
              "zoteroai-msg-reasoning",
            );
            container.appendChild(reasoningElement);
          }
          reasoningElement.textContent = reasoning;
        },
        onDone: () => {
          this.chatManager.setLastAssistant(convID, streamed);
        },
        onError: (message) => {
          if (streamed) this.chatManager.setLastAssistant(convID, streamed);
          this.chatManager.setError(convID, message);
        },
      });
    } finally {
      this.generation = null;
      this.sending = false;
      this.renderEveryPanel();
      for (const panel of this.panels.values()) void this.refreshContext(panel);
    }
  }

  private stopGeneration() {
    if (!this.generation) return;
    this.generation.cancelled = true;
    this.apiClient.stop();
    if (!this.apiClient.generating) {
      this.generation = null;
      this.sending = false;
      this.renderEveryPanel();
    }
  }

  private setGeneratingUI(ctx: PanelContext) {
    const button = ctx.body.querySelector(
      ".zoteroai-btn-action",
    ) as HTMLButtonElement;
    const input = ctx.body.querySelector(
      ".zoteroai-input",
    ) as HTMLTextAreaElement;
    if (!button || !input) return;
    const generating = !!this.generation;
    button.classList.toggle("zoteroai-mode-send", !generating);
    button.classList.toggle("zoteroai-mode-stop", generating);
    button.innerHTML = "";
    button.appendChild(this.icon(ctx.doc, generating ? "stop" : "send"));
    button.title = getString(generating ? "panel-stop" : "panel-send");
    button.setAttribute("aria-label", button.title);
    button.disabled = !generating && (!input.value.trim() || ctx.meterBlocked);
    input.disabled = !!(
      generating && this.generation?.convID !== this.chatManager.active?.id
    );
  }

  private async refreshContext(ctx: PanelContext) {
    const version = ++ctx.contextVersion;
    ctx.contextLoading = true;
    this.updateContextMeter(ctx);
    const context = await this.getConversationContext(this.chatManager.active);
    if (version !== ctx.contextVersion) return;
    ctx.contextPrompt = this.buildSystemPrompt(context);
    ctx.contextLoading = false;
    this.updateContextMeter(ctx);
  }

  private async getConversationContext(
    conversation?: Conversation,
  ): Promise<ItemContext | null> {
    const item = conversation?.itemKey
      ? await this.contextProvider.resolveItem(
          conversation.libraryID,
          conversation.itemKey,
        )
      : this.contextProvider.getCurrentItem();
    if (!item) return null;
    const key = `${item.libraryID}:${item.key}:${getPref("includeFullText")}:${getPref("fullTextLimit")}`;
    let pending = this.contextCache.get(key);
    if (!pending) {
      pending = this.contextProvider.buildContext(item).catch((error) => {
        ztoolkit.log("Zotero AI: buildContext failed", error);
        return null;
      });
      this.contextCache.set(key, pending);
    }
    return pending;
  }

  private updateContextMeter(ctx: PanelContext) {
    const conversation = this.chatManager.active;
    const draft = (
      ctx.body.querySelector(".zoteroai-input") as HTMLTextAreaElement
    )?.value.trim();
    const messages: ChatMessage[] = [
      { role: "system", content: ctx.contextPrompt },
      ...(conversation ? this.chatManager.toAPIMessages(conversation.id) : []),
      ...(draft ? [{ role: "user" as const, content: draft }] : []),
    ];
    const usage = estimateContextUsage(
      messages,
      Number(getPref("contextWindowTokens")) || 128000,
      Math.max(0, Number(getPref("maxTokens")) || 0),
    );
    const meter = ctx.body.querySelector(
      ".zoteroai-context-meter",
    ) as HTMLElement;
    const track = meter?.querySelector(
      ".zoteroai-context-track",
    ) as HTMLElement;
    const fill = meter?.querySelector(".zoteroai-context-fill") as HTMLElement;
    const label = meter?.querySelector(
      ".zoteroai-context-meter-label",
    ) as HTMLElement;
    if (!meter || !track || !fill || !label) return;
    ctx.meterBlocked = usage.percent >= 100;
    meter.dataset.level =
      usage.percent >= 90
        ? "danger"
        : usage.percent >= 75
          ? "warning"
          : "normal";
    fill.style.width = `${usage.percent}%`;
    track.setAttribute("aria-valuenow", String(Math.round(usage.percent)));
    label.textContent = ctx.contextLoading
      ? getString("context-calculating")
      : `≈ ${Math.round(usage.percent)}% · ${getString("context-remaining")} ${this.formatTokens(usage.remaining)}`;
    meter.title = `${getString("context-used")} ${this.formatTokens(usage.used)} / ${this.formatTokens(usage.limit)}${usage.reserved ? ` · ${getString("context-reserved")} ${this.formatTokens(usage.reserved)}` : ""}`;
    this.setGeneratingUI(ctx);
  }

  private formatTokens(value: number): string {
    if (value >= 1000)
      return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
    return String(value);
  }

  private buildSystemPrompt(context: ItemContext | null): string {
    let prompt =
      getPref("systemPrompt") ||
      "You are a research assistant embedded in Zotero, a reference manager. Answer accurately and concisely; use Markdown formatting.";
    if (!context) return prompt;
    const parts = [
      `The user is currently viewing this paper:\nTitle: ${context.title}`,
      context.meta,
      context.fullText
        ? `Full text (may be truncated):\n"""\n${context.fullText}\n"""`
        : "",
    ].filter(Boolean);
    prompt += `\n\n${parts.join("\n\n")}`;
    if (context.truncated)
      prompt +=
        "\n\nNote: the full text was truncated; say so if the answer may depend on the missing part.";
    return prompt;
  }

  private insertSelection(ctx: PanelContext) {
    const selection = this.getSelection();
    if (!selection) {
      this.showSnackbar(ctx, getString("panel-no-selection"));
      return;
    }
    const input = ctx.body.querySelector(
      ".zoteroai-input",
    ) as HTMLTextAreaElement;
    input.value = input.value ? `${input.value}\n\n${selection}` : selection;
    input.dispatchEvent(new ctx.doc.defaultView!.Event("input"));
    input.focus();
  }

  private async sendSelectionPrompt(ctx: PanelContext, template: string) {
    const selection = this.getSelection();
    if (!selection) {
      this.showSnackbar(ctx, getString("panel-no-selection"));
      return;
    }
    const input = ctx.body.querySelector(
      ".zoteroai-input",
    ) as HTMLTextAreaElement;
    input.value = template.replace("$text", selection);
    input.dispatchEvent(new ctx.doc.defaultView!.Event("input"));
    await this.send(ctx);
  }

  private getSelection(): string | null {
    try {
      const win = Zotero.getMainWindow();
      const reader = Zotero.Reader.getByTabID(
        (win as any).Zotero_Tabs.selectedID,
      );
      const selection = (
        reader as any
      )?._internalReader?._primaryView?._iframeWindow
        ?.getSelection?.()
        ?.toString();
      return selection?.trim() || null;
    } catch (e) {
      ztoolkit.log("Zotero AI: getSelection failed", e);
      return null;
    }
  }

  private renderEveryPanel() {
    for (const panel of this.panels.values()) this.renderAll(panel);
  }

  private isNearBottom(container: HTMLElement): boolean {
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight < 72
    );
  }

  private updateScrollButton(ctx: PanelContext) {
    const container = ctx.body.querySelector(
      ".zoteroai-messages",
    ) as HTMLElement;
    const button = ctx.body.querySelector(
      ".zoteroai-scroll-bottom",
    ) as HTMLButtonElement;
    if (container && button)
      button.classList.toggle(
        "zoteroai-visible",
        !this.isNearBottom(container),
      );
  }
}
