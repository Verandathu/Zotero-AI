const BTN_ID = "zoteroai-view-btn";
const PANEL_ID = "zoteroai-view-panel";
// Native sidebar view switcher buttons in the reader, in sidebar DOM order
const NATIVE_VIEW_IDS = ["viewThumbnail", "viewAnnotations", "viewOutline"];

/**
 * Injects a "Zotero AI" view into the reader's LEFT sidebar, alongside the
 * built-in thumbnails / annotations / outline views.
 *
 * The reader sidebar is a React app with no plugin API, so this works by DOM
 * injection: a switcher button is added to the sidebar toolbar and an overlay
 * panel is added to the sidebar content. Injections are (re-)asserted with a
 * MutationObserver because the sidebar renders lazily (only when opened) and
 * React re-renders can remove or restyle injected/native nodes.
 *
 * Injection is driven by tab "add" AND "select" notifier events: reader
 * iframes are created lazily when a tab is first viewed, so a tab may not
 * have a document yet when it is added.
 */
export class ReaderSidebarInjector {
  private notifierID?: string;
  private observers: any[] = [];

  register() {
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: Array<string | number>) => {
          if (!addon?.data.alive) {
            Zotero.Notifier.unregisterObserver(this.notifierID!);
            return;
          }
          if (type === "tab" && (event === "add" || event === "select")) {
            void this.injectForTab(String(ids[0]));
          }
        },
      },
      ["tab"],
    );
    // Readers that are already open (e.g. after a dev hot-reload)
    for (const reader of (Zotero.Reader as any)._readers || []) {
      void this.inject(reader);
    }
  }

  unregister() {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = undefined;
    }
    for (const ob of this.observers) {
      try {
        ob.disconnect();
      } catch (e) {
        // Reader document may already be gone
      }
    }
    this.observers = [];
    // Remove injected UI from all open readers
    for (const reader of (Zotero.Reader as any)._readers || []) {
      try {
        const doc = (reader as any)._iframeWindow?.document;
        doc?.getElementById(BTN_ID)?.remove();
        doc?.getElementById(PANEL_ID)?.remove();
      } catch (e) {
        // Ignore
      }
    }
  }

  /**
   * Reader instances and their iframes appear asynchronously; retry until
   * the tab resolves to a ready reader. Idempotent — tryMount guards by
   * element ids.
   */
  private async injectForTab(tabID: string, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      const reader = Zotero.Reader.getByTabID(tabID);
      if (reader) {
        await this.inject(reader as any);
        return;
      }
      await Zotero.Promise.delay(300);
    }
  }

  private async inject(reader: any) {
    try {
      await reader._waitForReader();
      const win: any = reader._iframeWindow;
      if (!win) {
        return;
      }
      const mount = () => this.tryMount(reader, win);
      // The sidebar React tree renders lazily (only when opened) and may be
      // re-rendered; keep the injection alive through a MutationObserver.
      const mo = new win.MutationObserver(() => mount());
      this.observers.push(mo);
      mo.observe(win.document.body, { childList: true, subtree: true });
      mount();
    } catch (e) {
      ztoolkit.log("Zotero AI: reader sidebar injection failed", e);
    }
  }

  private tryMount(reader: any, win: any) {
    const doc: Document = win.document;
    const toolbar = doc.querySelector(
      "#sidebarContainer .sidebar-toolbar .start",
    );
    const content = doc.getElementById("sidebarContent");
    if (!toolbar || !content) {
      return;
    }

    // --- Switcher button ---
    let btn = doc.getElementById(BTN_ID) as
      | (HTMLButtonElement & { _zoteroaiHooked?: boolean })
      | null;
    if (btn && !toolbar.contains(btn)) {
      // React removed it during re-render; re-append
      btn.remove();
      btn = null;
    }
    if (!btn) {
      btn = doc.createElement("button");
      btn.id = BTN_ID;
      btn.className = "toolbar-button";
      btn.title = "Zotero AI";
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2z"/></svg>';
      toolbar.appendChild(btn);
    }
    if (!btn._zoteroaiHooked) {
      btn._zoteroaiHooked = true;
      btn.addEventListener("click", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        this.activate(doc, btn, content as HTMLElement);
      });
    }

    // --- Overlay panel ---
    let panel = doc.getElementById(PANEL_ID) as HTMLDivElement | null;
    if (panel && !content.contains(panel)) {
      panel.remove();
      panel = null;
    }
    if (!panel) {
      panel = doc.createElement("div");
      panel.id = PANEL_ID;
      panel.className = "viewWrapper hidden";
      panel.setAttribute(
        "style",
        "position:absolute;inset:0;z-index:10;background:var(--material-background);" +
          "display:flex;flex-direction:column;-moz-user-select:text;user-select:text;",
      );
      (content as HTMLElement).setAttribute("style", "position:relative;");
      content.appendChild(panel);
      const root = doc.createElement("div");
      root.className = "zoteroai-root";
      // Inline style so text selection survives any cascade surprise
      root.setAttribute("style", "-moz-user-select:text;user-select:text;");
      panel.appendChild(root);
      // Isolate our panel from the reader's capture-phase pointer handling
      // (annotation selection logic on the iframe document) so mouse drag
      // selection works naturally inside the chat
      for (const type of ["pointerdown", "mousedown", "pointerup"]) {
        panel.addEventListener(type, (e: any) => {
          e.stopPropagation();
        });
      }
    }
    // React re-renders can wipe the inline style keeping the overlay anchored
    if (!(content as HTMLElement).style.position) {
      (content as HTMLElement).style.position = "relative";
    }
    // Keep view visibility consistent on every sidebar mutation: while our
    // overlay is active native views stay hidden; while inactive, exactly the
    // native view whose button is active stays visible. React re-renders
    // recompute wrapper classes from its own state — this corrects them.
    this.enforceViewVisibility(doc, content as HTMLElement);
    // (Re)hook native view buttons so switching views hides our overlay
    for (const id of NATIVE_VIEW_IDS) {
      const el = doc.getElementById(id) as any;
      if (el && !el._zoteroaiDeactivateHooked) {
        el._zoteroaiDeactivateHooked = true;
        el.addEventListener("click", () => this.deactivate(doc));
      }
    }
  }

  /** Direct .viewWrapper children of #sidebarContent, excluding our panel. */
  private getNativeWrappers(content: Element): HTMLElement[] {
    return [...content.querySelectorAll(":scope > .viewWrapper")].filter(
      (w) => w.id !== PANEL_ID,
    ) as HTMLElement[];
  }

  /**
   * Native wrapper DOM order is [thumbnails, annotations, outline]; only the
   * annotations wrapper carries an id, so map a button index to its wrapper.
   */
  private wrapperIndexFor(buttonIndex: number, wrappers: HTMLElement[]): number {
    const annotationsIndex = wrappers.findIndex(
      (w) => w.id === "annotationsView",
    );
    if (buttonIndex === 0) {
      return 0;
    }
    if (buttonIndex === 1) {
      return annotationsIndex >= 0 ? annotationsIndex : 1;
    }
    return wrappers.length - 1;
  }

  /**
   * Observe the sidebar content and reconcile view visibility on every
   * mutation. Toggling to the same class value produces no mutation, so the
   * observer loop always settles.
   */
  private enforceViewVisibility(doc: Document, content: HTMLElement) {
    if ((content as any)._zoteroaiEnforceObserver) {
      return;
    }
    const enforce = () => {
      const panelActive = !doc
        .getElementById(PANEL_ID)
        ?.classList.contains("hidden");
      const activeBtn = NATIVE_VIEW_IDS.findIndex((id) =>
        doc.getElementById(id)?.classList.contains("active"),
      );
      const wrappers = this.getNativeWrappers(content);
      wrappers.forEach((wrapper, i) => {
        const visible =
          !panelActive &&
          activeBtn >= 0 &&
          this.wrapperIndexFor(activeBtn, wrappers) === i;
        wrapper.classList.toggle("hidden", !visible);
      });
    };
    const ob = new (doc.defaultView as any).MutationObserver(enforce);
    ob.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    (content as any)._zoteroaiEnforceObserver = ob;
  }

  private activate(
    doc: Document,
    btn: HTMLButtonElement,
    content: HTMLElement,
  ) {
    const panel = doc.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    panel.classList.remove("hidden");
    btn.classList.add("active");
    for (const id of NATIVE_VIEW_IDS) {
      doc.getElementById(id)?.classList.remove("active");
    }
    // The enforceViewVisibility observer applies the same state immediately;
    // hide native views explicitly for a synchronous first paint
    for (const wrapper of this.getNativeWrappers(content)) {
      wrapper.classList.add("hidden");
    }
    void chatPanel?.mountReaderPanel(
      panel.querySelector(".zoteroai-root") as HTMLElement,
      doc,
    );
  }

  private deactivate(doc: Document) {
    doc.getElementById(PANEL_ID)?.classList.add("hidden");
    doc.getElementById(BTN_ID)?.classList.remove("active");
    // Restore the native view whose button React keeps active. Wrappers for
    // thumbnails and outline have no id attribute — map by DOM position.
    const content = doc.getElementById("sidebarContent");
    if (!content) {
      return;
    }
    const activeBtn = NATIVE_VIEW_IDS.findIndex((id) =>
      doc.getElementById(id)?.classList.contains("active"),
    );
    const wrappers = this.getNativeWrappers(content);
    wrappers.forEach((wrapper, i) => {
      const visible =
        activeBtn >= 0 && this.wrapperIndexFor(activeBtn, wrappers) === i;
      wrapper.classList.toggle("hidden", !visible);
    });
  }
}

// Set by hooks.ts to avoid a circular import at module load
let chatPanel: any;
export function setChatPanelRef(panel: any) {
  chatPanel = panel;
}
