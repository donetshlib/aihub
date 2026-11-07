// AI Hub: a sidebar of AI services, each with its own tabs, in one window.
// The window's own page (ui/) draws the sidebar, tab strip, toolbar and side panel; every tab
// is a WebContentsView laid over the content area. All tab state lives here, the UI only
// renders the snapshot it is sent.
const { app, BrowserWindow, WebContentsView, Menu, globalShortcut, Notification, dialog, nativeImage, ipcMain, nativeTheme, net, screen, session, shell, clipboard } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, uninstallExtension } = require('electron-chrome-web-store');
const { autoUpdater } = require('electron-updater');
const { ElectronBlocker, adsAndTrackingLists } = require('@ghostery/adblocker-electron');
const { LANGS, translate } = require('./ui/i18n.js');

// Must match the sizes in ui/style.css.
const SIDEBAR = 56;
const TOPBAR = 80;
const PANE_HEAD = 28;
const GAP = 6;
const PANEL = 380;
const MAX_PANES = 3;
const ERROR_PAGE = path.join(__dirname, 'ui', 'error.html');
const NEW_TAB = path.join(__dirname, 'ui', 'newtab.html');
const NEW_TAB_URL = pathToFileURL(NEW_TAB).href;
const WEB_STORE = 'https://chromewebstore.google.com/category/extensions';

const PRESETS = [
  { name: 'Claude', url: 'https://claude.ai' },
  { name: 'ChatGPT', url: 'https://chatgpt.com' },
  { name: 'Gemini', url: 'https://gemini.google.com' },
  { name: 'Grok', url: 'https://grok.com' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai' },
  { name: 'DeepSeek', url: 'https://chat.deepseek.com' },
];
const DEFAULT_SERVICES = PRESETS.filter((p) => p.name !== 'Perplexity').map((p) => ({
  id: p.name.toLowerCase(), name: p.name, url: p.url, neverUnload: false,
}));
const DEFAULT_SETTINGS = {
  theme: 'dark', unloadMinutes: 15, lang: null, bounds: null, maximized: false, notify: true, downloadDir: null, askDownload: false, adblock: true,
  darkSites: false, globalHotkey: false,
};
const GLOBAL_HOTKEY = 'Ctrl+Shift+Space';
// ms-msdt: (Follina), search-ms:, ms-officecmd: and the like have been used to run code on Windows.
const DANGEROUS_SCHEME = /^(file|ms-[\w.-]+|search-ms|search|shell|mk|its|res|hcp|javascript|vbscript|data):$/i;
// Extension permissions worth a warning: reading cookies, traffic, history, other programs.
const RISKY_PERMISSIONS = new Set(['cookies', 'webRequest', 'webRequestBlocking', 'history', 'tabs', 'debugger', 'nativeMessaging',
  'downloads', 'management', 'proxy', 'privacy', 'clipboardRead', 'scripting', 'webNavigation']);
const USER_INPUT = new Set(['mouseDown', 'rawKeyDown', 'keyDown', 'touchStart']);
// Like Chrome's user activation: a click or key press counts for 5 s. Kept per webContents, so
// popups follow the same rules as tabs.
const gestures = new WeakMap(); // webContents -> time of the last click or key press in it
const trackGestures = (wc) => wc.on('input-event', (_, input) => USER_INPUT.has(input.type) && gestures.set(wc, Date.now()));
const hadGesture = (wc) => Date.now() - (gestures.get(wc) ?? 0) < 5000;
const THEMES = { dark: 'dark', light: 'light', original: 'dark' }; // app theme -> what sites see
// Granted without asking: pages need them for plain things like a "copy" button or fullscreen video.
const ALWAYS_ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen', 'storage-access', 'top-level-storage-access']);

let win;
let ui;
let services;
let settings;
let permissions; // "origin permission" -> true/false, the answers saved with "remember"
const tabs = new Map();
let nextTabId = 1;
const lastTab = {}; // service id -> last focused tab id
const closedTabs = []; // for Ctrl+Shift+T
let panes = []; // tab ids shown side by side
let fractions = [];
let focused = 0;
let panelOpen = false;
let panelView = null; // which side panel view is open: the history and bookmark lists are sent only for it
let history = []; // visited pages, newest first, one entry per URL
let historyDirty = false;
let historyQuery = '';
let bookmarks = [];
let suggestView = null; // address bar suggestions, a view of its own to sit above the tab views
let suggestions = [];
let selectedSuggestion = -1;
let suggestText = ''; // what the suggestions are for, to drop late answers from Google
let suggestRect = null;
let localSuggestions = [];
let searchSuggestions = [];
const downloads = [];
const downloadItems = new Map();
let nextDownloadId = 1;
const inflight = new Map(); // webContents id -> Map of request id -> start time
const wiredSessions = new Set();
const chromeExtensions = new Map(); // session -> ElectronChromeExtensions
const extensionIcons = new Map(); // extension path -> NativeImage
// Chromium's network stack: Node's fetch (undici) crashes the app now and then when a connection
// closes during parallel downloads ("assert(!this.paused)"), and it ignores the system proxy.
const webFetch = (...args) => net.fetch(...args);
let blocker = null; // ad blocker, loaded once at startup
const adblockPreloads = new Map(); // session -> id of the blocker's preload
let fullscreenTab = null; // a page in HTML fullscreen (a video player) covers the whole screen
let fullscreenNotice = null; // "press Esc" over it for the first seconds
let selectedContents = null; // the tab the extensions were last told is active

/* ---------- Files ---------- */

const dataFile = (name) => path.join(app.getPath('userData'), name);

function load(name, fallback) {
  const file = dataFile(name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // A broken file is set aside rather than overwritten, so a hand edit can be recovered.
    if (err.code !== 'ENOENT') try { fs.renameSync(file, `${file}.broken`); } catch {}
    return fallback;
  }
}

function save(name, data) {
  const file = dataFile(name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function saveSession() {
  const list = [...tabs.values()];
  save('session.json', {
    tabs: list.map(({ serviceId, url, title, favicon, pinned }) => ({ serviceId, url, title, favicon, pinned })),
    active: list.indexOf(current()),
  });
}

/* ---------- Tabs ---------- */

const serviceById = (id) => services.find((s) => s.id === id);
const serviceTabs = (id) => [...tabs.values()].filter((t) => t.serviceId === id);
// A section lives in its parent's profile: same cookies, same account, its own tabs.
const rootOf = (id) => serviceById(id)?.parent ?? id;
const partitionOf = (id) => `persist:${rootOf(id)}`;
const family = (id) => services.filter((s) => s.id === id || s.parent === id);
const topServices = () => services.filter((s) => !s.parent);
const t = (key, vars) => translate(settings.lang, key, vars);
const current = () => tabs.get(panes[focused]);
const currentContents = () => current()?.view?.webContents;
// Sites pick their icon address; the app's own pages are file:, where a file://host/share icon
// would make Windows connect to that host and hand it the user's NTLM hash.
const safeIcon = (url) => (/^(https?|data):/i.test(url ?? '') ? url : null);
const favicon = (url) => (url ? `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64` : null);
const openExternal = (url) => /^https?:/i.test(url) && shell.openExternal(url);
const confirm = (message) =>
  dialog.showMessageBoxSync(win, { type: 'question', buttons: [t('yes'), t('cancel')], defaultId: 1, cancelId: 1, message }) === 0;

function makeTab(serviceId, url, title = '', icon = null) {
  const tab = { id: nextTabId++, serviceId, url, title, favicon: icon, loading: false, view: null, shown: false, hiddenAt: Date.now() };
  tabs.set(tab.id, tab);
  return tab;
}

// A tab without a view is "sleeping": it keeps its URL and title, the page is loaded on demand.
function ensureView(tab) {
  if (tab.view) return tab.view;
  const view = new WebContentsView({ webPreferences: { partition: partitionOf(tab.serviceId) } });
  const wc = view.webContents;
  tab.view = view;
  wireSession(wc.session);
  chromeExtensions.get(wc.session).addTab(wc, win);

  trackGestures(wc);
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!hadGesture(wc)) return { action: 'deny' }; // no click: an ad
    if (!isWeb(url) && url !== 'about:blank') return { action: 'deny' };
    gestures.delete(wc); // one window per click
    // window.open with a size is a real popup (OAuth sign-in): it needs window.opener to work.
    if (disposition === 'new-window') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    const opened = makeTab(tab.serviceId, url);
    if (disposition === 'background-tab') render();
    else showTab(opened);
    return { action: 'deny' };
  });

  wc.on('did-create-window', (popup) => wirePopup(popup, wc));
  blockScriptFiles(wc);

  const onNavigate = () => {
    // On the error page the tab keeps the address that failed.
    if (wc.getURL().startsWith(NEW_TAB_URL)) tab.url = '';
    else if (!isErrorPage(wc)) {
      tab.url = wc.getURL() || tab.url;
      tab.translated = false;
      remember(tab);
    }
    render();
  };
  wc.on('did-navigate', () => { tab.reader = false; onNavigate(); });
  wc.on('did-navigate-in-page', onNavigate);
  wc.on('did-fail-load', (_, code, description, url, isMainFrame) => {
    // -3 (ERR_ABORTED) is a navigation cut short by another one, not a failure.
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return;
    tab.url = url || tab.url;
    wc.loadFile(ERROR_PAGE, { query: { url: tab.url, code: description || String(code), lang: settings.lang } });
  });
  wc.on('page-title-updated', (_, title) => {
    tab.title = title;
    updateHistory(tab, { title });
    render();
  });
  wc.on('page-favicon-updated', (_, icons) => {
    tab.favicon = safeIcon(icons[0]);
    updateHistory(tab, { favicon: tab.favicon });
    render();
  });
  wc.setAudioMuted(!!tab.muted);
  wc.on('audio-state-changed', render);
  wc.on('did-start-loading', () => { tab.loading = true; render(); });
  wc.on('did-stop-loading', () => { tab.loading = false; render(); });
  wc.on('focus', () => {
    const i = panes.indexOf(tab.id);
    if (i >= 0 && i !== focused) { focused = i; render(); }
  });
  wc.on('found-in-page', (_, result) => ui.send('find-result', result));
  wc.on('enter-html-full-screen', () => {
    fullscreenTab = tab;
    showFullscreenNotice();
    win.setFullScreen(true);
    render();
  });
  wc.on('leave-html-full-screen', () => {
    fullscreenTab = null;
    win.setFullScreen(false);
    render();
  });
  // Ctrl + mouse wheel: Electron reports it, the zooming is up to the app.
  // Each wheel notch arrives twice within the same millisecond, so the second one is dropped.
  let zoomedAt = 0;
  wc.on('zoom-changed', (_, direction) => {
    if (Date.now() - zoomedAt < 30) return;
    zoomedAt = Date.now();
    zoom(wc, direction === 'in' ? 1 : -1);
  });
  wc.on('before-input-event', onKey);
  wc.on('before-input-event', (_, input) => {
    if ((input.type === 'keyDown' && input.key === 'Enter') || input.type === 'mouseDown') tab.inputAt = Date.now();
  });
  wc.on('context-menu', (_, params) => pageMenu(tab, params));
  // A crashed page goes to sleep; if it is on screen, render() brings it straight back.
  wc.on('render-process-gone', () => setImmediate(() => { sleep(tab); render(); }));
  // The page closed itself (window.close()).
  wc.on('destroyed', () => {
    inflight.delete(wc.id);
    if (tab.view !== view || win.isDestroyed()) return;
    tab.view = null;
    win.contentView.removeChildView(view);
    closeTab(tab.id);
  });

  win.contentView.addChildView(view);
  openPage(wc, tab.url);
  return view;
}

