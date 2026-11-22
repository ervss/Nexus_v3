(() => {
  const form = document.getElementById('telegramDiscoveryForm');
  if (!form) return;
  const panel = document.getElementById('telegramDiscovery');
  const status = document.getElementById('telegramDiscoveryStatus');
  const counts = document.getElementById('telegramDiscoveryCounts');
  const log = document.getElementById('telegramDiscoveryLog');
  const button = form.querySelector('button');
  const resume = document.getElementById('telegramDiscoveryResume');
  const date = form.elements.date_from;
  const d = new Date(); d.setDate(d.getDate() - 30);
  date.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  let timer;
  async function refresh() {
    clearTimeout(timer);
    try {
      const response = await fetch('/api/telegram/discover/status');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      status.textContent = `${data.status || 'idle'} · ${data.current_action || 'Pripravené'}`;
      counts.textContent = `Nájdené: ${data.channels_found || 0} · Nové joiny: ${data.joined || 0} · Chyby: ${data.failed || 0} · Indexované videá: ${data.messages_indexed || 0}`;
      log.textContent = (data.log || []).join('\n');
      button.disabled = data.status === 'running';
      resume.hidden = data.status !== 'failed';
      if (data.status === 'running') timer = setTimeout(refresh, 2000);
    } catch (e) { status.textContent = `Stav sa nepodarilo načítať: ${e.message}`; timer = setTimeout(refresh, 10000); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true;
    const data = new FormData(form);
    const payload = {keywords: data.get('keywords').trim(), date_from: data.get('date_from'), max_joins: Number(data.get('max_joins')), delay: Number(data.get('delay')), manual_channels: data.get('manual_channels').split(/[\n,]+/).map(s => s.trim()).filter(Boolean)};
    try {
      const response = await fetch('/api/telegram/discover', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `HTTP ${response.status}`);
      await refresh();
    } catch (e) { status.textContent = e.message; button.disabled = false; }
  });
  resume.addEventListener('click', async () => {
    resume.disabled = true;
    try {
      const response = await fetch('/api/telegram/discover', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({resume:true, date_from:date.value})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || `HTTP ${response.status}`);
      await refresh();
    } catch (e) { status.textContent = e.message; }
    finally { resume.disabled = false; }
  });
  panel.addEventListener('toggle', () => { if (panel.open) refresh(); });
  refresh();
})();
