document.getElementById('otvoritPrehravac').addEventListener('click', () => {
    chrome.tabs.create({ url: 'player.html' });
});
