// Renders the state pushed by main.js and sends user actions back. The only state of its own
// is which side panel view is open.
const $ = (id) => document.getElementById(id);
const { send, on } = window.hub;
let state = null;
let view = null; // a key of TITLES, or null
let lang = null;
let editing = null; // id of the service in the edit view
const rendered = {};

const t = (key, vars) => translate(lang, key, vars);
const withHotkey = (text, hotkey) => (hotkey ? `${text} (${hotkey})` : text);

// Rebuilds a section only when its data changed, otherwise favicons would flicker on every push.
function changed(name, value) {
  const key = JSON.stringify(value);
  if (rendered[name] === key) return false;
  rendered[name] = key;
  return true;
}

function applyLang() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = withHotkey(t(node.dataset.i18nTitle), node.dataset.hotkey);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  // Every dynamic section carries text too.
  for (const key of Object.keys(rendered)) delete rendered[key];
}

function el(tag, { dataset, ...props } = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset); // dataset itself cannot be assigned
  node.append(...children);
  return node;
}

const GOOGLE_ICONS = 'https://www.google.com/s2/favicons';

// A favicon, or a coloured square with the first letter when there is none. Some sites
// (Perplexity) forbid loading their favicon from another page, so a failed one is retried
// through Google's favicon service first.
function icon(src, name, className) {
  const box = el('span', { className });
  const letter = () => {
    box.textContent = (name.trim()[0] ?? '?').toUpperCase();
    box.style.background = `hsl(${[...name].reduce((h, c) => h + c.charCodeAt(0) * 37, 0) % 360} 50% 42%)`;
  };
  const fallback = (img) => {
    const host = URL.parse(src)?.hostname;
    if (host && !img.src.startsWith(GOOGLE_ICONS)) img.src = `${GOOGLE_ICONS}?domain=${host}&sz=64`;
    else letter();
  };
  if (src) box.append(el('img', { src, alt: '', draggable: false, onerror: (e) => fallback(e.target) }));
  else letter();
  return box;
}

// Reordering by dragging with the mouse. Plain mouse events, not HTML5 drag and drop: that one
// needs an OS drag session, which did not start here. While a drag is on, re-renders are held
// back, since replacing the nodes under the cursor would lose it. The dragged item follows the
// cursor and the others step aside; after the drop the item glides from where it was let go
// into its new place (see glideDropped).
let sorting = false;
let dropped = null; // { key, rect } of the item just let go