const ERROR_URL = pathToFileURL(ERROR_PAGE).href;
const isErrorPage = (wc) => wc.getURL().startsWith(ERROR_URL);

const canOpen = (url) => /^(https?|chrome-extension):/i.test(url ?? '');

function openPage(wc, url) {
  if (canOpen(url)) wc.loadURL(url);
  else wc.loadFile(NEW_TAB, { query: { theme: settings.theme, title: t('newTab') } });
}

// Reloading the error page would only show it again, so the failed address is loaded instead.
// Sign-in popups have no address bar: the title shows the site they are on, also for popups they open.
// A file dropped on a page opens like in Chrome, but only PDFs, pictures, video, audio and text:
// a file: page with scripts could read other local files.
const SAFE_FILE = /\.(pdf|png|jpe?g|gif|webp|bmp|avif|mp4|webm|mkv|mov|mp3|ogg|wav|flac|m4a|txt|log|json|csv|md)$/i;
const blockScriptFiles = (wc) =>
  wc.on('will-navigate', (event, url) => url.startsWith('file:') && !SAFE_FILE.test(new URL(url).pathname) && event.preventDefault());

function wirePopup(popup, opener) {
  const showOrigin = () => {
    // about:blank (origin "null") is filled in by the page that opened it: that site is named.
    const origin = [popup.webContents.getURL(), opener?.isDestroyed() ? '' : opener?.getURL()]
      .map((url) => URL.parse(url ?? '')?.origin).find((o) => o && o !== 'null');
    popup.setTitle(origin ?? '');
  };
  blockScriptFiles(popup.webContents);
  popup.on('page-title-updated', (event) => event.preventDefault());
  popup.webContents.on('did-navigate', showOrigin);
  popup.webContents.on('did-create-window', (child) => wirePopup(child, popup.webContents));
  trackGestures(popup.webContents);
  popup.webContents.setWindowOpenHandler(({ url }) => {
    if (!hadGesture(popup.webContents) || (!isWeb(url) && url !== 'about:blank')) return { action: 'deny' };
    gestures.delete(popup.webContents);
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
  });
  showOrigin();
}

function reload(tab) {
  const wc = tab?.view?.webContents;
  if (!wc) return tab && showTab(tab);
  if (isErrorPage(wc) && tab.url) openPage(wc, tab.url);
  else wc.reload();
}

function sleep(tab) {
  const view = tab.view;
  if (!view) return;
  tab.view = null;
  tab.loading = false;
  inflight.delete(view.webContents.id);
  if (!win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function showTab(tab) {
  const i = panes.indexOf(tab.id);
  if (i >= 0) focused = i;
  else if (panes.length === 0) {
    panes = [tab.id];
    fractions = [1];
    focused = 0;
  } else panes[focused] = tab.id;
  render();
  tab.view?.webContents.focus();
}

function selectService(id) {
  const service = serviceById(id);
  if (!service) return;
  const tab = tabs.get(lastTab[id]) ?? serviceTabs(id)[0];
  if (tab) showTab(tab);
  else newTab(id);
}

function newTab(serviceId = current()?.serviceId ?? services[0]?.id) {
  const service = serviceById(serviceId);
  if (!service) return;
  showTab(makeTab(service.id, service.url));
  if (!service.url) {
    ui.focus();
    ui.send('cmd', 'address');
  }
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  const siblings = serviceTabs(tab.serviceId);
  const at = siblings.indexOf(tab);
  const next = siblings[at + 1] ?? siblings[at - 1];
  closedTabs.push({ serviceId: tab.serviceId, url: tab.url, title: tab.title, favicon: tab.favicon });
  sleep(tab);
  tabs.delete(id);
  if (lastTab[tab.serviceId] === id) delete lastTab[tab.serviceId];
  const pane = panes.indexOf(id);
  if (pane >= 0) {
    if (next && !panes.includes(next.id)) panes[pane] = next.id;
    else removePane(pane);
  }
  render();
  currentContents()?.focus();
}

function reopenClosedTab() {
  const closed = closedTabs.pop();
  if (closed && serviceById(closed.serviceId)) showTab(makeTab(closed.serviceId, closed.url, closed.title, closed.favicon));
}

function cycleTab(step) {
  const tab = current();
  if (!tab) return;
  const list = serviceTabs(tab.serviceId);
  showTab(list[(list.indexOf(tab) + step + list.length) % list.length]);
}

function toggleMute(tab) {
  tab.muted = !tab.muted;
  tab.view?.webContents.setAudioMuted(tab.muted);
  render();
}

function togglePin(tab) {
  tab.pinned = !tab.pinned;
  // Pinned tabs go first, the rest keep their order.
  const list = serviceTabs(tab.serviceId);
  reorder(tab.serviceId, [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)]);
  render();
}

// Tabs keep their order as the insertion order of the map, so the map is rebuilt.
function reorder(serviceId, list) {
  const rest = [...tabs.values()].filter((other) => other.serviceId !== serviceId);
  tabs.clear();
  for (const other of [...rest, ...list]) tabs.set(other.id, other);
}

/* ---------- History and bookmarks ---------- */

const HISTORY_MAX = 5000;
const isWeb = (url) => /^https?:/i.test(url);

function remember(tab) {
  if (!isWeb(tab.url)) return;
  history = history.filter((h) => h.url !== tab.url);
  history.unshift({ url: tab.url, title: tab.title, favicon: tab.favicon, at: Date.now() });
  history.length = Math.min(history.length, HISTORY_MAX);
  historyDirty = true;
}

function updateHistory(tab, fields) {
  const entry = history.find((h) => h.url === tab.url);
  if (entry) Object.assign(entry, fields);
  historyDirty = true;
}

// Every word of the query somewhere in the title or the address.
function matches(query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return (item) => words.every((w) => `${item.title} ${item.url}`.toLowerCase().includes(w));
}

function toggleBookmark(tab = current()) {
  if (!tab || !isWeb(tab.url)) return;
  const i = bookmarks.findIndex((b) => b.url === tab.url);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.unshift({ url: tab.url, title: tab.title || tab.url, favicon: tab.favicon });
  save('bookmarks.json', bookmarks);
  render();
}

function openUrl(url) {
  const wc = currentContents();
  if (!wc || !isWeb(url)) return;
  wc.loadURL(url);
  wc.focus();
}

/* ---------- Address bar suggestions ---------- */

// Services and open tabs of every service first (that is the tab search, Ctrl+K), then
// Google's search suggestions, which come a moment later, then bookmarks and history.
function suggest(arg) {
  const text = typeof arg?.text === 'string' ? arg.text.trim() : '';
  const rect = arg?.rect;
  selectedSuggestion = -1;
  suggestText = text && rect ? text : '';
  suggestRect = rect;
  suggestions = [];
  searchSuggestions = [];
  if (suggestText) {
    const name = text.toLowerCase();
    for (const s of services.filter((s) => s.name.toLowerCase().includes(name)).slice(0, 2)) {
      suggestions.push({ type: 'service', serviceId: s.id, url: s.url, title: s.name, favicon: s.icon ?? favicon(s.url) });
    }
    const match = matches(text);
    const seen = new Set();
    const take = (list, type, n) => {
      for (const item of list) {
        if (n <= 0) break;
        if (seen.has(item.url) || !match(item)) continue;
        seen.add(item.url);
        suggestions.push({
          type, url: item.url, title: item.title || item.url, favicon: item.favicon,
          tabId: item.id, service: serviceById(item.serviceId)?.name,
        });
        n--;
      }
    };
    take([...tabs.values()].filter((tab) => tab !== current()), 'tab', 3);
    take(bookmarks, 'bookmark', 3);
    take(history, 'history', 8 - suggestions.length);
    searchGoogle(text);
  }
  localSuggestions = suggestions;
  showSuggestions();
}

async function searchGoogle(text) {
  try {
    const response = await webFetch(`https://suggestqueries.google.com/complete/search?client=chrome&ie=utf-8&oe=utf-8&hl=${settings.lang}&q=${encodeURIComponent(text)}`);
    const [, list] = await response.json();
    // Not when the text changed meanwhile or a row is already picked with the arrows.
    if (text !== suggestText || selectedSuggestion >= 0) return;
    searchSuggestions = list.filter((q) => q.toLowerCase() !== text.toLowerCase()).slice(0, 4)
      .map((q) => ({ type: 'search', title: q, url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, favicon: null }));
    showSuggestions();
  } catch {} // offline: the local suggestions are enough
}

function showSuggestions() {
  const first = localSuggestions.filter((s) => s.type === 'service' || s.type === 'tab');
  suggestions = [...first, ...searchSuggestions, ...localSuggestions.slice(first.length)];
  const rect = suggestRect;
  ui.send('suggestions', suggestions.length);
  if (!suggestions.length) return suggestView?.setVisible(false);
  win.contentView.addChildView(suggestView); // again: brings it above tab views made since
  suggestView.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: suggestions.length * 44 + 14 });
  suggestView.setVisible(true);
  sendSuggestions();
}

