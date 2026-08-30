import { ChatMessage } from "./apiClient";

export type ConversationMessageRole = "user" | "assistant";

export interface ConversationMessage {
  id: string;
  role: ConversationMessageRole;
  content: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  /** Library + item key permanently bind a conversation to its source item. */
  libraryID?: number;
  itemKey?: string;
  itemTitle?: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  lastError?: string;
}

interface ConversationStoreV2 {
  version: 2;
  activeID: string | null;
  conversations: Conversation[];
}

function makeID(prefix: string): string {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize both v1 role/content messages and v2 stored messages. */
export function normalizeConversationRecord(
  value: any,
): Conversation | undefined {
  if (
    !value ||
    typeof value.id !== "string" ||
    !Array.isArray(value.messages)
  ) {
    return undefined;
  }
  const createdAt = Number(value.createdAt) || Date.now();
  const messages = value.messages
    .filter(
      (message: any) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string",
    )
    .map(
      (message: any, index: number): ConversationMessage => ({
        id:
          typeof message.id === "string" ? message.id : `${value.id}-m${index}`,
        role: message.role,
        content: message.content,
        createdAt: Number(message.createdAt) || createdAt + index,
      }),
    );
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : "New conversation",
    ...(Number.isFinite(value.libraryID)
      ? { libraryID: Number(value.libraryID) }
      : {}),
    ...(typeof value.itemKey === "string" ? { itemKey: value.itemKey } : {}),
    ...(typeof value.itemTitle === "string"
      ? { itemTitle: value.itemTitle }
      : {}),
    createdAt,
    updatedAt: Number(value.updatedAt) || createdAt,
    messages,
    ...(typeof value.lastError === "string"
      ? { lastError: value.lastError }
      : {}),
  };
}

/** Conversation storage and reversible mutations for the chat UI. */
export class ChatManager {
  private conversations: Conversation[] = [];
  private activeID: string | null = null;
  private saveTimer?: any;
  private loaded = false;
  private pendingDeletes = new Map<
    string,
    { conversation: Conversation; timer: any }
  >();

  get active(): Conversation | undefined {
    return this.conversations.find((c) => c.id === this.activeID);
  }

