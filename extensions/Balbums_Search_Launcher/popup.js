const form = document.getElementById('search-form');
const keywordInput = document.getElementById('keyword');
const LAST_KEYWORD = 'balbums_last_keyword';

chrome.storage.local.get(LAST_KEYWORD).then((saved) => {
  keywordInput.value = saved[LAST_KEYWORD] || '';
  keywordInput.focus();
}).catch(() => keywordInput.focus());

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const keyword = keywordInput.value.trim();
  if (!keyword) return;

  const params = new URLSearchParams({
    search: keyword,
    mode: 'broad',
    per: '100',
    sort: 'latest'
  });

  await chrome.storage.local.set({ [LAST_KEYWORD]: keyword });
  await chrome.tabs.create({
    url: `https://balbums.st/?${params.toString()}`,
    active: true
  });
  window.close();
});