// Made at startup: a view takes the focus when its page loads, which would interrupt typing in the address bar.
function createSuggestView() {
  suggestView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true } });
  suggestView.setBackgroundColor('#00000000');
  suggestView.setVisible(false);
  lockPage(suggestView.webContents);
  suggestView.webContents.loadFile(path.join(__dirname, 'ui', 'suggest.html'));
  // Rows are picked on mousedown; the focus belongs to the main window.
  suggestView.webContents.on('focus', () => ui.focus());
  win.contentView.addChildView(suggestView);
}

function sendSuggestions() {
  suggestView.webContents.send('suggestions', { list: suggestions, selected: selectedSuggestion, theme: settings.theme, lang: settings.lang });
}

function pickSuggestion(i) {
  const item = suggestions[i];
  suggestView?.setVisible(false);
  if (!item) return;
  if (item.type === 'tab' && tabs.has(item.tabId)) showTab(tabs.get(item.tabId));
  else if (item.type === 'service') selectService(item.serviceId);
  else openUrl(item.url);
}

/* ---------- Split view ---------- */

function openBeside(tab) {
  if (panes.includes(tab.id) || panes.length >= MAX_PANES) return;
  panes.push(tab.id);
  fractions = panes.map(() => 1 / panes.length);
  focused = panes.length - 1;
  render();
  tab.view?.webContents.focus();
}

// The tab itself stays alive: a closed pane only hides it, like switching away from it.
function removePane(i) {
  panes.splice(i, 1);
  fractions = panes.map(() => 1 / panes.length);
  if (focused >= i && focused > 0) focused -= 1;
}

function layout() {
  const [width, height] = win.getContentSize();
  const left = SIDEBAR + (panelOpen ? PANEL : 0);
  const top = TOPBAR + (panes.length > 1 ? PANE_HEAD : 0);
  const usable = width - left - GAP * (panes.length - 1);
  let x = left;
  const rects = panes.map((_, i) => {
    const rect = { x, y: top, width: Math.max(0, Math.round(usable * fractions[i])), height: Math.max(0, height - top) };
    x += rect.width + GAP;
    return rect;
  });
  for (const tab of tabs.values()) {
    if (tab.shown && !panes.includes(tab.id)) {
      tab.shown = false;
      tab.hiddenAt = Date.now();
      tab.view?.setVisible(false);
    }
  }
  // A fullscreen page that was closed or unloaded never says it left.
  if (fullscreenTab && (!fullscreenTab.view || !panes.includes(fullscreenTab.id))) {
    fullscreenTab = null;
    win.setFullScreen(false);
  }
  if (!fullscreenTab) hideFullscreenNotice();
  panes.forEach((id, i) => {
    const tab = tabs.get(id);
    const view = ensureView(tab);
    const full = tab === fullscreenTab;
    view.setBounds(full ? { x: 0, y: 0, width, height } : rects[i]);
    view.setVisible(!fullscreenTab || full);
    if (full) win.contentView.addChildView(view); // above the other panes and the suggestions
    if (full && fullscreenNotice) {
      win.contentView.addChildView(fullscreenNotice);
      fullscreenNotice.setBounds({ x: Math.round(width / 2 - 220), y: 24, width: 440, height: 48 });
    }
    tab.shown = true;
    if (win.isFocused()) tab.unread = false;
  });
  return rects;
}

function showFullscreenNotice() {
  if (fullscreenNotice) return;
  const notice = new WebContentsView();
  fullscreenNotice = notice;
  notice.setBackgroundColor('#00000000');
  lockPage(notice.webContents);
  const html = `<body style="margin:0;display:flex;justify-content:center;font:15px system-ui,sans-serif">
    <div style="padding:12px 20px;border-radius:24px;background:rgba(32,32,32,.9);color:#fff"></div></body>`;
  notice.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  notice.webContents.once('did-finish-load', () =>
    notice.webContents.executeJavaScript(`document.querySelector('div').textContent = ${JSON.stringify(t('fullscreenEsc'))}`));
  render();
  setTimeout(hideFullscreenNotice, 3500);
}

function hideFullscreenNotice() {
  const notice = fullscreenNotice;
  if (!notice) return;
  fullscreenNotice = null;
  if (!win.isDestroyed()) win.contentView.removeChildView(notice);
  notice.webContents.close();
}

/* ---------- Rendering ---------- */

function render() {
  if (!win || win.isDestroyed()) return;
  const rects = layout();
  const tab = current();
  if (tab) lastTab[tab.serviceId] = tab.id;
  win.setTitle(tab?.title ? `${tab.title} — AI Hub` : 'AI Hub');
  const wc = tab?.view?.webContents;
  if (wc && wc !== selectedContents) {
    selectedContents = wc;
    chromeExtensions.get(wc.session)?.selectTab(wc);
  }
  ui.send('state', {
    services: services.map((s) => {
      const list = serviceTabs(s.id);
      return {
        ...s,
        icon: s.icon ?? list.find((t) => t.favicon)?.favicon ?? favicon(s.url),
        customIcon: !!s.icon,
        count: list.reduce((sum, t) => sum + titleCount(t.title), 0),
        unread: list.some((t) => t.unread),
        sleeping: !list.some((t) => t.view),
        // A section is named after the chat open in it, until it is given a name.
        label: s.parent && !s.named ? (tabs.get(lastTab[s.id]) ?? list[0])?.title || s.name : s.name,
      };
    }),
    presets: [{ name: t('browser'), url: '' }, ...PRESETS].map((p) => ({ ...p, icon: favicon(p.url) })),
    activeService: tab?.serviceId ?? null,
    tabs: tab
      ? serviceTabs(tab.serviceId).map((t) => ({
          id: t.id, title: t.title || t.url, favicon: t.favicon, loading: t.loading, sleeping: !t.view, unread: !!t.unread, active: t.id === tab.id,
          pinned: !!t.pinned, muted: !!t.muted, audible: !!t.view?.webContents.isCurrentlyAudible(),
        }))
      : [],
    panes: rects.map((r, i) => ({ id: panes[i], title: tabs.get(panes[i]).title, x: r.x, width: r.width, focused: i === focused })),
    nav: tab
      ? {
          url: tab.url, loading: tab.loading, canBack: !!wc?.navigationHistory.canGoBack(), canForward: !!wc?.navigationHistory.canGoForward(),
          partition: partitionOf(tab.serviceId), contentsId: wc?.id ?? null,
          bookmarked: bookmarks.some((b) => b.url === tab.url), canBookmark: isWeb(tab.url),
          zoom: Math.round((wc?.getZoomFactor() ?? 1) * 100),
          reader: !!tab.reader,
        }
      : null,
    extensions: listExtensions(wc?.session),
    history: panelView === 'history' ? history.filter(matches(historyQuery)).slice(0, 300) : [],
    bookmarks: panelView === 'bookmarks' ? bookmarks : [],
    downloads,
    settings: {
      theme: settings.theme, unloadMinutes: settings.unloadMinutes, lang: settings.lang,
      notify: settings.notify, downloadDir: downloadDir(), askDownload: settings.askDownload, adblock: settings.adblock,
      darkSites: settings.darkSites, globalHotkey: settings.globalHotkey,
    },
  });
}

