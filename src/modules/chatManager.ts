import { ChatMessage } from "./apiClient";

export interface Conversation {
  id: string;
  title: string;
  /** itemKey of the item the conversation started with, for per-item filtering */
  itemKey?: string;
  itemTitle?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/**
 * Conversation store with JSON persistence in the Zotero profile directory.
 */
export class ChatManager {
  private conversations: Conversation[] = [];
  private activeID: string | null = null;
  private saveTimer?: any;
  private loaded = false;

  get active(): Conversation | undefined {
    return this.conversations.find((c) => c.id === this.activeID);
  }

  get list(): Conversation[] {
    return [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Conversations belonging to an item ("all" shows everything). */
  listFor(itemKey: string | null): Conversation[] {
    if (!itemKey) {
      return this.list;
    }
    return this.list.filter((c) => c.itemKey === itemKey);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const path = this.getStorePath();
      if (await IOUtils.exists(path)) {
        const raw = await IOUtils.readUTF8(path);
        const data = JSON.parse(raw);
        if (Array.isArray(data.conversations)) {
          this.conversations = data.conversations;
        }
        this.activeID = data.activeID || null;
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: failed to load conversation store", e);
      this.conversations = [];
    }
    if (!this.active && this.conversations.length) {
      this.activeID = this.list[0].id;
    }
  }

  setActive(id: string) {
    if (this.conversations.some((c) => c.id === id)) {
      this.activeID = id;
      this.scheduleSave();
    }
  }

  createConversation(item?: { key: string; title: string }): Conversation {
    const now = Date.now();
    const conv: Conversation = {
      id: `c${now}-${Math.random().toString(36).slice(2, 8)}`,
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      messages: [],
      ...(item ? { itemKey: item.key, itemTitle: item.title } : {}),
    };
    this.conversations.push(conv);
    this.activeID = conv.id;
    this.scheduleSave();
    return conv;
  }

  deleteConversation(id: string) {
    this.conversations = this.conversations.filter((c) => c.id !== id);
    if (this.activeID === id) {
      this.activeID = this.list[0]?.id || null;
    }
    this.scheduleSave();
  }

  renameConversation(id: string, title: string) {
    const conv = this.conversations.find((c) => c.id === id);
    if (conv) {
      conv.title = title;
      this.scheduleSave();
    }
  }

  appendMessages(convID: string, messages: ChatMessage[]) {
    const conv = this.conversations.find((c) => c.id === convID);
    if (!conv) {
      return;
    }
    conv.messages.push(...messages);
    conv.updatedAt = Date.now();
    // Derive the conversation title from the first user message
    if (conv.title === "New conversation") {
      const firstUser = conv.messages.find((m) => m.role === "user");
      if (firstUser) {
        conv.title = firstUser.content.replace(/\s+/g, " ").slice(0, 40);
      }
    }
    this.scheduleSave();
  }

  /** Ensure a trailing assistant message exists and set its content. */
  setLastAssistant(convID: string, text: string) {
    const conv = this.conversations.find((c) => c.id === convID);
    if (!conv) {
      return;
    }
    const last = conv.messages[conv.messages.length - 1];
    if (last?.role === "assistant") {
      if (last.content !== text) {
        last.content = text;
        conv.updatedAt = Date.now();
        this.scheduleSave();
      }
    } else if (text) {
      // First chunk of a new assistant reply
      conv.messages.push({ role: "assistant", content: text });
      conv.updatedAt = Date.now();
      this.scheduleSave();
    }
  }

  /** Debounced save to avoid rewriting the file on every streaming delta. */
  scheduleSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      void this.save();
    }, 800);
  }

  private async save(): Promise<void> {
    try {
      const path = this.getStorePath();
      await IOUtils.writeUTF8(
        path,
        JSON.stringify({
          version: 1,
          activeID: this.activeID,
          conversations: this.conversations,
        }),
      );
    } catch (e) {
      ztoolkit.log("Zotero AI: failed to save conversation store", e);
    }
  }

  private getStorePath(): string {
    return PathUtils.join(
      (Zotero as any).Profile.dir,
      `${addon.data.config.addonRef}-chat-history.json`,
    );
  }
}
