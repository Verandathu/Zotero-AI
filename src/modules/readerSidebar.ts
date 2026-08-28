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
    const toolbar = doc.querySelector("#sidebarContainer .sidebar-toolbar .start");
    const content = doc.getElementById("sidebarContent");
    if (!toolbar || !content) {
      return;
    }

    // --- Switcher button ---
    let btn = doc.getElementById(BTN_ID) as (HTMLButtonElement & { _zoteroaiHooked?: boolean }) | null;
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
        "position:absolute;inset:0;z-index:10;background:var(--material-background);display:flex;flex-direction:column;",
      );
      (content as HTMLElement).setAttribute("style", "position:relative;");
      content.appendChild(panel);
      const root = doc.createElement("div");
      root.className = "zoteroai-root";
      panel.appendChild(root);
    }
    // (Re)hook native view buttons so switching views hides our overlay
    for (const id of NATIVE_VIEW_IDS) {
      const el = doc.getElementById(id) as any;
      if (el && !el._zoteroaiDeactivateHooked) {
        el._zoteroaiDeactivateHooked = true;
        el.addEventListener("click", () => this.deactivate(doc));
      }
    }
  }

  private activate(doc: Document, btn: HTMLButtonElement, content: HTMLElement) {
    const panel = doc.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    panel.classList.remove("hidden");
    btn.classList.add("active");
    for (const id of NATIVE_VIEW_IDS) {
      doc.getElementById(id)?.classList.remove("active");
    }
    void chatPanel?.mountReaderPanel(
      panel.querySelector(".zoteroai-root") as HTMLElement,
      doc,
    );
  }

  private deactivate(doc: Document) {
    doc.getElementById(PANEL_ID)?.classList.add("hidden");
    doc.getElementById(BTN_ID)?.classList.remove("active");
  }
}

// Set by hooks.ts to avoid a circular import at module load
let chatPanel: any;
export function setChatPanelRef(panel: any) {
  chatPanel = panel;
}
