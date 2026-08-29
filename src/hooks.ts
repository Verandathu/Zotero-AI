import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { ChatPanel } from "./modules/chatPanel";
import {
  ReaderSidebarInjector,
  setChatPanelRef,
} from "./modules/readerSidebar";

let chatPanel: ChatPanel | undefined;
let readerSidebar: ReaderSidebarInjector | undefined;
let styleSheetURI: any;

function registerStylesheet() {
  const sss = (Components as any).classes[
    "@mozilla.org/content/style-sheet-service;1"
  ].getService(Components.interfaces.nsIStyleSheetService);
  styleSheetURI = Services.io.newURI(
    `chrome://${addon.data.config.addonRef}/content/zoteroai.css`,
  );
  if (!sss.sheetRegistered(styleSheetURI, sss.AGENT_SHEET)) {
    sss.loadAndRegisterSheet(styleSheetURI, sss.AGENT_SHEET);
  }
}

function unregisterStylesheet() {
  if (!styleSheetURI) {
    return;
  }
  const sss = (Components as any).classes[
    "@mozilla.org/content/style-sheet-service;1"
  ].getService(Components.interfaces.nsIStyleSheetService);
  if (sss.sheetRegistered(styleSheetURI, sss.AGENT_SHEET)) {
    sss.unregisterSheet(styleSheetURI, sss.AGENT_SHEET);
  }
  styleSheetURI = undefined;
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  chatPanel = new ChatPanel();
  setChatPanelRef(chatPanel);
  readerSidebar = new ReaderSidebarInjector();
  registerStylesheet();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerPrefs();

  // Register the chat panel item pane section (library view) once the main
  // window is ready, and start injecting the reader left-sidebar view
  chatPanel?.register();
  readerSidebar?.register();

  // Track reader tab selection for context awareness
  const notifierID = Zotero.Notifier.registerObserver(
    {
      notify: (
        event: string,
        type: string,
        ids: Array<string | number>,
        extraData: any,
      ) => {
        if (!addon?.data.alive) {
          Zotero.Notifier.unregisterObserver(notifierID);
          return;
        }
        chatPanel?.contextProvider.onNotify(event, type, ids);
      },
    },
    ["tab", "item"],
  );
}

function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  chatPanel?.unregister();
  readerSidebar?.unregister();
  unregisterStylesheet();
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent: (_type: string, _data: any) => undefined,
};