  get list(): Conversation[] {
    return [...this.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listFor(itemKey: string | null): Conversation[] {
    return itemKey
      ? this.list.filter((conversation) => conversation.itemKey === itemKey)
      : this.list;
  }

  search(query: string, itemKey: string | null): Conversation[] {
    const normalized = query.trim().toLocaleLowerCase();
    return this.listFor(itemKey).filter((conversation) => {
      if (!normalized) {
        return true;
      }
      return `${conversation.title}\n${conversation.itemTitle || ""}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const path = this.getStorePath();
      if (await IOUtils.exists(path)) {
        const data = JSON.parse(await IOUtils.readUTF8(path));
        if (Array.isArray(data.conversations)) {
          this.conversations = data.conversations
            .map((value: any) => normalizeConversationRecord(value))
            .filter(Boolean) as Conversation[];
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
    if (this.conversations.some((conversation) => conversation.id === id)) {
      this.activeID = id;
      this.scheduleSave();
    }
  }

  createConversation(item?: {
    libraryID?: number;
    key: string;
    title: string;
  }): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: makeID("c"),
      title: "New conversation",
      createdAt: now,
      updatedAt: now,
      messages: [],
      ...(item
        ? {
            libraryID: item.libraryID,
            itemKey: item.key,
            itemTitle: item.title,
          }
        : {}),
    };
    this.conversations.push(conversation);
    this.activeID = conversation.id;
    this.scheduleSave();
    return conversation;
  }

  /** Hide immediately, but keep the persisted copy until undo expires. */
  stageDeleteConversation(id: string, delay = 6000): Conversation | undefined {
    const index = this.conversations.findIndex(
      (conversation) => conversation.id === id,
    );
    if (index < 0) {
      return undefined;
    }
    const [conversation] = this.conversations.splice(index, 1);
    const timer = setTimeout(() => {
      this.pendingDeletes.delete(id);
      this.scheduleSave();
    }, delay);
    this.pendingDeletes.set(id, { conversation, timer });
    if (this.activeID === id) {
      this.activeID = this.list[0]?.id || null;
    }
    return conversation;
  }

  /** Compatibility path for callers that do not offer undo. */
  deleteConversation(id: string) {
    this.stageDeleteConversation(id, 0);
  }

  undoDeleteConversation(id: string): boolean {
    const pending = this.pendingDeletes.get(id);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingDeletes.delete(id);
    this.conversations.push(pending.conversation);
    this.activeID = id;
    this.scheduleSave();
    return true;
  }

  renameConversation(id: string, title: string) {
    const conversation = this.find(id);
    if (conversation && title.trim()) {
      conversation.title = title.trim();
      conversation.updatedAt = Date.now();
      this.scheduleSave();
    }
  }

  appendMessages(convID: string, messages: ChatMessage[]) {
    const conversation = this.find(convID);
    if (!conversation) {
      return;
    }
    const now = Date.now();
    for (const message of messages) {
      if (message.role === "user" || message.role === "assistant") {
        conversation.messages.push({
          id: makeID("m"),
          role: message.role,
          content: message.content,
          createdAt: now,
        });
      }
    }
    conversation.lastError = undefined;
    conversation.updatedAt = now;
    this.deriveTitle(conversation);
    this.scheduleSave();
  }

  setLastAssistant(convID: string, text: string) {
    const conversation = this.find(convID);
    if (!conversation) {
      return;
    }
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role === "assistant") {
      if (last.content !== text) {
        last.content = text;
        conversation.updatedAt = Date.now();
        this.scheduleSave();
      }
    } else if (text) {
      conversation.messages.push({
        id: makeID("m"),
        role: "assistant",
        content: text,
        createdAt: Date.now(),
      });
      conversation.updatedAt = Date.now();
      this.scheduleSave();
    }
    conversation.lastError = undefined;
  }

  setError(convID: string, message?: string) {
    const conversation = this.find(convID);
    if (!conversation) {
      return;
    }
    conversation.lastError = message || undefined;
    conversation.updatedAt = Date.now();
    this.scheduleSave();
  }

  /** Replace a user message and discard the linear history after it. */
  editAndTruncate(convID: string, messageID: string, content: string): boolean {
    const conversation = this.find(convID);
    const index =
      conversation?.messages.findIndex((message) => message.id === messageID) ??
      -1;
    if (
      !conversation ||
      index < 0 ||
      conversation.messages[index].role !== "user" ||
      !content.trim()
    ) {
      return false;
    }
    conversation.messages[index].content = content.trim();
    conversation.messages.splice(index + 1);
    conversation.lastError = undefined;
    conversation.updatedAt = Date.now();
    if (index === 0) {
      conversation.title = "New conversation";
      this.deriveTitle(conversation);
    }
    this.scheduleSave();
    return true;
  }

  /** Regeneration is linear: remove the selected assistant response onward. */
  truncateFromMessage(convID: string, messageID: string): boolean {
    const conversation = this.find(convID);
    const index =
      conversation?.messages.findIndex((message) => message.id === messageID) ??
      -1;
    if (!conversation || index < 0) {
      return false;
    }
    conversation.messages.splice(index);
    conversation.lastError = undefined;
    conversation.updatedAt = Date.now();
    this.scheduleSave();
    return true;
  }

  toAPIMessages(convID: string): ChatMessage[] {
    return (
      this.find(convID)?.messages.map(({ role, content }) => ({
        role,
        content,
      })) || []
    );
  }

  scheduleSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => void this.save(), 800);
  }

  dispose() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    for (const pending of this.pendingDeletes.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingDeletes.clear();
  }

  private find(id: string): Conversation | undefined {
    return this.conversations.find((conversation) => conversation.id === id);
  }

  private deriveTitle(conversation: Conversation) {
    if (conversation.title !== "New conversation") {
      return;
    }
    const firstUser = conversation.messages.find(
      (message) => message.role === "user",
    );
    if (firstUser) {
      conversation.title = firstUser.content.replace(/\s+/g, " ").slice(0, 40);
    }
  }

  private async save(): Promise<void> {
    try {
      const path = this.getStorePath();
      const conversations = [
        ...this.conversations,
        ...[...this.pendingDeletes.values()].map((entry) => entry.conversation),
      ];
      const store: ConversationStoreV2 = {
        version: 2,
        activeID: this.activeID,
        conversations,
      };
      await IOUtils.writeUTF8(path, JSON.stringify(store));
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
