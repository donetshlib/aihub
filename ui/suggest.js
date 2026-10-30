// Shows the suggestions main.js sends; a press on one picks it. The keyboard stays in the
// address bar of the main window.
const { send, on } = window.hub;

on('suggestions', ({ list, selected, theme, lang }) => {
  document.documentElement.dataset.theme = theme;
  const tags = { tab: (s) => `${translate(lang, 'openTab')} · ${s.service}`, bookmark: () => '★', history: () => '' };
  document.getElementById('suggest-list').replaceChildren(...list.map((s, i) => {
    const row = document.createElement('div');
    row.className = 'suggestion' + (i === selected ? ' selected' : '');
    // mousedown: on click the address bar has already lost the focus and hidden this list.
    row.onmousedown = () => send('pickSuggestion', i);
    const img = Object.assign(document.createElement('img'), {
      src: s.favicon || `https://www.google.com/s2/favicons?domain=${URL.parse(s.url)?.hostname}&sz=32`,
      alt: '',
      onerror: (e) => (e.target.style.visibility = 'hidden'),
    });
    const text = document.createElement('div');
    text.className = 'suggestion-text';
    text.append(
      Object.assign(document.createElement('span'), { className: 'suggestion-title', textContent: s.title }),
      Object.assign(document.createElement('span'), { className: 'suggestion-url', textContent: s.url }),
    );
    const tag = Object.assign(document.createElement('span'), { className: 'suggestion-tag', textContent: tags[s.type](s) });
    row.append(img, text, tag);
    return row;
  }));
});
