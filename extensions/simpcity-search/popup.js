const form = document.getElementById('search-form');
const input = document.getElementById('query');
const status = document.getElementById('status');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) {
    status.textContent = 'Zadaj hľadaný výraz.';
    input.focus();
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({ type: 'SEARCH_SIMPCITY', query });
    if (!result?.ok) throw new Error(result?.error || 'Vyhľadávanie sa nepodarilo spustiť.');
    window.close();
  } catch (error) {
    status.textContent = error.message || 'Vyhľadávanie sa nepodarilo spustiť.';
  }
});