/* ---------- Services ---------- */

function addService({ name, url }) {
  let parsed = null; // none for a browser service
  try {
    if (url) parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return;
  }
  name = String(name || parsed?.hostname || t('browser')).trim();
  // Adding the same service twice is how a second account is made, so names stay distinct.
  const same = services.filter((s) => s.name === name || s.name.startsWith(`${name} `)).length;
  if (same) name = `${name} ${same + 1}`;
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'browser'}-${Date.now().toString(36)}`;
  services.push({ id, name, url: parsed?.href ?? '', neverUnload: false });
  save('services.json', services);
  selectService(id);
}

function removeService(id) {
  const service = serviceById(id);
  if (!service || !confirm(t(service.parent ? 'confirmRemoveSection' : 'confirmRemove', { name: service.name }))) return;
  const removed = family(id);
  for (const tab of removed.flatMap((s) => serviceTabs(s.id))) closeTab(tab.id);
  services = services.filter((s) => !removed.includes(s));
  save('services.json', services);
  // Ids are never reused, so nothing could ever open this storage again.
  if (!service.parent) session.fromPartition(`persist:${id}`).clearStorageData();
  if (!panes.length && services[0]) selectService(services[0].id);
  render();
}

function addSection(parentId) {
  const parent = serviceById(parentId);
  if (!parent || parent.parent) return;
  const siblings = services.filter((s) => s.parent === parent.id);
  const section = {
    id: `${parent.id}-${Date.now().toString(36)}`, name: `${parent.name} ${siblings.length + 2}`, url: parent.url, parent: parent.id, neverUnload: false,
  };
  services.splice(services.indexOf(siblings.at(-1) ?? parent) + 1, 0, section);
  parent.collapsed = false;
  save('services.json', services);
  selectService(section.id);
}

function toggleNeverUnload(id) {
  const service = serviceById(id);
  if (!service) return;
  service.neverUnload = !service.neverUnload;
  save('services.json', services);
  render();
}

async function signOut(ids, message) {
  if (!confirm(message)) return;
  for (const id of ids.map(rootOf)) {
    for (const tab of family(id).flatMap((s) => serviceTabs(s.id))) {
      sleep(tab);
      tab.url = serviceById(id).url;
    }
    const ses = session.fromPartition(`persist:${id}`);
    await ses.clearStorageData();
    await ses.clearCache();
  }
  render();
}

/* ---------- Sessions: downloads and request tracking ---------- */

// The app's own pages hold window.hub: a link or file dropped on them must not replace them.
function lockPage(wc) {
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function wireSession(ses) {
  if (wiredSessions.has(ses)) return;
  wiredSessions.add(ses);
  setSiteLanguage(ses);
  wireExtensions(ses);
  if (settings.adblock) setAdblock(ses, true);

  // Without setSavePath Electron shows the regular "Save as" dialog.
  ses.on('will-download', (event, item, wc) => {
    if (wc && !hadGesture(wc)) {
      const asked = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: [t('allow'), t('deny')], defaultId: 1, cancelId: 1,
        message: t('downloadAsk', { site: URL.parse(wc.getURL())?.host ?? '', name: item.getFilename() }),
      });
      if (asked !== 0) return event.preventDefault();
    }
    if (wc) gestures.delete(wc); // the next file after the same click is asked about
    const target = settings.askDownload ? null : freePath(downloadDir(), item.getFilename());
    if (target) item.setSavePath(target);
    const download = {
      id: nextDownloadId++, name: item.getFilename(), url: item.getURL(), received: 0, total: item.getTotalBytes(),
      state: 'progressing', paused: false, path: target ?? '', icon: null, startedAt: Date.now(),
    };
    downloads.unshift(download);
    downloadItems.set(download.id, { item, ses });
    const update = (state) => {
      download.state = state;
      download.paused = item.isPaused();
      download.received = item.getReceivedBytes();
      download.total = item.getTotalBytes();
      download.path = item.getSavePath();
      if (download.path) download.name = path.basename(download.path);
      render();
    };
    item.on('updated', (_, state) => update(state));
    item.once('done', (_, state) => {
      update(state);
      if (state !== 'completed') return;
      app.getFileIcon(download.path).then((img) => {
        download.icon = img.toDataURL();
        render();
      }, () => {});
    });
    render();
  });

  // Requests still in flight usually mean a reply is streaming, so the tab must not be unloaded.
  const track = (start) => ({ webContentsId, id, resourceType }) => {
    if (!webContentsId || resourceType === 'webSocket') return;
    let requests = inflight.get(webContentsId);
    if (start) {
      if (!requests) inflight.set(webContentsId, (requests = new Map()));
      requests.set(id, Date.now());
      return;
    }
    const startedAt = requests?.get(id);
    requests?.delete(id);
    if (startedAt && resourceType === 'xhr') checkReply(webContentsId, startedAt);
  };
  ses.webRequest.onSendHeaders(track(true));
  ses.webRequest.onCompleted(track(false));
  ses.webRequest.onErrorOccurred(track(false));

  // Synchronous queries (navigator.permissions, Notification.permission). Real camera and mic
  // access always goes through the prompt below, so media reports "allowed" until refused:
  // a "denied" here makes some sites hide their voice buttons without ever asking.
  ses.setPermissionCheckHandler((_, permission, origin, details) => {
    const saved = permissions[`${origin} ${permission === 'media' ? details.mediaType : permission}`];
    return saved ?? (ALWAYS_ALLOWED.has(permission) || permission === 'media');
  });
  ses.setPermissionRequestHandler((wc, permission, callback, details) => askPermission(permission, details, wc).then(callback));
}

// Asks like Chrome does; "remember" stores the answer per site and per kind (audio, video, ...).
async function askPermission(permission, details, wc) {
  if (ALWAYS_ALLOWED.has(permission)) return true;
  if (permission === 'openExternal') {
    if (DANGEROUS_SCHEME.test(URL.parse(details.externalURL ?? '')?.protocol ?? 'file:')) return false;
    if (wc && !hadGesture(wc)) return false; // no click: not asked at all
  }
  let origin;
  try {
    origin = new URL(details.requestingUrl).origin;
  } catch {
    return false;
  }
  const kinds = permission === 'media' ? (details.mediaTypes?.length ? details.mediaTypes : ['audio']) : [permission];
  const saved = kinds.map((kind) => permissions[`${origin} ${kind}`]);
  if (saved.every((answer) => answer === true)) return true;
  if (saved.some((answer) => answer === false)) return false;
  if (win.isDestroyed()) return false;

  const what = kinds.map((kind) => {
    const label = t(`perm_${kind}`, { url: details.externalURL ?? '' });
    return label === `perm_${kind}` ? t('perm_other', { name: kind }) : label;
  }).join(', ');
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('allow'), t('deny')],
    defaultId: 1,
    cancelId: 1,
    message: t('permissionAsk', { site: new URL(origin).host, what }),
    ...(permission === 'openExternal' ? {} : { checkboxLabel: t('remember'), checkboxChecked: false }),
  });
  const allowed = response === 0;
  if (checkboxChecked) {
    for (const kind of kinds) permissions[`${origin} ${kind}`] = allowed;
    save('permissions.json', permissions);
  }
  return allowed;
}

// A reply streams as one long fetch started right after Enter or a click on "send". When such a
// request ends and the tab is out of sight, the user gets a notification and an unread mark.
// ponytail: guesses from request timing; a service streaming over WebSocket is not noticed.
function checkReply(webContentsId, startedAt) {
  const tab = [...tabs.values()].find((t) => t.view?.webContents.id === webContentsId);
  if (!tab?.inputAt || Date.now() - startedAt < 4000 || startedAt < tab.inputAt || startedAt - tab.inputAt > 3000) return;
  tab.inputAt = 0; // one notification per message
  if (tab.shown && win.isFocused() && !win.isMinimized()) return;
  tab.unread = true;
  render();
  if (!settings.notify || !Notification.isSupported()) return;
  const notification = new Notification({
    title: serviceById(tab.serviceId)?.name ?? 'AI Hub',
    body: t('replyReady', { title: tab.title || tab.url }),
    icon: path.join(__dirname, 'icon.png'),
  });
  notification.on('click', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (tabs.has(tab.id)) showTab(tab);
  });
  tab.notification = notification; // kept so the click handler is not garbage collected
  notification.show();
}

// "(3) Inbox" -> 3: sites put their unread count in the title.
const titleCount = (title) => Number(title.match(/^\s*[([](\d+)[)\]]/)?.[1] ?? 0);

const downloadDir = () => settings.downloadDir || app.getPath('downloads');

// "file.pdf", "file (1).pdf", ... skipping names on disk and those of downloads still running.
function freePath(dir, name) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null; // the folder is gone and cannot be made: ask instead
  }
  const { name: base, ext } = path.parse(name);
  let file = path.join(dir, name);
  for (let i = 1; fs.existsSync(file) || downloads.some((d) => d.path === file); i++) file = path.join(dir, `${base} (${i})${ext}`);
  return file;
}

function saveHistory() {
  if (!historyDirty) return;
  historyDirty = false;
  save('history.json', history);
}

function unloadIdleTabs() {
  const limit = settings.unloadMinutes * 60_000;
  let slept = false;
  if (limit > 0) {
    for (const tab of tabs.values()) {
      if (!tab.view || tab.shown || tab.pinned || serviceById(tab.serviceId)?.neverUnload) continue;
      const wc = tab.view.webContents;
      // ponytail: a site holding a long-poll request open never unloads; filter such URLs if that shows up.
      if (Date.now() - tab.hiddenAt < limit || inflight.get(wc.id)?.size || wc.isCurrentlyAudible()) continue;
      sleep(tab);
      slept = true;
    }
  }
  if (slept) render();
  saveSession();
  saveHistory();
}

/* ---------- Ad blocker ---------- */

// What blocker.enableBlockingInSession does, minus its ipcMain.handle calls: those are global and
// throw on the second session, so they are registered once when the blocker loads.
function setAdblock(ses, on) {
  if (!blocker || on === adblockPreloads.has(ses)) return;
  if (on) {
    adblockPreloads.set(ses, ses.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') }));
  } else {
    ses.unregisterPreloadScript(adblockPreloads.get(ses));
    adblockPreloads.delete(ses);
  }
  ses.webRequest.onBeforeRequest(on ? blocker.onBeforeRequest : null);
  ses.webRequest.onHeadersReceived(on ? blocker.onHeadersReceived : null);
}

/* ---------- Chrome extensions ---------- */

// Extensions are installed once into a shared folder and loaded into every service's profile.
// Whatever one profile loads or drops (install, update, uninstall) is mirrored to the others.
const extensionsDir = () => path.join(app.getPath('userData'), 'Extensions');
const tabOf = (wc) => [...tabs.values()].find((tab) => tab.view?.webContents === wc);
const serviceOf = (ses) => topServices().find((s) => session.fromPartition(`persist:${s.id}`) === ses);

function wireExtensions(ses) {
  chromeExtensions.set(ses, new ElectronChromeExtensions({
    session: ses,
    createTab: async (details) => {
      const service = serviceOf(ses);
      const tab = makeTab(service.id, details.url || service.url);
      if (details.active === false) ensureView(tab);
      else showTab(tab);
      render();
      return [tab.view.webContents, win];
    },
    selectTab: (wc) => tabOf(wc) && showTab(tabOf(wc)),
    removeTab: (wc) => tabOf(wc) && closeTab(tabOf(wc).id),
    createWindow: async (details) => {
      const popup = new BrowserWindow({
        width: details.width ?? 800,
        height: details.height ?? 600,
        autoHideMenuBar: true,
        webPreferences: { session: ses },
      });
      const url = [details.url ?? []].flat()[0];
      wirePopup(popup);
      if (canOpen(url)) popup.loadURL(url);
      return popup;
    },
  }));

  ses.extensions.on('extension-loaded', (_, ext) => {
    for (const other of chromeExtensions.keys()) {
      if (other !== ses && !other.extensions.getExtension(ext.id)) other.extensions.loadExtension(ext.path).catch(() => {});
    }
    render();
  });
  // Same path only: during an update the new version is already loading under the same id.
  ses.extensions.on('extension-unloaded', (_, ext) => {
    for (const other of chromeExtensions.keys()) {
      if (other.extensions.getExtension(ext.id)?.path === ext.path) other.extensions.removeExtension(ext.id);
    }
    render();
  });

  installChromeWebStore({
    session: ses,
    extensionsPath: extensionsDir(),
    autoUpdate: chromeExtensions.size === 1, // one profile checks for updates, the mirroring does the rest
    beforeInstall: async ({ localizedName, manifest }) => {
      const sites = [...new Set([
        ...(manifest.host_permissions ?? []),
        ...(manifest.permissions ?? []).filter((p) => p.includes('://') || p === '<all_urls>'), // Manifest V2
        ...(manifest.content_scripts ?? []).flatMap((c) => c.matches ?? []),
      ])];
      const risky = (manifest.permissions ?? []).filter((p) => RISKY_PERMISSIONS.has(p));
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: [t('install'), t('cancel')],
        defaultId: 1,
        cancelId: 1,
        message: t('installExtension', { name: localizedName }),
        detail: [
          sites.length ? t('extensionSites', { sites: sites.slice(0, 8).join('\n') + (sites.length > 8 ? '\n…' : '') }) : '',
          risky.length ? t('extensionPermissions', { list: risky.join(', ') }) : '',
          t('extensionsHint'),
        ].filter(Boolean).join('\n\n'),
      });
      return { action: response === 0 ? 'allow' : 'deny' };
    },
  }).catch((error) => console.error('Chrome Web Store:', error));
}

function listExtensions(ses = chromeExtensions.keys().next().value) {
  if (!ses) return [];
  return ses.extensions.getAllExtensions().map((ext) => {
    const options = ext.manifest.options_ui?.page ?? ext.manifest.options_page;
    return { id: ext.id, name: ext.name, version: ext.version, icon: extensionIcon(ext)?.toDataURL() ?? null, options: !!options };
  });
}

// The biggest icon from the manifest, scaled to 32px.
function extensionIcon(ext) {
  if (!extensionIcons.has(ext.path)) {
    const icons = ext.manifest.icons ?? {};
    const best = Object.keys(icons).sort((a, b) => b - a)[0];
    extensionIcons.set(ext.path, best ? nativeImage.createFromPath(path.join(ext.path, icons[best])).resize({ width: 32 }) : null);
  }
  return extensionIcons.get(ext.path);
}

// Toolbar icons for <browser-action-list>. The library fails the request when an extension has no
// default action icon and set none for this tab (Stylus); Chrome shows the manifest icon then.
function handleExtensionIcons() {
  session.defaultSession.protocol.handle('crx', async (request) => {
    const url = new URL(request.url);
    const ses = session.fromPartition(url.searchParams.get('partition') ?? '');
    const response = await chromeExtensions.get(ses)?.api.browserAction.handleCRXRequest(request);
    if (response?.ok) return response;
    const ext = ses.extensions.getExtension(url.pathname.split('/')[1]);
    const icon = ext && extensionIcon(ext);
    return icon ? new Response(icon.toPNG(), { headers: { 'Content-Type': 'image/png' } }) : new Response(null, { status: 404 });
  });
}

function extensionSession() {
  return currentContents()?.session ?? chromeExtensions.keys().next().value;
}

/* ---------- Input and menus ---------- */

function toUrl(text) {
  text = text.trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(localhost|[^\s/]+\.[^\s/]{2,})(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

// Chrome's zoom steps; a step of 0 goes back to 100%.
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function zoom(wc, step) {
  if (!wc) return;
  const now = wc.getZoomFactor();
  const next = step === 0 ? 1 : step > 0 ? ZOOM_STEPS.find((f) => f > now + 0.001) : ZOOM_STEPS.findLast((f) => f < now - 0.001);
  if (next) wc.setZoomFactor(next);
  render();
}

// Shortcuts by physical key (input.code), so they work in any keyboard layout.
function onKey(event, input) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const code = input.code;
  const wc = currentContents();
  const history = wc?.navigationHistory;
  if (code === 'Escape') {
    if (current()?.reader) toggleReader(current());
    ui.send('cmd', 'escape');
    return;
  }
  if (ctrl && input.shift && code === 'KeyT') reopenClosedTab();
  else if (ctrl && code === 'KeyT') newTab();
  else if (ctrl && code === 'KeyW') current() && closeTab(current().id);
  else if (ctrl && code === 'Tab') cycleTab(input.shift ? -1 : 1);
  else if (ctrl && code === 'KeyF') ui.focus(), ui.send('cmd', 'find');
  else if (ctrl && (code === 'KeyL' || code === 'KeyK' || code === 'KeyE')) ui.focus(), ui.send('cmd', 'address');
  else if ((ctrl && code === 'KeyR') || code === 'F5') reload(current());
  else if (input.alt && code === 'ArrowLeft') history?.goBack();
  else if (input.alt && code === 'ArrowRight') history?.goForward();
  else if (ctrl && (code === 'Equal' || code === 'NumpadAdd')) zoom(wc, 0.5);
  else if (ctrl && (code === 'Minus' || code === 'NumpadSubtract')) zoom(wc, -0.5);
  else if (ctrl && (code === 'Digit0' || code === 'Numpad0')) zoom(wc, 0);
  else if (code === 'F12') wc?.toggleDevTools();
  else if (input.alt && code === 'KeyP') togglePip(wc);
  else if (ctrl && code === 'KeyP') wc?.print();
  else if (ctrl && code === 'KeyS') savePage(wc);
  else if (ctrl && code === 'KeyD') toggleBookmark();
  else if (ctrl && code === 'KeyH') ui.send('cmd', 'history');
  else if (ctrl && /^Digit[1-9]$/.test(code) && topServices()[code.slice(5) - 1]) selectService(topServices()[code.slice(5) - 1].id);
  else return;
  event.preventDefault();
}

// Runs as a user gesture: extension buttons cannot give one, so the PiP extension works only once.
// ponytail: every frame toggles its own biggest video, two frames with videos would fight.
const PIP = `(() => {
  if (document.pictureInPictureElement) return document.exitPictureInPicture();
  const video = [...document.querySelectorAll('video')].filter((v) => v.readyState && !v.disablePictureInPicture)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  return video?.requestPictureInPicture();
})()`;
const togglePip = (wc) => wc?.mainFrame.framesInSubtree.forEach((frame) => frame.executeJavaScript(PIP, true).catch(() => {}));

// The page's own text is translated in place: Google's proxy page would load the site again
// without its cookies, and sites behind a sign-in or Cloudflare break there. Runs in an isolated
// world, which shares the DOM but not the page's scripts. Text added later stays untranslated.
const TRANSLATE_WORLD = 1001;
const COLLECT_TEXT = `(() => {
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.trim() && !skip.has(n.parentElement?.tagName) && !n.parentElement?.isContentEditable ? 1 : 2),
  });
  window.textNodes = [];
  for (let n; (n = walker.nextNode()); ) window.textNodes.push(n);
  return [...new Set(window.textNodes.map((n) => n.nodeValue.trim()))];
})()`;
const APPLY_TRANSLATION = (done) => `((done) => {
  window.originals = window.originals ?? new Map();
  for (const n of window.textNodes) {
    const key = n.nodeValue.trim();
    if (!done[key]) continue;
    if (!window.originals.has(n)) window.originals.set(n, n.nodeValue);
    n.nodeValue = n.nodeValue.replace(key, done[key]);
  }
})(${JSON.stringify(done)})`;
const RESTORE_TEXT = `for (const [n, text] of window.originals ?? []) n.nodeValue = text; window.originals = new Map();`;

async function translatePage(tab) {
  const wc = tab.view?.webContents;
  if (!wc) return;
  const run = (code) => wc.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD, [{ code }]);
  const texts = await run(COLLECT_TEXT);
  // Up to 100 strings and about 5000 characters per request.
  const batches = [];
  for (const text of texts) {
    const last = batches.at(-1);
    if (last && last.length < 100 && last.reduce((n, q) => n + q.length, 0) + text.length < 5000) last.push(text);
    else batches.push([text.slice(0, 5000)]);
  }
  const done = {};
  await Promise.all(batches.map(async (batch) => {
    const response = await webFetch(`https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=${settings.lang}`, {
      method: 'POST',
      body: new URLSearchParams(batch.map((q) => ['q', q])),
    });
    const result = await response.json();
    batch.forEach((q, i) => (done[q] = typeof result[i] === 'string' ? result[i] : result[i]?.[0]));
  })).catch((error) => console.error('Translate:', error.message));
  if (wc.isDestroyed()) return;
  await run(APPLY_TRANSLATION(done));
  tab.translated = true;
}

function showOriginal(tab) {
  tab.view?.webContents.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD, [{ code: RESTORE_TEXT }]);
  tab.translated = false;
}
const translateTextUrl = (text) => `https://translate.google.com/?sl=auto&tl=${settings.lang}&op=translate&text=${encodeURIComponent(text)}`;

