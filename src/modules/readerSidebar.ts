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
 * have a document yet when it is added. Observer creation is deduplicated
 * per iframe window (WeakMap) so repeated tab switches don't pile up.
 */
export class ReaderSidebarInjector {
  private notifierID?: string;
  private observers: any[] = [];
  /** One body observer per reader iframe window (dedup across add/select) */
  private mountedWindows = new WeakSet<any>();
  /** Remember which native view was active before our panel took over */
  private lastNativeView: number | null = null;

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
    this.disconnectAll();
    // Remove injected UI from all open readers
    for (const reader of (Zotero.Reader as any)._readers || []) {
      try {
        const doc = (reader as any)._iframeWindow?.document;
        doc?.getElementById(BTN_ID)?.remove();
        doc?.getElementById(PANEL_ID)?.remove();
      } catch {
        // Ignore
      }
    }
    this.mountedWindows = new WeakSet();
  }

  private disconnectAll() {
    for (const entry of this.observers) {
      try {
        entry.ob.disconnect();
      } catch {
        // Reader document may already be gone
      }
      const content = entry.content;
      if (content) {
        delete (content as any)._zoteroaiEnforceObserver;
      }
    }
    this.observers = [];
  }

  /**
   * Reader instances and their iframes appear asynchronously; retry until
   * the tab resolves to a ready reader. Idempotent — deduped per window,
   * and tryMount guards by element ids. Skips early once the plugin dies.
   */
  private async injectForTab(tabID: string, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      if (!addon?.data.alive) {
        return;
      }
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
      if (!win || !addon?.data.alive) {
        return;
      }
      // Dedup: one body observer per reader document, ever
      if (this.mountedWindows.has(win)) {
        return;
      }
      this.mountedWindows.add(win);
      let mountTimes: number[] = [];
      const mount = () => {
        // Circuit breaker: same storm guard as the visibility observer
        const now = Date.now();
        mountTimes = mountTimes.filter((t) => now - t < 1000);
        mountTimes.push(now);
        if (mountTimes.length > 200) {
          ztoolkit.log(
            "Zotero AI: injection observer storm detected — disconnecting",
          );
          mo.disconnect();
          return;
        }
        this.tryMount(win);
      };
      // The sidebar React tree renders lazily (only when opened) and may be
      // re-rendered; keep the injection alive through a MutationObserver.
      const mo = new win.MutationObserver(mount);
      this.observers.push({ ob: mo, win });
      mo.observe(win.document.body, { childList: true, subtree: true });
      mount();
    } catch (e) {
      ztoolkit.log("Zotero AI: reader sidebar injection failed", e);
    }
  }

  private tryMount(win: any) {
    if (!addon?.data.alive) {
      return;
    }
    const doc: Document = win.document;
    const toolbar = doc.querySelector(
      "#sidebarContainer .sidebar-toolbar .start",
    );
    const content = doc.getElementById("sidebarContent") as HTMLElement | null;
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
        // Re-read content in case React re-created #sidebarContent since
        // this listener was installed (stale-closure guard)
        const liveContent = doc.getElementById(
          "sidebarContent",
        ) as HTMLElement | null;
        if (liveContent) {
          this.activate(doc, liveContent);
        }
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
      // NOTE: no display in the inline style — visibility is driven purely
      // by the .hidden class (see zoteroai.css #zoteroai-view-panel rules)
      panel.setAttribute(
        "style",
        "position:absolute;inset:0;z-index:10;background:var(--material-background);" +
          "-moz-user-select:text;user-select:text;",
      );
      content.style.position = "relative";
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
    if (!content.style.position) {
      content.style.position = "relative";
    }
    // Keep view visibility consistent on every sidebar mutation: while our
    // overlay is active native views stay hidden; while inactive, exactly
    // the last native view the user was on stays visible.
    this.enforceViewVisibility(doc, content);
    // (Re)hook native view buttons so switching views hides our overlay.
    // The clicked button tells us which view React is switching to — record
    // it so deactivate/enforce restore the right wrapper even when React's
    // className updates bail out on unchanged state.
    for (let index = 0; index < NATIVE_VIEW_IDS.length; index++) {
      const id = NATIVE_VIEW_IDS[index];
      const el = doc.getElementById(id) as any;
      if (el && !el._zoteroaiDeactivateHooked) {
        el._zoteroaiDeactivateHooked = true;
        el.addEventListener("click", () => {
          this.lastNativeView = index;
          this.deactivate(doc);
        });
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
   * Map a native button index to its wrapper. Only the annotations wrapper
   * carries an id; thumbnails/outline wrappers are matched positionally.
   * If the DOM doesn't match the expected shape, log ONCE (not per mutation)
   * and fall back to showing nothing rather than controlling the wrong node.
   */
  private loggedStructureWarning = false;
  private visibleWrapperIndex(
    buttonIndex: number,
    wrappers: HTMLElement[],
  ): number | null {
    const annotationsIndex = wrappers.findIndex(
      (w) => w.id === "annotationsView",
    );
    // Structural sanity: thumbnails first, annotations next, outline last
    if (wrappers.length !== 3 || annotationsIndex !== 1) {
      if (!this.loggedStructureWarning) {
        this.loggedStructureWarning = true;
        ztoolkit.log(
          `Zotero AI: unexpected sidebar structure (${wrappers.length} wrappers, annotations at ${annotationsIndex})`,
        );
      }
      return null;
    }
    return buttonIndex === 0 ? 0 : buttonIndex === 1 ? annotationsIndex : 2;
  }

  /**
   * Observe the sidebar content and reconcile view visibility on every
   * mutation. Toggling to the same class value produces no mutation, so the
   * observer loop always settles. A circuit breaker disconnects the observer
   * if it ever storms (mutation→callback→mutation cycling would freeze the
   * UI thread as an endless microtask loop).
   */
  private enforceViewVisibility(doc: Document, content: HTMLElement) {
    if ((content as any)._zoteroaiEnforceObserver) {
      return;
    }
    // Circuit breaker state: N calls within the window trips it
    let callTimes: number[] = [];
    const enforce = () => {
      const now = Date.now();
      callTimes = callTimes.filter((t) => now - t < 1000);
      callTimes.push(now);
      if (callTimes.length > 100) {
        ztoolkit.log(
          "Zotero AI: view-visibility observer storm detected — disconnecting",
        );
        ob.disconnect();
        delete (content as any)._zoteroaiEnforceObserver;
        return;
      }
      try {
        const panel = doc.getElementById(PANEL_ID);
        const panelActive = !panel?.classList.contains("hidden");
        const wrappers = this.getNativeWrappers(content);
        if (panelActive) {
          for (const wrapper of wrappers) {
            wrapper.classList.add("hidden");
          }
          return;
        }
        // Panel inactive: show the remembered native view, hide the rest.
        // Never rely on the native buttons' .active classes — React bails
        // out of className updates when its state is unchanged, so the DOM
        // can desync from React's state; our own memory cannot.
        const showIndex =
          this.lastNativeView !== null
            ? this.visibleWrapperIndex(this.lastNativeView, wrappers)
            : null;
        wrappers.forEach((wrapper, i) => {
          wrapper.classList.toggle("hidden", showIndex !== i);
        });
      } catch (e) {
        ztoolkit.log("Zotero AI: enforce error", e);
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
    this.observers.push({ ob, content });
  }

  private activate(doc: Document, content: HTMLElement) {
    const panel = doc.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    // Remember which native view was visible so deactivate can restore it
    // without trusting React-managed .active classes
    if (this.lastNativeView === null) {
      const wrappers = this.getNativeWrappers(content);
      const firstVisible = wrappers.findIndex(
        (w) => !w.classList.contains("hidden"),
      );
      if (firstVisible >= 0) {
        this.lastNativeView =
          firstVisible === 0 ? 0 : firstVisible === 2 ? 2 : 1;
      } else {
        this.lastNativeView = 1; // annotations is the default view
      }
    }
    panel.classList.remove("hidden");
    // The enforceViewVisibility observer applies the same state immediately;
    // hide native views explicitly for a synchronous first paint
    for (const wrapper of this.getNativeWrappers(content)) {
      wrapper.classList.add("hidden");
    }
    ztoolkit.log("Zotero AI: activating chat panel");
    chatPanel
      ?.mountReaderPanel(
        panel.querySelector(".zoteroai-root") as HTMLElement,
        doc,
      )
      .catch((e: any) => {
        ztoolkit.log("Zotero AI: mountReaderPanel failed", e);
      });
  }

  private deactivate(doc: Document) {
    doc.getElementById(PANEL_ID)?.classList.add("hidden");
    // Restore the remembered native view (React's useState bails out on
    // same-value className writes, so DOM .active classes cannot be trusted)
    const content = doc.getElementById("sidebarContent");
    if (!content) {
      return;
    }
    const wrappers = this.getNativeWrappers(content);
    const showIndex =
      this.lastNativeView !== null
        ? this.visibleWrapperIndex(this.lastNativeView, wrappers)
        : null;
    wrappers.forEach((wrapper, i) => {
      wrapper.classList.toggle("hidden", showIndex !== i);
    });
  }
}

// Set by hooks.ts to avoid a circular import at module load
let chatPanel: any;
export function setChatPanelRef(panel: any) {
  chatPanel = panel;
}