function sortable(nodes, axis, onMove) {
  const coord = (e) => (axis === 'x' ? e.clientX : e.clientY);
  const translate = (px) => (axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`);

  nodes.forEach((node, from) => {
    node.addEventListener('mousedown', (down) => {
      if (down.button !== 0 || down.target.closest('.tab-close, .tab-audio')) return;
      const start = coord(down);
      // Positions as they were before the drag: the moved nodes must not change the answer.
      const rects = nodes.map((n) => n.getBoundingClientRect());
      const middles = rects.map((r) => (axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2));
      const step = axis === 'x' ? rects[from].width + 2 : rects[from].height + 8; // the size plus the gap
      let to = from; // insertion point in the list as it was before the drag
      const move = (e) => {
        if (!sorting && Math.abs(coord(e) - start) < 5) return;
        if (!sorting) node.parentNode.classList.add('sorting');
        sorting = true;
        to = middles.findIndex((m) => coord(e) < m);
        if (to < 0) to = nodes.length;
        node.classList.add('dragged');
        node.style.transform = translate(coord(e) - start);
        nodes.forEach((other, i) => {
          if (other === node) return;
          const shift = i > from && i < to ? -step : i >= to && i < from ? step : 0;
          other.style.transform = shift ? translate(shift) : '';
        });
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!sorting) return;
        sorting = false;
        node.parentNode.classList.remove('sorting');
        const target = to > from ? to - 1 : to;
        dropped = { key: node.dataset.key, rect: node.getBoundingClientRect() };
        if (target !== from) return onMove(from, target); // the new order arrives with the next state
        renderServices(true);
        renderTabs(true);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}

// The item let go glides from the drop point into its new slot.
function glideDropped(container) {
  const node = dropped && [...container.children].find((n) => n.dataset.key === dropped.key);
  if (!node) return;
  const now = node.getBoundingClientRect();
  const { rect } = dropped;
  dropped = null;
  node.animate([{ transform: `translate(${rect.left - now.left}px, ${rect.top - now.top}px)` }, { transform: 'none' }],
    { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} ${t('mb')}`;

/* ---------- Sidebar, tabs, toolbar ---------- */

function serviceButton(s, hotkey) {
  return el('button', {
    dataset: { key: s.id },
    className: 'service' + (s.id === state.activeService ? ' active' : '') + (s.neverUnload ? ' pinned' : '')
      + (s.sleeping ? ' sleeping' : '') + (s.parent ? ' section' : ''),
    title: withHotkey(s.sleeping ? `${s.label} (${t('sleepingHint')})` : s.label, hotkey),
    onclick: () => {
      if (view) setView(null); // the snapshot under the panel would show the old page
      send('selectService', s.id);
    },
    oncontextmenu: () => send('serviceMenu', s.id),
  },
  icon(s.icon, s.name, 'service-icon'),
  // The site's own count from its title, or a dot for a reply that has not been looked at.
  s.count || s.unread ? el('span', { className: 'badge' + (s.count ? '' : ' dot'), textContent: s.count > 99 ? '99+' : s.count || '' }) : '');
}

// Top level services, each followed by an arrow and its sections (folded sections still show
// the one on screen). Only the top level is sorted by dragging, sections move with their parent.
function renderServices(force) {
  if (sorting || (!changed('services', [state.services, state.activeService]) && !force)) return;
  const tops = state.services.filter((s) => !s.parent);
  const topButtons = tops.map((s, i) => serviceButton(s, i < 9 ? `Ctrl+${i + 1}` : ''));
  $('services').replaceChildren(...tops.flatMap((top, i) => {
    const sections = state.services.filter((s) => s.parent === top.id);
    if (!sections.length) return [topButtons[i]];
    const toggle = el('button', {
      className: 'section-toggle',
      textContent: `${top.collapsed ? '▸' : '▾'} ${sections.length}`,
      title: t(top.collapsed ? 'showSections' : 'hideSections'),
      onclick: () => send('toggleSections', top.id),
    });
    const shown = sections.filter((s) => !top.collapsed || s.id === state.activeService);
    return [topButtons[i], toggle, ...shown.map((s) => serviceButton(s, ''))];
  }));
  sortable(topButtons, 'y', (from, to) => send('moveService', { id: tops[from].id, to }));
  glideDropped($('services'));
  moveIndicator();
}

// The bar left of the active service: one element that slides from service to service.
function moveIndicator() {
  const active = $('services').querySelector('.service.active');
  $('indicator').hidden = !active;
  if (!active) return;
  const r = active.getBoundingClientRect();
  const visible = r.bottom > $('services').getBoundingClientRect().top && r.top < $('services').getBoundingClientRect().bottom;
  $('indicator').style.transform = `translateY(${r.top + r.height / 2 - 12}px)`;
  $('indicator').style.opacity = visible ? 1 : 0;
}

// A new tab grows in, a closed one shrinks away; switching to another service swaps the whole
// strip at once. The strip is rebuilt on every change (a title, a favicon), so an animation
// under way is carried on with a negative delay instead of starting over.
const TAB_ANIMATION = 200; // ms, as in style.css
let stripService = null;
let tabOrder = []; // ids as last drawn
let shownActive = null; // key of the active tab last scrolled into sight
const born = new Map(); // tab id -> when it appeared (0: was there already)
const closing = new Map(); // tab id -> { node, at, index } while it shrinks away

function renderTabs(force) {
  if (sorting || (!changed('tabs', state.tabs) && !force)) return;
  const now = performance.now();
  const sameService = stripService === state.activeService;
  if (!sameService) {
    born.clear();
    closing.clear();
  }
  const ids = state.tabs.map((tab) => tab.id);
  tabOrder.forEach((id, index) => {
    if (sameService && !ids.includes(id) && !closing.has(id)) {
      const node = [...$('tabs').children].find((n) => n.dataset.key === String(id));
      if (!node) return;
      closing.set(id, { node, at: now, index });
      setTimeout(() => node.remove(), TAB_ANIMATION); // a timer: animationend is skipped when the window is hidden
    }
  });
  for (const id of ids) if (!born.has(id)) born.set(id, sameService ? now : 0);
  for (const id of born.keys()) if (!ids.includes(id)) born.delete(id);
  stripService = state.activeService;
  tabOrder = ids;
  const nodes = state.tabs.map((tab) => el('div', {
    dataset: { key: tab.id },
    className: 'tab' + (tab.active ? ' active' : '') + (tab.sleeping ? ' sleeping' : '') + (tab.unread ? ' unread' : '')
      + (tab.pinned ? ' pinned' : '') + (now - born.get(tab.id) < TAB_ANIMATION ? ' tab-new' : ''),
    title: tab.title,
    onclick: () => send('selectTab', tab.id),
    onmousedown: (e) => e.button === 1 && e.preventDefault(), // no autoscroll on middle click
    onauxclick: (e) => e.button === 1 && send('closeTab', tab.id),
    oncontextmenu: () => send('tabMenu', tab.id),
  },
  tab.loading ? el('span', { className: 'spinner' }) : icon(tab.favicon, tab.title, 'tab-favicon'),
  tab.pinned ? '' : el('span', { className: 'tab-title', textContent: tab.title }),
  tab.audible || tab.muted ? el('button', {
    className: 'tab-audio',
    textContent: tab.muted ? '🔇' : '🔊',
    title: t(tab.muted ? 'unmuteTab' : 'muteTab'),
    onclick: (e) => {
      e.stopPropagation();
      send('toggleMute', tab.id);
    },
  }) : '',
  tab.pinned ? '' : el('button', {
    className: 'tab-close',
    textContent: '✕',
    title: withHotkey(t('close'), 'Ctrl+W'),
    onclick: (e) => {
      e.stopPropagation();
      send('closeTab', tab.id);
    },
  })));
  nodes.forEach((node, i) => (node.style.animationDelay = `${Math.min(0, born.get(ids[i]) - now)}ms`));
  $('tabs').replaceChildren(...nodes);
  // A closed tab: its old node stays in its place a moment, shrinking.
  for (const [id, ghost] of closing) {
    if (now - ghost.at >= TAB_ANIMATION) {
      closing.delete(id);
      continue;
    }
    ghost.node.classList.remove('tab-new', 'active');
    ghost.node.classList.add('tab-closing');
    ghost.node.style.animationDelay = `${ghost.at - now}ms`;
    $('tabs').insertBefore(ghost.node, nodes[ghost.index] ?? null);
  }
  sortable(nodes, 'x', (from, to) => send('moveTab', { id: state.tabs[from].id, to }));
  glideDropped($('tabs'));
  // A newly active tab is scrolled into sight; other updates leave the scroll where the user put it.
  const active = nodes.find((n) => n.classList.contains('active'));
  if (active && active.dataset.key !== shownActive) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  shownActive = active?.dataset.key;
}

function renderNav() {
  const nav = state.nav;
  // Toolbar buttons of the extensions, for the tab on screen. The element subscribes to the
  // partition it has when it is attached, so a new one is made instead of changing attributes.
  // Also after an install: an icon asked for before the extension was ready is never retried.
  $('actions').hidden = !nav?.contentsId;
  const key = `${nav?.contentsId} ${state.extensions.map((ext) => ext.id + ext.version)}`;
  if (nav?.contentsId && $('actions').dataset.key !== key) {
    const list = document.createElement('browser-action-list');
    list.id = 'actions';
    list.dataset.key = key;
    list.setAttribute('partition', nav.partition);
    list.setAttribute('tab', nav.contentsId);
    $('actions').replaceWith(list);
  }
  $('back').disabled = !nav?.canBack;
  $('forward').disabled = !nav?.canForward;
  $('reload').disabled = !nav;
  $('reload').textContent = nav?.loading ? '✕' : '⟳';
  $('reload').title = nav?.loading ? t('stop') : withHotkey(t('reload'), 'F5');
  $('address').disabled = !nav;
  // Like Chrome: the zoom shows only when it is not 100%, a click puts it back.
  $('zoom').hidden = !nav || nav.zoom === 100;
  $('zoom').textContent = `${nav?.zoom}%`;
  $('zoom').title = withHotkey(t('zoomReset'), 'Ctrl+0');
  $('reader').disabled = !nav?.canBookmark;
  $('reader').classList.toggle('on', !!nav?.reader);
  $('reader').title = withHotkey(t(nav?.reader ? 'closeReader' : 'reader'), nav?.reader ? 'Esc' : '');
  $('star').disabled = !nav?.canBookmark;
  $('star').textContent = nav?.bookmarked ? '★' : '☆';
  $('star').classList.toggle('on', !!nav?.bookmarked);
  $('star').title = withHotkey(t(nav?.bookmarked ? 'removeBookmark' : 'addBookmark'), 'Ctrl+D');
  // A thin bar under the toolbar while the page loads: it creeps on, then fills up and fades.
  const bar = $('load-bar');
  if (nav?.loading && bar.className !== 'loading') {
    bar.className = '';
    void bar.offsetWidth; // from zero, without a transition
    bar.className = 'loading';
  } else if (!nav?.loading && bar.className === 'loading') {
    bar.className = 'done';
  }
  if (document.activeElement !== $('address')) $('address').value = nav?.url ?? '';
  const active = state.downloads.filter((d) => d.state === 'progressing');
  $('dl-badge').hidden = !active.length;
  $('dl-badge').textContent = active.length;
  // A progress line under the button for everything still downloading.
  const total = active.reduce((sum, d) => sum + d.total, 0);
  const received = active.reduce((sum, d) => sum + d.received, 0);
  $('downloads-btn').classList.toggle('busy', active.length > 0);
  $('downloads-btn').style.setProperty('--p', total ? received / total : 1);
  // The button flashes when a file finishes (not for the ones already done at startup).
  const done = state.downloads.filter((d) => d.state === 'completed').map((d) => d.id);
  if (finished && done.some((id) => !finished.has(id))) {
    $('downloads-btn').classList.remove('flash');
    void $('downloads-btn').offsetWidth;
    $('downloads-btn').classList.add('flash');
  }
  finished = new Set(done);
}

let finished = null; // ids of completed downloads at the last render

/* ---------- Split view chrome ---------- */

function renderPanes() {
  $('empty').hidden = state.panes.length > 0;
  if (!changed('panes', state.panes)) return;
  if (state.panes.length < 2) return $('panes').replaceChildren();
  $('panes').replaceChildren(...state.panes.flatMap((p, i) => {
    const head = el('div', { className: 'pane-head' + (p.focused ? ' focused' : ''), onclick: () => send('focusPane', i) },
      el('span', { className: 'pane-name', textContent: p.title }),
      el('button', {
        className: 'pane-close',
        textContent: '✕',
        title: t('closePane'),
        onclick: (e) => {
          e.stopPropagation();
          send('closePane', i);
        },
      }));
    head.style.left = `${p.x}px`;
    head.style.width = `${p.width}px`;
    if (i === state.panes.length - 1) return [head];
    const divider = el('div', { className: 'divider', onmousedown: (e) => dragDivider(e, i) });
    divider.style.left = `${p.x + p.width}px`;
    return [head, divider];
  }));
}

// Chromium keeps routing a drag to the element that got the mousedown, so the drag survives
// the cursor passing over a tab view.
function dragDivider(event, i) {
  event.preventDefault();
  const start = event.clientX;
  const widths = state.panes.map((p) => p.width);
  const total = widths.reduce((a, b) => a + b, 0);
  let frame = 0;
  const move = (e) => {
    const next = widths.map((w) => w / total);
    const delta = (e.clientX - start) / total;
    next[i] += delta;
    next[i + 1] -= delta;
    if (next[i] < 0.1 || next[i + 1] < 0.1) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => send('split', next));
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('dragging');
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
  document.body.classList.add('dragging');
}

/* ---------- Side panel ---------- */

const TITLES = {
  add: 'newService', settings: 'settings', downloads: 'downloads', extensions: 'extensions', history: 'history', bookmarks: 'bookmarks', edit: 'editService',
};

// The panel lies over the pages. They are native views drawn above this document, so main.js
// first sends a snapshot of each (see 'shots'); the panel slides in over those and the views are
// hidden. Closing slides it out first and then lets main.js show the views again.
let closingPanel = 0;

function setView(next) {
  if (next === view) return;
  const was = view;
  view = next;
  rendered.view = null;
  if (view) send('panel', view);
  if (view && was) return renderPanel(); // another view in the open panel
  if (view) {
    // Reopened while sliding out: the views are still hidden, no new snapshots come.
    if (closingPanel) showPanel();
    clearTimeout(closingPanel);
    closingPanel = 0;
    return; // otherwise shown once the snapshots are in
  }
  document.body.classList.remove('panel-open');
  closingPanel = setTimeout(() => {
    closingPanel = 0;
    $('panel').hidden = true;
    $('backdrop').hidden = true;
    send('panel', null);
    setTimeout(() => !view && $('shots').replaceChildren(), 150); // once the live pages are back
  }, 180);
}

function showPanel() {
  $('panel').hidden = false;
  $('backdrop').hidden = false;
  renderPanel();
  void $('panel').offsetWidth; // the closed position first, so the slide runs
  document.body.classList.add('panel-open');
}

const toggleView = (next) => setView(view === next ? null : next);

on('shots', (shots) => {
  if (!view) return;
  $('shots').replaceChildren(...shots.map((s) => {
    const img = el('img', { src: s.src, alt: '' });
    Object.assign(img.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.width}px`, height: `${s.height}px` });
    return img;
  }));
  showPanel();
  if (view === 'edit') $('edit-name').focus();
  // Two frames: the snapshots are on screen before the live pages go.
  requestAnimationFrame(() => requestAnimationFrame(() => send('panelCover')));
});

function renderPanel() {
  const data = [view, editing, state.services, state.presets, state.settings, state.downloads, state.extensions, state.history, state.bookmarks];
  if (!view || !changed('view', data)) return;
  $('panel-title').textContent = t(TITLES[view]).replace(/…$/, ''); // a menu item's "…" is not part of the title
  for (const kind of Object.keys(TITLES)) $(`view-${kind}`).hidden = kind !== view;
  if (view === 'add') renderPresets();
  if (view === 'settings') renderSettings();
  if (view === 'downloads') renderDownloads();
  if (view === 'extensions') renderExtensions();
  if (view === 'history') renderLinks($('history-list'), state.history, 'removeHistory', t('noHistory'), true);
  if (view === 'edit') renderEdit();
  if (view === 'bookmarks') renderLinks($('bookmark-list'), state.bookmarks, 'removeBookmark', t('noBookmarks'));
}

// "14:05" for today, "3 окт., 14:05" before.
function when(at) {
  const date = new Date(at);
  const today = date.toDateString() === new Date().toDateString();
  const parts = today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  return date.toLocaleString(lang, parts);
}

// History and bookmarks: a click opens the page in the current tab, ✕ removes it.
function renderLinks(box, list, removeAction, empty, withTime) {
  if (!list.length) return box.replaceChildren(el('p', { className: 'hint', textContent: empty }));
  box.replaceChildren(...list.map((item) => el('div', {
    className: 'service-row link-row',
    title: item.url,
    onclick: (e) => {
      if (e.ctrlKey) return send('openUrlInBackground', item.url);
      setView(null); // the page opens under the panel
      send('openUrl', item.url);
    },
    onmousedown: (e) => e.button === 1 && e.preventDefault(), // no autoscroll on middle click
    onauxclick: (e) => e.button === 1 && send('openUrlInBackground', item.url),
  },
  icon(item.favicon, item.title || item.url, 'row-icon'),
  el('span', { className: 'row-name', textContent: item.title || item.url }),
  withTime ? el('span', { className: 'row-time', textContent: when(item.at) }) : '',
  el('button', {
    type: 'button',
    className: 'del',
    textContent: '✕',
    title: t('remove'),
    onclick: (e) => {
      e.stopPropagation();
      send(removeAction, item.url);
    },
  }))));
}

function renderPresets() {
  $('presets').replaceChildren(...state.presets.map((p) => el('button', {
    type: 'button',
    className: 'preset',
    onclick: () => {
      send('addService', p);
      setView(null);
    },
  }, icon(p.icon, p.name, 'preset-icon'), el('span', { textContent: p.name }))));
}

function markSegment(seg, value) {
  for (const btn of seg.children) btn.classList.toggle('on', btn.dataset.value === String(value));
}

function renderEdit() {
  const s = state.services.find((x) => x.id === editing);
  if (!s) return setView(null);
  if (document.activeElement !== $('edit-name')) $('edit-name').value = s.parent && !s.named ? '' : s.name;
  $('edit-name').placeholder = s.label;
  $('edit-name-hint').hidden = !s.parent;
  $('edit-icon-preview').replaceWith(Object.assign(icon(s.icon, s.label, 'preset-icon'), { id: 'edit-icon-preview' }));
  $('edit-icon-reset').disabled = !s.customIcon;
}

function openEdit(id) {
  editing = id;
  setView('edit');
  $('edit-name').focus();
}

function renderSettings() {
  $('lang').value = lang;
  markSegment($('theme-seg'), state.settings.theme);
  markSegment($('unload-seg'), state.settings.unloadMinutes);
  $('notify').checked = state.settings.notify;
  $('dark-sites').checked = state.settings.darkSites;
  $('global-hotkey').checked = state.settings.globalHotkey;
  $('service-rows').replaceChildren(...state.services.filter((s) => !s.parent).map((s) => el('div', {
    className: 'service-row' + (s.id === state.activeService ? ' current' : ''),
  },
  icon(s.icon, s.name, 'row-icon'),
  el('span', { className: 'row-name', textContent: s.name }),
  el('button', { type: 'button', className: 'edit', textContent: '✎', title: t('editService'), onclick: () => openEdit(s.id) }),
  el('button', {
    type: 'button',
    className: 'pin' + (s.neverUnload ? ' on' : ''),
    textContent: '📌',
    title: t(s.neverUnload ? 'allowUnload' : 'neverUnload'),
    onclick: () => send('toggleNeverUnload', s.id),
  }),
  el('button', { type: 'button', className: 'del', textContent: '✕', title: t('remove'), onclick: () => send('removeService', s.id) }))));
}

function renderExtensions() {
  $('adblock').checked = state.settings.adblock;
  if (!state.extensions.length) {
    $('ext-list').replaceChildren(el('p', { className: 'hint', textContent: t('noExtensions') }));
    return;
  }
  $('ext-list').replaceChildren(...state.extensions.map((ext) => el('div', { className: 'service-row' },
    icon(ext.icon, ext.name, 'row-icon'),
    el('span', { className: 'row-name', textContent: ext.name, title: `${ext.name} ${ext.version}` }),
    ext.options ? el('button', { type: 'button', className: 'ext-btn', textContent: t('options'), onclick: () => send('extensionOptions', ext.id) }) : '',
    el('button', { type: 'button', className: 'del', textContent: '✕', title: t('remove'), onclick: () => send('removeExtension', ext.id) }))));
}

function renderDownloads() {
  $('dl-dir-path').textContent = `‎${state.settings.downloadDir}`; // keeps "C:" first under direction: rtl
  $('dl-dir-path').title = state.settings.downloadDir;
  $('dl-ask').checked = state.settings.askDownload;
  if (!state.downloads.length) {
    $('dl-list').replaceChildren(el('p', { className: 'hint', textContent: t('noDownloads') }));
    return;
  }
  $('dl-list').replaceChildren(...state.downloads.map((d) => {
    const active = d.state === 'progressing';
    const done = d.state === 'completed';
    const button = (text, action, className = '') => el('button', {
      type: 'button',
      className,
      textContent: text,
      onclick: (e) => {
        e.stopPropagation();
        send(action, d.id);
      },
    });

    let meta = t(d.state);
    if (active) {
      const speed = d.received / Math.max(1, (Date.now() - d.startedAt) / 1000);
      meta = d.total ? t('progress', { done: megabytes(d.received), total: megabytes(d.total) }) : megabytes(d.received);
      meta += ` · ${d.paused ? t('paused') : t('perSecond', { v: megabytes(speed) })}`;
    } else if (done) {
      meta = megabytes(d.received);
    }

    const ext = d.name.includes('.') ? d.name.split('.').pop().slice(0, 4).toUpperCase() : '';
    const fileIcon = d.icon ? el('img', { src: d.icon, alt: '' }) : el('span', { textContent: ext || '📄' });
    const bar = el('div', { className: 'dl-bar' + (d.total ? '' : ' unknown') + (d.paused ? ' paused' : '') }, el('div'));
    bar.firstChild.style.width = d.total ? `${(d.received / d.total) * 100}%` : '';

    const actions = active
      ? [button(t(d.paused ? 'resume' : 'pause'), 'pauseDownload'), button(t('cancel'), 'cancelDownload')]
      : done
        ? [button(t('open'), 'openDownload'), button(t('folder'), 'showDownload')]
        : [button(t('retry'), 'retryDownload')];

    return el('div', {
      className: `download ${d.state}`,
      title: d.path || d.name,
      ondblclick: () => done && send('openDownload', d.id),
    },
    el('div', { className: 'dl-icon' }, fileIcon),
    el('div', { className: 'dl-body' },
      el('div', { className: 'dl-name', textContent: d.name }),
      el('div', { className: 'dl-meta', textContent: meta }),
      ...(active ? [bar] : []),
      el('div', { className: 'dl-actions' }, ...actions)),
    active ? '' : button('✕', 'removeDownload', 'dl-remove'));
  }));
}

/* ---------- Find in page ---------- */

const find = (next, forward = true) => send('find', { text: $('find-input').value, next, forward });

function openFind() {
  $('find').hidden = false;
  $('find-input').focus();
  $('find-input').select();
  if ($('find-input').value) find(false);
}

function closeFind() {
  if ($('find').hidden) return false;
  $('find').hidden = true;
  $('find-count').textContent = '';
  send('stopFind');
  return true;
}

/* ---------- Wiring ---------- */

on('state', (next) => {
  // Another page on screen (a hotkey, a link from another app): the snapshot under the panel is stale.
  if (view && state && next.nav?.contentsId !== state.nav?.contentsId) setView(null);
  // A theme change fades the colours over instead of switching at once.
  const html = document.documentElement;
  if (state && html.dataset.theme !== next.settings.theme) {
    html.classList.add('theming');
    setTimeout(() => html.classList.remove('theming'), 400);
  }
  state = next;
  html.dataset.theme = state.settings.theme;
  if (state.settings.lang !== lang) {
    lang = state.settings.lang;
    applyLang();
  }
  renderServices();
  renderTabs();
  renderNav();
  renderPanes();
  renderPanel();
});

on('edit', openEdit);

on('cmd', (cmd) => {
  if (cmd === 'find') openFind();
  if (cmd === 'history') toggleView('history');
  if (cmd === 'address') {
    $('address').focus();
    $('address').select();
  }
  if (cmd === 'escape' && !closeFind() && view) setView(null);
});

on('find-result', (r) => {
  $('find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0';
});

for (const [code, label] of Object.entries(LANGS)) $('lang').add(new Option(label, code));
$('lang').onchange = (e) => send('setting', { key: 'lang', value: e.target.value });

$('services').onscroll = moveIndicator;
// Tabs that do not fit scroll sideways, by the mouse wheel as in Chrome.
$('tabs').onwheel = (e) => ($('tabs').scrollLeft += e.deltaY || e.deltaX);
window.addEventListener('resize', moveIndicator);
$('backdrop').onclick = () => setView(null);
$('add-btn').onclick = () => toggleView('add');
$('settings-btn').onclick = () => toggleView('settings');
$('downloads-btn').onclick = () => toggleView('downloads');
$('extensions-btn').onclick = () => toggleView('extensions');
$('bookmarks-btn').onclick = () => toggleView('bookmarks');
$('history-btn').onclick = () => toggleView('history');
$('star').onclick = () => send('toggleBookmark');
$('zoom').onclick = () => send('zoomReset');
$('history-search').oninput = (e) => send('historySearch', e.target.value);
$('history-clear').onclick = () => send('clearHistory');
const rename = () => send('renameService', { id: editing, name: $('edit-name').value });
$('edit-name').onchange = rename;
$('edit-form').onsubmit = (e) => {
  e.preventDefault();
  rename();
  setView(null);
};
$('edit-icon-choose').onclick = () => send('chooseServiceIcon', editing);
$('edit-icon-reset').onclick = () => send('resetServiceIcon', editing);
$('open-web-store').onclick = () => {
  send('openWebStore');
  setView(null);
};
$('close-btn').onclick = () => setView(null);
$('add-cancel').onclick = () => setView(null);
$('new-tab').onclick = () => send('newTab');
$('back').onclick = () => send('back');
$('forward').onclick = () => send('forward');
$('reload').onclick = () => send(state?.nav?.loading ? 'stop' : 'reload');
$('sign-out-all').onclick = () => send('signOutAll');
$('reset-permissions').onclick = () => send('resetPermissions');
$('dl-clear').onclick = () => send('clearDownloads');
$('dl-dir-path').onclick = () => send('openDownloadDir');
$('dl-dir-change').onclick = () => send('chooseDownloadDir');
$('dl-ask').onchange = (e) => send('setting', { key: 'askDownload', value: e.target.checked });
$('adblock').onchange = (e) => send('setting', { key: 'adblock', value: e.target.checked });
$('notify').onchange = (e) => send('setting', { key: 'notify', value: e.target.checked });
$('dark-sites').onchange = (e) => send('setting', { key: 'darkSites', value: e.target.checked });
$('global-hotkey').onchange = (e) => send('setting', { key: 'globalHotkey', value: e.target.checked });
$('reader').onclick = () => send('toggleReader');

$('theme-seg').onclick = (e) => {
  const value = e.target.closest('button')?.dataset.value;
  if (value) send('setting', { key: 'theme', value });
};
$('unload-seg').onclick = (e) => {
  const value = e.target.closest('button')?.dataset.value;
  if (value) send('setting', { key: 'unloadMinutes', value: Number(value) });
};

$('add-form').onsubmit = (e) => {
  e.preventDefault();
  send('addService', { name: $('add-name').value.trim(), url: $('add-url').value.trim() });
  $('add-form').reset();
  setView(null);
};

/* ---------- Address bar and its suggestions ---------- */

// main.js draws the list in a view of its own (the tab views would cover anything drawn here)
// and says how many rows there are; the arrow keys pick one, -1 is the typed text itself.
let suggestionCount = 0;
let selected = -1;

function suggest(text) {
  const r = $('address').getBoundingClientRect();
  selected = -1;
  send('suggest', text ? { text, rect: { x: r.left, y: r.bottom + 4, width: r.width } } : null);
}

on('suggestions', (count) => {
  suggestionCount = count;
});

$('address-form').onsubmit = (e) => {
  e.preventDefault();
  if (selected >= 0) send('pickSuggestion', selected);
  else send('navigate', $('address').value);
  suggest(null);
  $('address').blur();
};
$('address').addEventListener('focus', () => requestAnimationFrame(() => $('address').select()));
$('address').addEventListener('input', () => suggest($('address').value));
// Later than a click on a suggestion, which takes the focus away first.
$('address').addEventListener('blur', () => setTimeout(() => suggest(null), 200));
$('address').addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestionCount) {
    e.preventDefault();
    const rows = suggestionCount + 1;
    selected = ((selected + 1 + (e.key === 'ArrowDown' ? 1 : -1) + rows) % rows) - 1;
    send('suggestSelect', selected);
  }
  if (e.key !== 'Escape') return;
  suggest(null);
  $('address').value = state?.nav?.url ?? '';
  $('address').blur();
});

$('find-input').oninput = () => find(false);
$('find-input').onkeydown = (e) => {
  if (e.key === 'Enter') find(true, !e.shiftKey);
};
$('find-next').onclick = () => find(true, true);
$('find-prev').onclick = () => find(true, false);
$('find-close').onclick = closeFind;

send('ready');