// Reader mode: Firefox's Readability picks the article out of a copy of the page, shown over
// the page itself in a shadow root, so the site's styles and scripts stay out of it.
const READER_WORLD = 1002;
const READABILITY = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
const READER = (dark) => `(() => {
  const open = document.getElementById('aihub-reader');
  if (open) {
    open.remove();
    document.documentElement.style.overflow = '';
    return false;
  }
  const article = new Readability(document.cloneNode(true)).parse();
  if (!article?.content) return null;
  const host = document.createElement('div');
  host.id = 'aihub-reader';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const css = new CSSStyleSheet(); // a constructed sheet: the site's CSP does not stop it
  css.replaceSync(\`
    :host { all: initial; }
    .reader-scroll { position: absolute; inset: 0; overflow: auto; background: ${dark ? '#1e1e1e' : '#f7f5f0'}; color: ${dark ? '#ddd' : '#222'}; }
    article { max-width: 720px; margin: 0 auto; padding: 48px 24px 96px; font: 19px/1.7 Georgia, serif; }
    h1 { font: 700 32px/1.25 system-ui, sans-serif; margin: 0 0 8px; }
    .meta { font: 14px system-ui, sans-serif; opacity: .6; margin-bottom: 32px; }
    img, video, figure { max-width: 100%; height: auto; }
    a { color: ${dark ? '#8ab4f8' : '#1a0dab'}; }
    pre, code { font-size: 15px; white-space: pre-wrap; }
  \`);
  root.adoptedStyleSheets = [css];
  root.innerHTML = '<div class="reader-scroll"><article><h1></h1><div class="meta"></div><div class="content"></div></article></div>';
  root.querySelector('h1').textContent = article.title || document.title;
  root.querySelector('.meta').textContent = [article.byline, article.siteName].filter(Boolean).join(' · ');
  root.querySelector('.content').innerHTML = article.content;
  document.documentElement.style.overflow = 'hidden';
  document.documentElement.append(host);
  return true;
})()`;

