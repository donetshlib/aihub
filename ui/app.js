// Renders the state pushed by main.js and sends user actions back. The only state of its own
// is which side panel view is open.
const $ = (id) => document.getElementById(id);
const { send, on } = window.hub;
let state = null;
let view = null; // 'add' | 'settings' | 'downloads' | null
let lang = null;
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

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
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
// back, since replacing the nodes under the cursor would lose it.
let sorting = false;

function sortable(nodes, axis, onMove) {
  const coord = (e) => (axis === 'x' ? e.clientX : e.clientY);
  const middle = (node) => {
    const r = node.getBoundingClientRect();
    return axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
  };
  const clear = () => nodes.forEach((node) => node.classList.remove('drop-before', 'drop-after', 'dragged'));

  nodes.forEach((node, from) => {
    node.addEventListener('mousedown', (down) => {
      if (down.button !== 0 || down.target.closest('.tab-close')) return;
      const start = coord(down);
      let to = from; // insertion point in the list as it was before the drag
      const move = (e) => {
        if (!sorting && Math.abs(coord(e) - start) < 5) return;
        sorting = true;
        to = nodes.findIndex((other) => coord(e) < middle(other));
        if (to < 0) to = nodes.length;
        clear();
        node.classList.add('dragged');
        if (to < nodes.length) nodes[to].classList.add('drop-before');
        else nodes[nodes.length - 1].classList.add('drop-after');
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!sorting) return;
        sorting = false;
        clear();
        const target = to > from ? to - 1 : to;
        if (target !== from) onMove(from, target);
        renderServices(true);
        renderTabs(true);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  });
}

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} ${t('mb')}`;

/* ---------- Sidebar, tabs, toolbar ---------- */

function renderServices(force) {
  if (sorting || (!changed('services', [state.services, state.activeService]) && !force)) return;
  $('services').replaceChildren(...state.services.map((s, i) => el('button', {
    className: 'service' + (s.id === state.activeService ? ' active' : '') + (s.neverUnload ? ' pinned' : '')
      + (s.sleeping ? ' sleeping' : ''),
    title: withHotkey(s.sleeping ? `${s.name} (${t('sleepingHint')})` : s.name, i < 9 ? `Ctrl+${i + 1}` : ''),
    onclick: () => send('selectService', s.id),
    oncontextmenu: () => send('serviceMenu', s.id),
  },
  icon(s.icon, s.name, 'service-icon'),
  // The site's own count from its title, or a dot for a reply that has not been looked at.
  s.count || s.unread ? el('span', { className: 'badge' + (s.count ? '' : ' dot'), textContent: s.count > 99 ? '99+' : s.count || '' }) : '')));
  sortable([...$('services').children], 'y', (from, to) => send('moveService', { id: state.services[from].id, to }));
}

function renderTabs(force) {
  if (sorting || (!changed('tabs', state.tabs) && !force)) return;
  $('tabs').replaceChildren(...state.tabs.map((tab) => el('div', {
    className: 'tab' + (tab.active ? ' active' : '') + (tab.sleeping ? ' sleeping' : '') + (tab.unread ? ' unread' : ''),
    title: tab.title,
    onclick: () => send('selectTab', tab.id),
    onmousedown: (e) => e.button === 1 && e.preventDefault(), // no autoscroll on middle click
    onauxclick: (e) => e.button === 1 && send('closeTab', tab.id),
    oncontextmenu: () => send('tabMenu', tab.id),
  },
  tab.loading ? el('span', { className: 'spinner' }) : icon(tab.favicon, tab.title, 'tab-favicon'),
  el('span', { className: 'tab-title', textContent: tab.title }),
  el('button', {
    className: 'tab-close',
    textContent: '✕',
    title: withHotkey(t('close'), 'Ctrl+W'),
    onclick: (e) => {
      e.stopPropagation();
      send('closeTab', tab.id);
    },
  }))));
  sortable([...$('tabs').children], 'x', (from, to) => send('moveTab', { id: state.tabs[from].id, to }));
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
  if (document.activeElement !== $('address')) $('address').value = nav?.url ?? '';
  const active = state.downloads.filter((d) => d.state === 'progressing');
  $('dl-badge').hidden = !active.length;
  $('dl-badge').textContent = active.length;
  // A progress line under the button for everything still downloading.
  const total = active.reduce((sum, d) => sum + d.total, 0);
  const received = active.reduce((sum, d) => sum + d.received, 0);
  $('downloads-btn').classList.toggle('busy', active.length > 0);
  $('downloads-btn').style.setProperty('--p', total ? received / total : 1);
}

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

const TITLES = { add: 'newService', settings: 'settings', downloads: 'downloads', extensions: 'extensions' };

function setView(next) {
  view = next;
  document.body.classList.toggle('panel-open', !!view);
  send('panel', !!view);
  rendered.view = null;
  renderPanel();
}

const toggleView = (next) => setView(view === next ? null : next);

function renderPanel() {
  $('panel').hidden = !view;
  if (!view || !changed('view', [view, state.services, state.presets, state.settings, state.downloads, state.extensions])) return;
  $('panel-title').textContent = t(TITLES[view]);
  for (const kind of Object.keys(TITLES)) $(`view-${kind}`).hidden = kind !== view;
  if (view === 'add') renderPresets();
  if (view === 'settings') renderSettings();
  if (view === 'downloads') renderDownloads();
  if (view === 'extensions') renderExtensions();
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

function renderSettings() {
  $('lang').value = lang;
  markSegment($('theme-seg'), state.settings.theme);
  markSegment($('unload-seg'), state.settings.unloadMinutes);
  $('notify').checked = state.settings.notify;
  $('service-rows').replaceChildren(...state.services.map((s) => el('div', {
    className: 'service-row' + (s.id === state.activeService ? ' current' : ''),
  },
  icon(s.icon, s.name, 'row-icon'),
  el('span', { className: 'row-name', textContent: s.name }),
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
  state = next;
  document.documentElement.dataset.theme = state.settings.theme;
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

on('cmd', (cmd) => {
  if (cmd === 'find') openFind();
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

$('add-btn').onclick = () => toggleView('add');
$('settings-btn').onclick = () => toggleView('settings');
$('downloads-btn').onclick = () => toggleView('downloads');
$('extensions-btn').onclick = () => toggleView('extensions');
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

$('address-form').onsubmit = (e) => {
  e.preventDefault();
  send('navigate', $('address').value);
  $('address').blur();
};
$('address').addEventListener('focus', () => requestAnimationFrame(() => $('address').select()));
$('address').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
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
