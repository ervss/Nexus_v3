const byId = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('#tabs button')];
let current = 'torrents', payload = { results: [], diagnostics: [] };
const selected = new Set();

function status(text) { byId('status').textContent = text; }
function fmtSize(n) { return n > 0 ? `${(n / 1073741824).toFixed(2)} GB` : ''; }
function fmtDuration(n) { return n > 0 ? `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}` : ''; }
function shown() { return payload.results.filter(row => row.category === current); }
function meta(row) {
  return [row.source, fmtSize(row.size), row.seeds ? `${row.seeds} seeds` : '', fmtDuration(row.duration), row.date ? row.date.slice(0, 10) : ''].filter(Boolean).join(' · ');
}
function button(label, fn) { const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.addEventListener('click', fn); return el; }
function updateAdd() { byId('add-selected').disabled = !selected.size; byId('select-all').checked = shown().length > 0 && shown().every(row => selected.has(row.id)); }

function card(row) {
  const wrap = document.createElement('article'); wrap.className = 'card';
  const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'pick'; check.checked = selected.has(row.id);
  check.addEventListener('change', () => { check.checked ? selected.add(row.id) : selected.delete(row.id); updateAdd(); });
  wrap.append(check);
  if (row.thumbnail) { const img = document.createElement('img'); img.src = row.thumbnail; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.addEventListener('error', () => img.replaceWith(placeholder())); wrap.append(img); }
  else wrap.append(placeholder());
  const body = document.createElement('div'); body.className = 'card-body';
  const title = document.createElement('div'); title.className = 'title'; title.textContent = row.title; body.append(title);
  const info = document.createElement('div'); info.className = 'meta'; info.textContent = meta(row); body.append(info);
  const actions = document.createElement('div'); actions.className = 'actions';
  actions.append(button('Open', () => chrome.tabs.create({ url: row.url })));
  actions.append(button('Add to Nexus', async () => {
    try { status('Pridávam…'); const result = await chrome.runtime.sendMessage({ type: 'ADD_SELECTED', items: [row] }); status(result.ok ? result.data.join(' · ') : result.error); }
    catch (error) { status(error.message); }
  }));
  actions.append(button('Download', async () => {
    try { const result = await chrome.runtime.sendMessage({ type: 'DOWNLOAD', item: row }); status(result.ok ? result.data : result.error); }
    catch (error) { status(error.message); }
  }));
  body.append(actions); wrap.append(body); return wrap;
}
function placeholder() { const el = document.createElement('div'); el.className = 'thumb'; el.textContent = 'NEXUS'; return el; }
function render() {
  for (const tab of tabs) {
    tab.classList.toggle('active', tab.dataset.tab === current);
    tab.querySelector('b').textContent = tab.dataset.tab === 'metadata' ? payload.diagnostics.length : payload.results.filter(row => row.category === tab.dataset.tab).length;
  }
  const root = byId('results'); root.replaceChildren();
  if (current === 'metadata') {
    for (const item of payload.diagnostics) { const row = document.createElement('div'); row.className = 'diagnostic'; const name = document.createElement('strong'); name.textContent = item.source; row.append(name, document.createTextNode(` · ${item.count} výsledkov${item.error ? ` · ${item.error}` : ''}`)); if (item.error) row.classList.add('error'); root.append(row); }
    if (!payload.diagnostics.length) root.append(empty('Spusti vyhľadávanie pre diagnostiku zdrojov.'));
  } else if (current === 'forums') root.append(empty('Vyhľadávanie súkromných únikov a fór s obsahom bez súhlasu nie je podporované.'));
  else if (!shown().length) root.append(empty('Žiadne výsledky v tejto kategórii. Pozri Metadata pre stav zdrojov.'));
  else root.append(...shown().map(card));
  updateAdd();
}
function empty(message) { const el = document.createElement('div'); el.className = 'empty'; el.textContent = message; return el; }

byId('search-form').addEventListener('submit', async event => {
  event.preventDefault(); const query = byId('query').value.trim();
  status('Vyhľadávam zdroje…'); byId('search-form').querySelector('button').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SEARCH', query });
    if (!response.ok) throw Error(response.error);
    payload = response.data; selected.clear();
    status(`${payload.results.length} výsledkov · ${payload.cached ? 'cache' : 'nové hľadanie'} · ${payload.diagnostics.filter(d => d.error).length} chýb`);
    if (!shown().length) current = payload.results.find(row => row.category === 'tubes') ? 'tubes' : payload.results[0]?.category || 'metadata';
    render();
  } catch (error) { status(error.message); }
  finally { byId('search-form').querySelector('button').disabled = false; }
});
tabs.forEach(tab => tab.addEventListener('click', () => { current = tab.dataset.tab; render(); }));
byId('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
byId('select-all').addEventListener('change', event => { for (const row of shown()) event.target.checked ? selected.add(row.id) : selected.delete(row.id); render(); });
byId('add-selected').addEventListener('click', async () => {
  const items = payload.results.filter(row => selected.has(row.id)); status(`Pridávam ${items.length} položiek…`);
  try { const result = await chrome.runtime.sendMessage({ type: 'ADD_SELECTED', items }); status(result.ok ? result.data.join(' · ') : result.error); }
  catch (error) { status(error.message); }
});
(async () => { const data = await chrome.storage.local.get(['lastSearch', 'lastQuery']); if (data.lastSearch) payload = data.lastSearch; byId('query').value = data.lastQuery || payload.query || ''; render(); })();
byId('query').addEventListener('change', () => chrome.storage.local.set({ lastQuery: byId('query').value }));
