const select = document.getElementById('mode');
const status = document.getElementById('status');
document.getElementById('open-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const url = new URL(document.getElementById('source').value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Použi HTTP alebo HTTPS odkaz.');
    await chrome.tabs.create({url: chrome.runtime.getURL('player.html') + '#' + url.href});
  } catch (error) { status.textContent = error.message; }
});
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Rozšírenie neodpovedá.');
  select.value = response.mode;
  status.textContent = response.mode === 'play' ? 'Aktívne: prehrávanie' : 'Aktívne: sťahovanie';
}
select.addEventListener('change', async () => {
  select.disabled = true;
  try { await request({type: 'setMode', mode: select.value}); }
  catch (error) { status.textContent = error.message; }
  finally { select.disabled = false; }
});
(async () => {
  try { await request({type: 'getMode'}); select.disabled = false; }
  catch (error) { status.textContent = error.message; }
})();
