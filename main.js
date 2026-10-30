// AI Hub: a sidebar of AI services, each with its own tabs, in one window.
// The window's own page (ui/) draws the sidebar, tab strip, toolbar and side panel; every tab
// is a WebContentsView laid over the content area. All tab state lives here, the UI only
// renders the snapshot it is sent.
const { app, BrowserWindow, WebContentsView, Menu, Notification, dialog, ipcMain, nativeTheme, screen, session, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { LANGS, translate } = require('./ui/i18n.js');

// Must match the sizes in ui/style.css.
const SIDEBAR = 56;
const TOPBAR = 80;
const PANE_HEAD = 28;
const GAP = 6;
const PANEL = 380;
const MAX_PANES = 3;
const ERROR_PAGE = path.join(__dirname, 'ui', 'error.html');

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
  theme: 'dark', unloadMinutes: 15, lang: null, bounds: null, maximized: false, notify: true, downloadDir: null, askDownload: false,
};
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
const downloads = [];
const downloadItems = new Map();
let nextDownloadId = 1;
const inflight = new Map(); // webContents id -> Map of request id -> start time
const wiredSessions = new Set();

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
    tabs: list.map(({ serviceId, url, title, favicon }) => ({ serviceId, url, title, favicon })),
    active: list.indexOf(current()),
  });
}

/* ---------- Tabs ---------- */

