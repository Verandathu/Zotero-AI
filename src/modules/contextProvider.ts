import { getPref } from "../utils/prefs";

export interface ItemContext {
  itemID: number;
  itemKey: string;
  title: string;
  meta: string;
  fullText?: string;
  truncated?: boolean;
}

/**
 * Tracks the item the user is currently working with (library selection or
 * open reader tab) and builds the context block sent to the model.
 */
export class ContextProvider {
  private lastReaderItemID: number | null = null;

  /** Called from the Notifier callback on tab/select events. */
  onNotify(event: string, type: string, ids: Array<string | number>) {
    try {
      if (event === "select" && type === "tab") {
        const tabID = String(ids[0]);
        const reader = Zotero.Reader.getByTabID(tabID);
        if (reader) {
          this.lastReaderItemID = (reader as any).itemID ?? null;
        }
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: context notify error", e);
    }
  }

  /**
   * Resolve the item the chat should be aware of right now:
   * the item open in the active reader tab, else the library selection.
   */
  getCurrentItem(): Zotero.Item | undefined {
    const win = Zotero.getMainWindow();
    if (!win) {
      return undefined;
    }
    try {
      const selectedID = (win as any).Zotero_Tabs?.selectedID;
      if (selectedID) {
        const reader = Zotero.Reader.getByTabID(selectedID);
        if (reader) {
          const itemID = (reader as any).itemID ?? this.lastReaderItemID;
          const item = itemID ? Zotero.Items.get(itemID) : undefined;
          if (item) {
            return item;
          }
        }
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: reader lookup failed", e);
    }
    if (win.ZoteroPane?.collectionsView) {
      try {
        const items = win.ZoteroPane.getSelectedItems();
        if (items?.length) {
          // Prefer regular items over attachments when multiple are selected
          return (
            items.find((it: Zotero.Item) => it.isRegularItem()) || items[0]
          );
        }
      } catch (e) {
        ztoolkit.log("Zotero AI: getSelectedItems failed", e);
      }
    }
    if (this.lastReaderItemID) {
      const item = Zotero.Items.get(this.lastReaderItemID);
      if (item) {
        return item;
      }
      this.lastReaderItemID = null;
    }
    return undefined;
  }

  async resolveItem(
    libraryID: number | undefined,
    itemKey: string | undefined,
  ): Promise<Zotero.Item | undefined> {
    if (!itemKey) {
      return undefined;
    }
    const current = this.getCurrentItem();
    if (
      current?.key === itemKey &&
      (libraryID === undefined || current.libraryID === libraryID)
    ) {
      return current;
    }
    try {
      if (libraryID !== undefined) {
        return (
          (await (Zotero.Items as any).getByLibraryAndKeyAsync?.(
            libraryID,
            itemKey,
          )) || undefined
        );
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: bound item lookup failed", e);
    }
    return undefined;
  }

  /**
   * For an attachment (e.g. the PDF open in the reader), resolve the parent
   * regular item — the actual paper — so titles and metadata are not the
   * file name.
   */
  sourceItem(item: Zotero.Item): Zotero.Item {
    if (item?.isAttachment()) {
      try {
        const parentID = (item as any).parentItemID ?? (item as any).parentID;
        const parent: Zotero.Item | undefined = parentID
          ? Zotero.Items.get(parentID)
          : undefined;
        if (parent?.isRegularItem()) {
          return parent;
        }
      } catch (e) {
        // Fall through to the attachment itself
      }
    }
    return item;
  }

  /** The current item resolved to its regular-item source counterpart. */
  getCurrentSourceItem(): Zotero.Item | undefined {
    const item = this.getCurrentItem();
    return item ? this.sourceItem(item) : undefined;
  }

  /** Short display title for the context badge (paper title, not file name). */
  getItemTitle(item: Zotero.Item | undefined): string {
    if (!item) {
      return "";
    }
    try {
      const source = this.sourceItem(item);
      return source.getField("title") || source.getDisplayTitle?.() || "";
    } catch (e) {
      return "";
    }
  }

  /**
   * Build the context description of an item: metadata, abstract and
   * (optionally) the indexed full text.
   */
  async buildContext(item: Zotero.Item): Promise<ItemContext> {
    const source = this.sourceItem(item);
    const ctx: ItemContext = {
      itemID: source.id,
      itemKey: source.key,
      title: this.getItemTitle(item),
      meta: this.getMetadata(item),
    };
    if (!getPref("includeFullText")) {
      return ctx;
    }
    try {
      const text = await this.getFullText(item);
      if (text) {
        const limit = getPref("fullTextLimit");
        if (limit > 0 && text.length > limit) {
          ctx.fullText = text.slice(0, limit);
          ctx.truncated = true;
        } else {
          ctx.fullText = text;
        }
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: fulltext extraction failed", e);
    }
    return ctx;
  }

  /**
   * Build a compact context for an additional, referenced paper (used by the
   * cross-document research agent). Full text is capped much lower than the
   * primary item so several works can be compared without overflowing the
   * context window.
   */
  async buildReferenceContext(
    item: Zotero.Item,
    options: { fullTextLimit?: number } = {},
  ): Promise<ItemContext> {
    const source = this.sourceItem(item);
    const ctx: ItemContext = {
      itemID: source.id,
      itemKey: source.key,
      title: this.getItemTitle(item),
      meta: this.getMetadata(item),
    };
    const limit = options.fullTextLimit ?? 6000;
    if (limit <= 0) {
      return ctx;
    }
    try {
      const text = await this.getFullText(item);
      if (text) {
        if (text.length > limit) {
          ctx.fullText = text.slice(0, limit);
          ctx.truncated = true;
        } else {
          ctx.fullText = text;
        }
      }
    } catch (e) {
      ztoolkit.log("Zotero AI: reference fulltext extraction failed", e);
    }
    return ctx;
  }

  private getMetadata(item: Zotero.Item): string {
    const source = this.sourceItem(item);
    const fields = [
      "title",
      "creator",
      "date",
      "publicationTitle",
      "DOI",
      "url",
      "abstractNote",
    ];
    const lines: string[] = [];
    for (const field of fields) {
      try {
        if (field === "creator") {
          const creators = source.getCreators();
          if (creators?.length) {
            lines.push(
              `Creators: ${creators.map((c: any) => `${c.firstName || ""} ${c.lastName || ""}`.trim()).join(", ")}`,
            );
          }
          continue;
        }
        const value = source.getField(field);
        if (value) {
          lines.push(
            `${field === "abstractNote" ? "Abstract" : field}: ${value}`,
          );
        }
      } catch (e) {
        // Skip fields not present on this item type
      }
    }
    return lines.join("\n");
  }

  /**
   * Get the full text of an item: for regular items, prefer the best
   * attachment; for attachments, use the item itself.
   */
  private async getFullText(item: Zotero.Item): Promise<string> {
    let attachment: Zotero.Item | undefined;
    if (item.isAttachment()) {
      attachment = item;
    } else if (item.isRegularItem()) {
      const attachments = (await item.getBestAttachments()) as Zotero.Item[];
      attachment = attachments?.find(
        (a: Zotero.Item) =>
          a.isAttachment() && a.attachmentContentType === "application/pdf",
      );
    }
    if (!attachment) {
      return "";
    }
    // `attachmentText` reads Zotero's cached full text and falls back to
    // on-demand PDFWorker extraction when no cache exists yet
    try {
      const content = await (attachment as any).attachmentText;
      if (typeof content === "string" && content.trim()) {
        return content;
      }
      ztoolkit.log(`Zotero AI: no full text for attachment ${attachment.id}`);
    } catch (e) {
      ztoolkit.log(
        "Zotero AI: attachmentText failed for attachment",
        attachment.id,
        e,
      );
    }
    return "";
  }
}