async function toggleReader(tab) {
  const wc = tab?.view?.webContents;
  if (!wc || !isWeb(tab.url)) return;
  const shown = await wc.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code: `${READABILITY}\n${READER(settings.theme !== 'light')}` }]).catch(() => null);
  if (shown === null) dialog.showMessageBox(win, { type: 'info', message: t('noArticle') });
  tab.reader = !!shown;
  render();
}

async function savePage(wc) {
  if (!wc) return;
  const name = wc.getTitle().replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'page';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(downloadDir(), `${name}.html`),
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (!canceled && filePath) wc.savePage(filePath, 'HTMLComplete').catch((error) => console.error('Save page:', error.message));
}

const popup = (template) => Menu.buildFromTemplate(template).popup({ window: win });
const separator = { type: 'separator' };

function pageMenu(tab, p) {
  const wc = tab.view.webContents;
  const fromExtensions = chromeExtensions.get(wc.session)?.getContextMenuItems(wc, p) ?? [];
  const items = p.dictionarySuggestions.map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) }));
  if (p.misspelledWord) items.push({ label: t('addToDictionary'), click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, separator);
  if (isWeb(p.linkURL)) {
    items.push(
      { label: t('openLinkNewTab'), click: () => showTab(makeTab(tab.serviceId, p.linkURL)) },
      { label: t('openLinkBeside'), enabled: panes.length < MAX_PANES, click: () => openBeside(makeTab(tab.serviceId, p.linkURL)) },
      { label: t('openLinkBrowser'), click: () => openExternal(p.linkURL) },
      { label: t('copyLink'), click: () => clipboard.writeText(p.linkURL) },
      separator,
    );
  }
  if (p.mediaType === 'video') items.push({ label: t('pip'), accelerator: 'Alt+P', click: () => togglePip(wc) }, separator);
  if (p.mediaType === 'image') {
    items.push(
      { label: t('saveImage'), click: () => wc.downloadURL(p.srcURL) },
      { label: t('copyImage'), click: () => wc.copyImageAt(p.x, p.y) },
      separator,
    );
  }
  if (p.isEditable) {
    items.push(
      { role: 'cut', label: t('cut') },
      { role: 'copy', label: t('copy') },
      { role: 'paste', label: t('paste') },
      { role: 'selectAll', label: t('selectAll') },
      separator,
    );
  } else if (p.selectionText) items.push({ role: 'copy', label: t('copy') }, separator);
  if (p.selectionText.trim()) {
    const text = p.selectionText.trim();
    const short = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    items.push({
      label: t('searchText', { text: short }),
      click: () => showTab(makeTab(tab.serviceId, `https://www.google.com/search?q=${encodeURIComponent(text)}`)),
    }, {
      label: t('translateText', { text: short }),
      click: () => showTab(makeTab(tab.serviceId, translateTextUrl(text))),
    }, separator);
  }
  items.push(
    { label: t('back'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: t('forward'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: t('reload'), click: () => reload(tab) },
    separator,
    tab.translated
      ? { label: t('showOriginal'), click: () => showOriginal(tab) }
      : { label: t('translatePage'), enabled: isWeb(tab.url), click: () => translatePage(tab) },
    { label: t(tab.reader ? 'closeReader' : 'reader'), enabled: isWeb(tab.url), click: () => toggleReader(tab) },
    { label: t('print'), accelerator: 'Ctrl+P', click: () => wc.print() },
    { label: t('savePage'), accelerator: 'Ctrl+S', click: () => savePage(wc) },
    separator,
    ...(fromExtensions.length ? [...fromExtensions, separator] : []),
    { label: t('inspect'), click: () => wc.inspectElement(p.x, p.y) },
  );
  popup(items);
}

function unload(list) {
  list.forEach(sleep);
  render();
}

function tabMenu(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  popup([
    { label: t('openBeside'), enabled: !panes.includes(id) && panes.length < MAX_PANES, click: () => openBeside(tab) },
    { label: t('reload'), click: () => reload(tab) },
    { label: t(tab.pinned ? 'unpinTab' : 'pinTab'), click: () => togglePin(tab) },
    { label: t(tab.muted ? 'unmuteTab' : 'muteTab'), click: () => toggleMute(tab) },
    { label: t('duplicate'), click: () => showTab(makeTab(tab.serviceId, tab.url, tab.title, tab.favicon)) },
    { label: t('openInBrowser'), click: () => openExternal(tab.url) },
    { label: t('copyAddress'), click: () => clipboard.writeText(tab.url) },
    // Only tabs off screen: one on screen would be loaded straight back.
    { label: t('unloadTab'), enabled: !!tab.view && !tab.shown, click: () => unload([tab]) },
    separator,
    { label: t('close'), click: () => closeTab(id) },
    { label: t('closeOthers'), click: () => serviceTabs(tab.serviceId).filter((other) => other !== tab && !other.pinned).forEach((other) => closeTab(other.id)) },
  ]);
}

function serviceMenu(id) {
  const service = serviceById(id);
  if (!service) return;
  const awake = serviceTabs(id).filter((tab) => tab.view && !tab.shown);
  popup([
    { label: t('newTab'), click: () => newTab(id) },
    {
      label: t('openBeside'),
      enabled: panes.length < MAX_PANES,
      click: () => openBeside(serviceTabs(id).find((t) => !panes.includes(t.id)) ?? makeTab(id, service.url)),
    },
    ...(service.parent ? [] : [{ label: t('newSection'), click: () => addSection(id) }]),
    { label: t('neverUnload'), type: 'checkbox', checked: service.neverUnload, click: () => toggleNeverUnload(id) },
    { label: t('unloadService'), enabled: awake.length > 0, click: () => unload(awake) },
    separator,
    { label: t('signOut'), click: () => signOut([id], t('confirmSignOut', { name: service.name })) },
    { label: t('editService'), click: () => ui.send('edit', id) },
    { label: t(service.parent ? 'removeSection' : 'removeService'), click: () => removeService(id) },
  ]);
}

/* ---------- UI actions ---------- */

const actions = {
  ready: render,
  selectService,
  selectTab: (id) => tabs.has(id) && showTab(tabs.get(id)),
  newTab: () => newTab(),
  closeTab,
  tabMenu,
  serviceMenu,
  navigate: (text) => {
    const wc = currentContents();
    if (!wc || !String(text).trim()) return;
    wc.loadURL(toUrl(String(text)));
    wc.focus();
  },
  back: () => currentContents()?.navigationHistory.goBack(),
  forward: () => currentContents()?.navigationHistory.goForward(),
  reload: () => reload(current()),
  stop: () => currentContents()?.stop(),
  // Electron's findNext means "start a new search", hence the inversion.
  find: ({ text, forward = true, next = false }) =>
    text ? currentContents()?.findInPage(text, { forward, findNext: !next }) : currentContents()?.stopFindInPage('clearSelection'),
  stopFind: () => currentContents()?.stopFindInPage('clearSelection'),
  focusPane: (i) => {
    if (!panes[i]) return;
    focused = i;
    render();
    currentContents()?.focus();
  },
  closePane: (i) => {
    if (!panes[i]) return;
    removePane(i);
    render();
  },
  split: (values) => {
    if (!Array.isArray(values) || values.length !== panes.length || !values.every((v) => typeof v === 'number' && v > 0)) return;
    const sum = values.reduce((a, b) => a + b, 0);
    fractions = values.map((v) => v / sum);
    render();
  },
  panel: (open) => {
    panelOpen = !!open;
    panelView = typeof open === 'string' ? open : null;
    render();
  },
  suggest,
  suggestSelect: (i) => {
    selectedSuggestion = Number.isInteger(i) ? i : -1;
    if (suggestView) sendSuggestions();
  },
  pickSuggestion,
  toggleBookmark: () => toggleBookmark(),
  toggleReader: () => toggleReader(current()),
  toggleMute: (id) => tabs.has(id) && toggleMute(tabs.get(id)),
  removeBookmark: (url) => {
    bookmarks = bookmarks.filter((b) => b.url !== url);
    save('bookmarks.json', bookmarks);
    render();
  },
  openUrl,
  zoomReset: () => zoom(currentContents(), 0),
  openUrlInBackground: (url) => {
    const service = current()?.serviceId ?? services[0]?.id;
    if (service && isWeb(url)) {
      makeTab(service, url);
      render();
    }
  },
  historySearch: (query) => {
    historyQuery = String(query ?? '');
    render();
  },
  removeHistory: (url) => {
    history = history.filter((h) => h.url !== url);
    historyDirty = true;
    render();
  },
  clearHistory: () => {
    if (!confirm(t('confirmClearHistory'))) return;
    history = [];
    historyDirty = true;
    saveHistory();
    render();
  },
  addService,
  removeService,
  toggleNeverUnload,
  renameService: ({ id, name }) => {
    const service = serviceById(id);
    name = String(name ?? '').trim().slice(0, 60);
    if (!service || (!name && !service.parent)) return;
    if (name) service.name = name;
    if (service.parent) service.named = !!name; // emptied: back to the chat's title
    save('services.json', services);
    render();
  },
  // Kept in services.json as a 64px PNG data URL: the file itself may move or vanish.
  chooseServiceIcon: async (id) => {
    const service = serviceById(id);
    if (!service) return;
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: t('images'), extensions: ['png', 'jpg', 'jpeg', 'ico'] }],
    });
    if (canceled || !filePaths[0]) return;
    const image = nativeImage.createFromPath(filePaths[0]);
    if (image.isEmpty()) return dialog.showMessageBox(win, { type: 'error', message: t('badImage') });
    const { width, height } = image.getSize();
    service.icon = image.resize({ [width >= height ? 'width' : 'height']: 64, quality: 'best' }).toDataURL();
    save('services.json', services);
    render();
  },
  resetServiceIcon: (id) => {
    const service = serviceById(id);
    if (!service) return;
    delete service.icon;
    save('services.json', services);
    render();
  },
  toggleSections: (id) => {
    const service = serviceById(id);
    if (!service) return;
    service.collapsed = !service.collapsed;
    save('services.json', services);
    render();
  },
  signOutAll: () => signOut(topServices().map((s) => s.id), t('confirmSignOutAll')),
  setting: ({ key, value }) => {
    if (key === 'theme' && Object.hasOwn(THEMES, value)) {
      settings.theme = value;
      nativeTheme.themeSource = THEMES[value];
    } else if (key === 'unloadMinutes' && Number(value) >= 0) settings.unloadMinutes = Number(value);
    else if ((key === 'notify' || key === 'askDownload') && typeof value === 'boolean') settings[key] = value;
    else if (key === 'adblock' && typeof value === 'boolean') {
      settings.adblock = value;
      wiredSessions.forEach((ses) => setAdblock(ses, value));
    }
    else if (key === 'globalHotkey' && typeof value === 'boolean') settings.globalHotkey = setGlobalHotkey(value) && value;
    // Chromium's own darkening of light pages: a switch read at startup, so it waits for a restart.
    else if (key === 'darkSites' && typeof value === 'boolean') settings.darkSites = value;
    else if (key === 'lang' && Object.hasOwn(LANGS, value)) {
      settings.lang = value;
      wiredSessions.forEach(setSiteLanguage);
    }
    else return;
    save('settings.json', settings);
    render();
  },
  chooseDownloadDir: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      defaultPath: downloadDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return;
    settings.downloadDir = filePaths[0];
    save('settings.json', settings);
    render();
  },
  openDownloadDir: () => shell.openPath(downloadDir()),
  openWebStore: () => {
    const service = current()?.serviceId ?? services[0]?.id;
    if (service) showTab(makeTab(service, WEB_STORE));
  },
  extensionOptions: (id) => {
    const ext = extensionSession()?.extensions.getExtension(id);
    const page = ext && (ext.manifest.options_ui?.page ?? ext.manifest.options_page);
    const service = current()?.serviceId ?? services[0]?.id;
    if (page && service) showTab(makeTab(service, `chrome-extension://${id}/${page}`));
  },
  removeExtension: async (id) => {
    const ses = extensionSession();
    const ext = ses?.extensions.getExtension(id);
    if (!ext) return;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [t('remove'), t('cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('confirmRemoveExtension', { name: ext.name }),
    });
    if (response === 0) await uninstallExtension(id, { session: ses, extensionsPath: extensionsDir() }).catch((error) => console.error(error));
    render();
  },
  openDownload: (id) => {
    const download = downloads.find((d) => d.id === id);
    if (download?.path) shell.openPath(download.path);
  },
  showDownload: (id) => {
    const download = downloads.find((d) => d.id === id);
    if (download?.path) shell.showItemInFolder(download.path);
  },
  cancelDownload: (id) => downloadItems.get(id)?.item.cancel(),
  pauseDownload: (id) => {
    const item = downloadItems.get(id)?.item;
    if (item?.isPaused()) item.resume();
    else item?.pause();
    const download = downloads.find((d) => d.id === id);
    if (download && item) download.paused = item.isPaused();
    render();
  },
  // A new download of the same URL replaces the failed entry.
  retryDownload: (id) => {
    const download = downloads.find((d) => d.id === id);
    if (!download) return;
    const ses = downloadItems.get(id)?.ses;
    actions.removeDownload(id);
    ses?.downloadURL(download.url);
  },
  removeDownload: (id) => {
    const i = downloads.findIndex((d) => d.id === id);
    if (i < 0) return;
    if (downloads[i].state === 'progressing') downloadItems.get(id)?.item.cancel();
    downloads.splice(i, 1);
    downloadItems.delete(id);
    render();
  },
  resetPermissions: () => {
    permissions = {};
    save('permissions.json', permissions);
  },
  moveService: ({ id, to }) => {
    const tops = topServices();
    const service = serviceById(id);
    if (!service || service.parent || !(to >= 0 && to < tops.length)) return;
    tops.splice(tops.indexOf(service), 1);
    tops.splice(to, 0, service);
    services = tops.flatMap((top) => family(top.id));
    save('services.json', services);
    render();
  },
  moveTab: ({ id, to }) => {
    const tab = tabs.get(id);
    if (!tab) return;
    const list = serviceTabs(tab.serviceId).filter((other) => other !== tab);
    if (!(to >= 0 && to <= list.length)) return;
    list.splice(to, 0, tab);
    reorder(tab.serviceId, list);
    render();
  },
  clearDownloads: () => {
    downloads.splice(0, downloads.length, ...downloads.filter((d) => d.state === 'progressing'));
    for (const id of [...downloadItems.keys()]) if (!downloads.some((d) => d.id === id)) downloadItems.delete(id);
    render();
  },
};