const serviceById = (id) => services.find((s) => s.id === id);
const serviceTabs = (id) => [...tabs.values()].filter((t) => t.serviceId === id);
const t = (key, vars) => translate(settings.lang, key, vars);
const current = () => tabs.get(panes[focused]);
const currentContents = () => current()?.view?.webContents;
const favicon = (url) => `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
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
  const view = new WebContentsView({ webPreferences: { partition: `persist:${tab.serviceId}` } });
  const wc = view.webContents;
  tab.view = view;
  wireSession(wc.session);

  wc.setWindowOpenHandler(({ url, disposition }) => {
    // window.open with a size is a real popup (OAuth sign-in): it needs window.opener to work.
    if (disposition === 'new-window') return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
    const opened = makeTab(tab.serviceId, url);
    if (disposition === 'background-tab') render();
    else showTab(opened);
    return { action: 'deny' };
  });

  const onNavigate = () => {
    // On the error page the tab keeps the address that failed.
    if (!isErrorPage(wc)) tab.url = wc.getURL() || tab.url;
    render();
  };
  wc.on('did-navigate', onNavigate);
  wc.on('did-navigate-in-page', onNavigate);
  wc.on('did-fail-load', (_, code, description, url, isMainFrame) => {
    // -3 (ERR_ABORTED) is a navigation cut short by another one, not a failure.
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return;
    tab.url = url || tab.url;
    wc.loadFile(ERROR_PAGE, { query: { url: tab.url, code: description || String(code), lang: settings.lang } });
  });
  wc.on('page-title-updated', (_, title) => { tab.title = title; render(); });
  wc.on('page-favicon-updated', (_, icons) => { tab.favicon = icons[0] ?? null; render(); });
  wc.on('did-start-loading', () => { tab.loading = true; render(); });
  wc.on('did-stop-loading', () => { tab.loading = false; render(); });
  wc.on('focus', () => {
    const i = panes.indexOf(tab.id);
    if (i >= 0 && i !== focused) { focused = i; render(); }
  });
  wc.on('found-in-page', (_, result) => ui.send('find-result', result));
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
  wc.loadURL(tab.url);
  return view;
}

const isErrorPage = (wc) => wc.getURL().startsWith('file:');

// Reloading the error page would only show it again, so the failed address is loaded instead.
function reload(tab) {
  const wc = tab?.view?.webContents;
  if (!wc) return tab && showTab(tab);
  if (isErrorPage(wc)) wc.loadURL(tab.url);
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
  if (service) showTab(tabs.get(lastTab[id]) ?? serviceTabs(id)[0] ?? makeTab(id, service.url));
}

function newTab(serviceId = current()?.serviceId ?? services[0]?.id) {
  const service = serviceById(serviceId);
  if (service) showTab(makeTab(service.id, service.url));
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
  panes.forEach((id, i) => {
    const tab = tabs.get(id);
    const view = ensureView(tab);
    view.setBounds(rects[i]);
    view.setVisible(true);
    tab.shown = true;
    if (win.isFocused()) tab.unread = false;
  });
  return rects;
}

/* ---------- Rendering ---------- */

function render() {
  if (!win || win.isDestroyed()) return;
  const rects = layout();
  const tab = current();
  if (tab) lastTab[tab.serviceId] = tab.id;
  win.setTitle(tab?.title ? `${tab.title} — AI Hub` : 'AI Hub');
  const wc = tab?.view?.webContents;
  ui.send('state', {
    services: services.map((s) => {
      const list = serviceTabs(s.id);
      return {
        ...s,
        icon: list.find((t) => t.favicon)?.favicon ?? favicon(s.url),
        count: list.reduce((sum, t) => sum + titleCount(t.title), 0),
        unread: list.some((t) => t.unread),
        sleeping: !list.some((t) => t.view),
      };
    }),
    presets: PRESETS.map((p) => ({ ...p, icon: favicon(p.url) })),
    activeService: tab?.serviceId ?? null,
    tabs: tab
      ? serviceTabs(tab.serviceId).map((t) => ({
          id: t.id, title: t.title || t.url, favicon: t.favicon, loading: t.loading, sleeping: !t.view, unread: !!t.unread, active: t.id === tab.id,
        }))
      : [],
    panes: rects.map((r, i) => ({ id: panes[i], title: tabs.get(panes[i]).title, x: r.x, width: r.width, focused: i === focused })),
    nav: tab
      ? { url: tab.url, loading: tab.loading, canBack: !!wc?.navigationHistory.canGoBack(), canForward: !!wc?.navigationHistory.canGoForward() }
      : null,
    downloads,
    settings: {
      theme: settings.theme, unloadMinutes: settings.unloadMinutes, lang: settings.lang,
      notify: settings.notify, downloadDir: downloadDir(), askDownload: settings.askDownload,
    },
  });
}

/* ---------- Services ---------- */

function addService({ name, url }) {
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return;
  }
  name = String(name || parsed.hostname).trim();
  // Adding the same service twice is how a second account is made, so names stay distinct.
  const same = services.filter((s) => s.name === name || s.name.startsWith(`${name} `)).length;
  if (same) name = `${name} ${same + 1}`;
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
  services.push({ id, name, url: parsed.href, neverUnload: false });
  save('services.json', services);
  selectService(id);
}

function removeService(id) {
  const service = serviceById(id);
  if (!service || !confirm(t('confirmRemove', { name: service.name }))) return;
  for (const tab of serviceTabs(id)) closeTab(tab.id);
  services = services.filter((s) => s !== service);
  save('services.json', services);
  // Ids are never reused, so nothing could ever open this storage again.
  session.fromPartition(`persist:${id}`).clearStorageData();
  if (!panes.length && services[0]) selectService(services[0].id);
  render();
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
  for (const id of ids) {
    for (const tab of serviceTabs(id)) {
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

function wireSession(ses) {
  if (wiredSessions.has(ses)) return;
  wiredSessions.add(ses);
  setSiteLanguage(ses);

  // Without setSavePath Electron shows the regular "Save as" dialog.
  ses.on('will-download', (_, item) => {
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
  ses.setPermissionRequestHandler((_, permission, callback, details) => askPermission(permission, details).then(callback));
}

// Asks like Chrome does; "remember" stores the answer per site and per kind (audio, video, ...).
async function askPermission(permission, details) {
  if (ALWAYS_ALLOWED.has(permission)) return true;
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
    defaultId: 0,
    cancelId: 1,
    message: t('permissionAsk', { site: new URL(origin).host, what }),
    checkboxLabel: t('remember'),
    checkboxChecked: true,
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

function unloadIdleTabs() {
  const limit = settings.unloadMinutes * 60_000;
  let slept = false;
  if (limit > 0) {
    for (const tab of tabs.values()) {
      if (!tab.view || tab.shown || serviceById(tab.serviceId)?.neverUnload) continue;
      const wc = tab.view.webContents;
      // ponytail: a site holding a long-poll request open never unloads; filter such URLs if that shows up.
      if (Date.now() - tab.hiddenAt < limit || inflight.get(wc.id)?.size || wc.isCurrentlyAudible()) continue;
      sleep(tab);
      slept = true;
    }
  }
  if (slept) render();
  saveSession();
}

/* ---------- Input and menus ---------- */

function toUrl(text) {
  text = text.trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(localhost|[^\s/]+\.[^\s/]{2,})(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function zoom(wc, step) {
  if (wc) wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + step);
}

// Shortcuts by physical key (input.code), so they work in any keyboard layout.
function onKey(event, input) {
  if (input.type !== 'keyDown') return;
  const ctrl = input.control || input.meta;
  const code = input.code;
  const wc = currentContents();
  const history = wc?.navigationHistory;
  if (code === 'Escape') {
    ui.send('cmd', 'escape');
    return;
  }
  if (ctrl && input.shift && code === 'KeyT') reopenClosedTab();
  else if (ctrl && code === 'KeyT') newTab();
  else if (ctrl && code === 'KeyW') current() && closeTab(current().id);
  else if (ctrl && code === 'Tab') cycleTab(input.shift ? -1 : 1);
  else if (ctrl && code === 'KeyF') ui.send('cmd', 'find');
  else if (ctrl && code === 'KeyL') ui.send('cmd', 'address');
  else if ((ctrl && code === 'KeyR') || code === 'F5') reload(current());
  else if (input.alt && code === 'ArrowLeft') history?.goBack();
  else if (input.alt && code === 'ArrowRight') history?.goForward();
  else if (ctrl && (code === 'Equal' || code === 'NumpadAdd')) zoom(wc, 0.5);
  else if (ctrl && (code === 'Minus' || code === 'NumpadSubtract')) zoom(wc, -0.5);
  else if (ctrl && (code === 'Digit0' || code === 'Numpad0')) zoom(wc, 0);
  else if (code === 'F12') wc?.toggleDevTools();
  else if (ctrl && /^Digit[1-9]$/.test(code) && services[code.slice(5) - 1]) selectService(services[code.slice(5) - 1].id);
  else return;
  event.preventDefault();
}

const popup = (template) => Menu.buildFromTemplate(template).popup({ window: win });
const separator = { type: 'separator' };

function pageMenu(tab, p) {
  const wc = tab.view.webContents;
  const items = p.dictionarySuggestions.map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) }));
  if (p.misspelledWord) items.push({ label: t('addToDictionary'), click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, separator);
  if (p.linkURL) {
    items.push(
      { label: t('openLinkNewTab'), click: () => showTab(makeTab(tab.serviceId, p.linkURL)) },
      { label: t('openLinkBeside'), enabled: panes.length < MAX_PANES, click: () => openBeside(makeTab(tab.serviceId, p.linkURL)) },
      { label: t('openLinkBrowser'), click: () => openExternal(p.linkURL) },
      { label: t('copyLink'), click: () => clipboard.writeText(p.linkURL) },
      separator,
    );
  }
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
  items.push(
    { label: t('back'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: t('forward'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: t('reload'), click: () => reload(tab) },
    separator,
    { label: t('inspect'), click: () => wc.inspectElement(p.x, p.y) },
  );
  popup(items);
}

function tabMenu(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  popup([
    { label: t('openBeside'), enabled: !panes.includes(id) && panes.length < MAX_PANES, click: () => openBeside(tab) },
    { label: t('reload'), click: () => reload(tab) },
    { label: t('duplicate'), click: () => showTab(makeTab(tab.serviceId, tab.url, tab.title, tab.favicon)) },
    { label: t('openInBrowser'), click: () => openExternal(tab.url) },
    { label: t('copyAddress'), click: () => clipboard.writeText(tab.url) },
    separator,
    { label: t('close'), click: () => closeTab(id) },
    { label: t('closeOthers'), click: () => serviceTabs(tab.serviceId).filter((other) => other !== tab).forEach((other) => closeTab(other.id)) },
  ]);
}

function serviceMenu(id) {
  const service = serviceById(id);
  if (!service) return;
  popup([
    { label: t('newTab'), click: () => newTab(id) },
    {
      label: t('openBeside'),
      enabled: panes.length < MAX_PANES,
      click: () => openBeside(serviceTabs(id).find((t) => !panes.includes(t.id)) ?? makeTab(id, service.url)),
    },
    { label: t('neverUnload'), type: 'checkbox', checked: service.neverUnload, click: () => toggleNeverUnload(id) },
    separator,
    { label: t('signOut'), click: () => signOut([id], t('confirmSignOut', { name: service.name })) },
    { label: t('removeService'), click: () => removeService(id) },
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
    render();
  },
  addService,
  removeService,
  toggleNeverUnload,
  signOutAll: () => signOut(services.map((s) => s.id), t('confirmSignOutAll')),
  setting: ({ key, value }) => {
    if (key === 'theme' && THEMES[value]) {
      settings.theme = value;
      nativeTheme.themeSource = THEMES[value];
    } else if (key === 'unloadMinutes' && Number(value) >= 0) settings.unloadMinutes = Number(value);
    else if ((key === 'notify' || key === 'askDownload') && typeof value === 'boolean') settings[key] = value;
    else if (key === 'lang' && LANGS[value]) {
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
    const service = serviceById(id);
    if (!service || !(to >= 0 && to < services.length)) return;
    services.splice(services.indexOf(service), 1);
    services.splice(to, 0, service);
    save('services.json', services);
    render();
  },
  // Tabs keep their order as the insertion order of the map, so the map is rebuilt.
  moveTab: ({ id, to }) => {
    const tab = tabs.get(id);
    if (!tab) return;
    const list = serviceTabs(tab.serviceId).filter((other) => other !== tab);
    if (!(to >= 0 && to <= list.length)) return;
    list.splice(to, 0, tab);
    const rest = [...tabs.values()].filter((other) => other.serviceId !== tab.serviceId);
    tabs.clear();
    for (const other of [...rest, ...list]) tabs.set(other.id, other);
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
});

/* ---------- Startup ---------- */

function onScreen(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
}

function start() {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.aihub.app'); // Windows shows notifications under this id
  services = load('services.json', DEFAULT_SERVICES);
  if (!Array.isArray(services)) services = DEFAULT_SERVICES;
  // First run: the system language if there is a translation for it, English otherwise.
  if (!LANGS[settings.lang]) settings.lang = app.getPreferredSystemLanguages().map((l) => l.slice(0, 2)).find((l) => LANGS[l]) ?? 'en';
  permissions = load('permissions.json', {});
  nativeTheme.themeSource = THEMES[settings.theme] ?? 'dark';

  const bounds = settings.bounds && onScreen(settings.bounds) ? settings.bounds : { width: 1280, height: 820 };
  win = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 420,
    title: 'AI Hub',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (settings.maximized) win.maximize();
  ui = win.webContents;
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
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  const saved = load('session.json', { tabs: [], active: -1 });
  const restored = (Array.isArray(saved.tabs) ? saved.tabs : []).map((t) =>
    serviceById(t.serviceId) && typeof t.url === 'string' ? makeTab(t.serviceId, t.url, t.title, t.favicon) : null);
  const active = restored[saved.active] ?? restored.find(Boolean);
  if (active) showTab(active);
  else if (services[0]) selectService(services[0].id);

  setInterval(unloadIdleTabs, 15_000);
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
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
}
