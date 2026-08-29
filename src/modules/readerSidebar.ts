const BTN_ID = "zoteroai-view-btn";
const PANEL_ID = "zoteroai-view-panel";
// Native sidebar view switcher buttons in the reader
const NATIVE_VIEW_IDS = ["viewThumbnail", "viewAnnotations", "viewOutline"];

/**
 * Injects a "Zotero AI" view into the reader's LEFT sidebar, alongside the
 * built-in thumbnails / annotations / outline views.
 *
 * The reader sidebar is a React app with no plugin API, so this works by DOM
 * injection: a switcher button is added to the sidebar toolbar and an overlay
 * panel is added to the sidebar content. The injection is re-asserted with a
 * MutationObserver because the sidebar renders lazily (only when opened) and
 * React may re-render parts of it.
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
          if (event === "add" && type === "tab") {
            const reader = Zotero.Reader.getByTabID(String(ids[0]));
            if (reader) {
              void this.inject(reader as any);
            }
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
    // While our overlay is active, keep native views hidden — React
    // re-renders recompute their .hidden classes from its own state and
    // would resurface them beneath the overlay. Enforce our state on every
    // sidebar mutation.
    this.enforceWhileActive(doc, content as HTMLElement);
    // (Re)hook native view buttons so switching views hides our overlay
    for (const id of NATIVE_VIEW_IDS) {
      const el = doc.getElementById(id) as any;
      if (el && !el._zoteroaiDeactivateHooked) {
        el._zoteroaiDeactivateHooked = true;
        el.addEventListener("click", () => this.deactivate(doc));
      }
    }
  }

  /**
   * Observe the sidebar content; while the AI overlay is active, re-assert
   * the hidden state on native view wrappers whenever React re-renders them.
   * When the overlay is inactive, make sure it stays hidden.
   */
  private enforceWhileActive(doc: Document, content: HTMLElement) {
    if ((content as any)._zoteroaiEnforceObserver) {
      return;
    }
    const isActive = () =>
      !doc.getElementById(PANEL_ID)?.classList.contains("hidden");
    const enforce = () => {
      const panelActive = isActive();
      const activeBtnId = NATIVE_VIEW_IDS.find((id) =>
        doc.getElementById(id)?.classList.contains("active"),
      );
      for (const wrapper of content.querySelectorAll(":scope > .viewWrapper")) {
        if (wrapper.id === PANEL_ID) {
          continue;
        }
        // Native views visible only when our overlay is hidden AND the
        // corresponding native button is active
        const shouldBeVisible = !panelActive && wrapper.id === activeBtnId;
        wrapper.classList.toggle("hidden", !shouldBeVisible);
      }
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
    // Hide the native views so they don't scroll out beneath the overlay.
    // The MutationObserver in enforceWhileActive keeps this state enforced
    // against React re-renders.
    for (const wrapper of content.querySelectorAll(":scope > .viewWrapper")) {
      if (wrapper.id !== PANEL_ID) {
        wrapper.classList.add("hidden");
      }
    }
    void chatPanel?.mountReaderPanel(
      panel.querySelector(".zoteroai-root") as HTMLElement,
      doc,
    );
  }

  private deactivate(doc: Document) {
    const panel = doc.getElementById(PANEL_ID);
    panel?.classList.add("hidden");
    doc.getElementById(BTN_ID)?.classList.remove("active");
    // Restore the native view whose button React keeps active. Wrappers for
    // thumbnails and outline have no id attribute — match them by position:
    // they are the direct .viewWrapper children of #sidebarContent in the
    // order [thumbnails, annotations(id=annotationsView), outline].
    const content = doc.getElementById("sidebarContent");
    if (!content) {
      return;
    }
    const activeId = NATIVE_VIEW_IDS.find(
      (id) => doc.getElementById(id)?.classList.contains("active"),
    );
    const wrappers = [
      ...content.querySelectorAll(":scope > .viewWrapper"),
    ].filter((w) => w.id !== PANEL_ID);
    const annotationsIndex = wrappers.findIndex(
      (w) => w.id === "annotationsView",
    );
    const nativeIndex = activeId
      ? NATIVE_VIEW_IDS.indexOf(activeId)
      : 1; // default to annotations
    const domIndex =
      nativeIndex === 0
        ? 0
        : nativeIndex === 1
          ? annotationsIndex
          : wrappers.length - 1;
    wrappers.forEach((wrapper, index) => {
      wrapper.classList.toggle("hidden", index !== domIndex);
    });
  }
}

// Set by hooks.ts to avoid a circular import at module load
let chatPanel: any;
export function setChatPanelRef(panel: any) {
  chatPanel = panel;
}