ipcMain.on('ui', (event, action, arg) => {
  if (event.sender === ui && Object.hasOwn(actions, action)) actions[action](arg);
  else if (event.sender === suggestView?.webContents && action === 'pickSuggestion') pickSuggestion(arg);
});

/* ---------- Startup ---------- */

function showOrHide() {
  if (win.isFocused() && win.isVisible() && !win.isMinimized()) return win.minimize();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  currentContents()?.focus();
}

function setGlobalHotkey(on) {
  globalShortcut.unregister(GLOBAL_HOTKEY);
  if (!on || globalShortcut.register(GLOBAL_HOTKEY, showOrHide)) return true;
  dialog.showMessageBox(win, { type: 'warning', message: t('hotkeyBusy', { key: GLOBAL_HOTKEY }) });
  return false;
}

function onScreen(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
}

function start() {
  Menu.setApplicationMenu(null);
  if (process.platform === 'win32') app.setAppUserModelId('com.v2.aihub'); // notifications and taskbar group; must match build.appId
  // Updates come from GitHub releases: downloaded in the background, installed on quit.
  if (app.isPackaged) {
    const check = () => autoUpdater.checkForUpdatesAndNotify().catch((error) => console.error('Update check:', error.message));
    check();
    setInterval(check, 6 * 3600_000);
  }
  // Ghostery's ad and tracker lists, uBlock's taken straight from uBlock (Ghostery's copies lag behind,
  // and YouTube changes often), plus AdGuard Base in uBlock syntax. Fetched again when the cache is a
  // day old, the cache is the fallback offline. Sessions wired before it loads get it here.
  const cache = path.join(app.getPath('userData'), 'adblock.bin');
  const lists = [...adsAndTrackingLists.map((url) => url.replace(/.*\/ublock-origin\//,'https://ublockorigin.github.io/uAssets/filters/')),
    'https://filters.adtidy.org/extension/ublock/filters/2.txt'];
  const cached = () => ElectronBlocker.fromLists(webFetch, lists, {}, { path: cache, read: fs.promises.readFile, write: fs.promises.writeFile });
  const age = Date.now() - (fs.statSync(cache, { throwIfNoEntry: false })?.mtimeMs ?? 0);
  (age < 86400_000 ? cached() : ElectronBlocker.fromLists(webFetch, lists)
    .then(async (fresh) => (await fs.promises.writeFile(cache, fresh.serialize()), fresh))
    .catch(cached))
    .then((loaded) => {
      blocker = loaded;
      // The lists overlap: a scriptlet run twice breaks YouTube.
      const getCosmetics = blocker.getCosmeticsFilters.bind(blocker);
      blocker.getCosmeticsFilters = (...args) => {
        const result = getCosmetics(...args);
        return { ...result, scripts: [...new Set(result.scripts)] };
      };
      // The library runs every frame's scripts in the main frame: each iframe injects them there
      // again, and the doubled scriptlets break YouTube. Run them in the frame that asked.
      ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (event, url, msg) => blocker.onInjectCosmeticFilters({
        frameId: event.frameId,
        processId: event.processId,
        sender: {
          insertCSS: (css, options) => event.senderFrame === event.sender.mainFrame && event.sender.insertCSS(css, options),
          // A block keeps each scriptlet's top-level classes (JSONPath) from colliding with the next one's.
          // Sandboxed about:blank frames refuse scripts and log an error each time.
          executeJavaScript: (code) => event.senderFrame?.url.startsWith('http') && event.senderFrame.executeJavaScript(`{${code}\n}`, true).catch(() => {}),
        },
      }, url, msg));
      ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', blocker.onIsMutationObserverEnabled);
      if (settings.adblock) wiredSessions.forEach((ses) => setAdblock(ses, true));
    }, (error) => console.error('Ad blocker:', error.message));
  services = load('services.json', DEFAULT_SERVICES);
  if (!Array.isArray(services)) services = DEFAULT_SERVICES;
  // First run: the system language if there is a translation for it, English otherwise.
  if (!LANGS[settings.lang]) settings.lang = app.getPreferredSystemLanguages().map((l) => l.slice(0, 2)).find((l) => LANGS[l]) ?? 'en';
  permissions = load('permissions.json', {});
  history = load('history.json', []);
  bookmarks = load('bookmarks.json', []);
  if (!Array.isArray(history)) history = [];
  if (!Array.isArray(bookmarks)) bookmarks = [];
  for (const item of [...history, ...bookmarks]) item.favicon = safeIcon(item.favicon);
  nativeTheme.themeSource = THEMES[settings.theme] ?? 'dark';

  const bounds = settings.bounds && onScreen(settings.bounds) ? settings.bounds : { width: 1280, height: 820 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 420,
    title: 'AI Hub',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false },
  });
  handleExtensionIcons();
  if (settings.maximized) win.maximize();
  ui = win.webContents;
  lockPage(ui);
  createSuggestView();
  ui.on('before-input-event', onKey);
  win.on('page-title-updated', (event) => event.preventDefault());
  for (const event of ['resize', 'maximize', 'unmaximize', 'focus']) win.on(event, render);
  // Mouse back/forward buttons.
  win.on('app-command', (_, command) => {
    if (command === 'browser-backward') currentContents()?.navigationHistory.goBack();
    if (command === 'browser-forward') currentContents()?.navigationHistory.goForward();
  });
  win.on('close', () => {
    settings.bounds = win.getNormalBounds();
    settings.maximized = win.isMaximized();
    save('settings.json', settings);
    saveSession();
    saveHistory();
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  const saved = load('session.json', { tabs: [], active: -1 });
  const restored = (Array.isArray(saved.tabs) ? saved.tabs : []).map((t) => {
    if (!serviceById(t.serviceId) || typeof t.url !== 'string') return null;
    const tab = makeTab(t.serviceId, t.url, t.title, safeIcon(t.favicon));
    tab.pinned = !!t.pinned;
    return tab;
  });
  const active = restored[saved.active] ?? restored.find(Boolean);
  if (active) showTab(active);
  else if (services[0]) selectService(services[0].id);

  setInterval(unloadIdleTabs, 15_000);
  if (settings.globalHotkey) setGlobalHotkey(true);
}

// Sites learn the language from the Accept-Language header (changed at once) and from
// navigator.language, which follows Chromium's locale and is fixed at startup.
function setSiteLanguage(ses) {
  const accept = settings.lang === 'en' ? 'en-US,en' : `${settings.lang},en;q=0.8`;
  ses.setUserAgent(ses.getUserAgent(), accept);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  settings = { ...DEFAULT_SETTINGS, ...load('settings.json', {}) };
  if (LANGS[settings.lang]) app.commandLine.appendSwitch('lang', settings.lang === 'en' ? 'en-US' : settings.lang);
  if (settings.darkSites) app.commandLine.appendSwitch('blink-settings', 'forceDarkModeEnabled=true');
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
