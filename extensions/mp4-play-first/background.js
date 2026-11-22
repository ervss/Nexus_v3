importScripts('video-rules.js');
const DOWNLOAD_RULE_ID = 1001;
const DOWNLOAD_MIME_RULE_ID = 1002;
const HLS_RULE_IDS = [2001, 2002];
const HLS_DOWNLOAD_IDS = [1003, 1004];
async function getMode() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.some(rule => [2, DOWNLOAD_RULE_ID, DOWNLOAD_MIME_RULE_ID].includes(rule.id)) ? 'download' : 'play';
}
async function updateBadge(mode) {
  await chrome.action.setBadgeText({text: mode === 'download' ? 'DL' : '▶'});
  await chrome.action.setBadgeBackgroundColor({color: mode === 'download' ? '#b45309' : '#047857'});
}
async function setMode(mode) {
  if (!['play', 'download'].includes(mode)) throw new Error('Neplatný režim.');
  const downloadAction = {
    action: {type: 'modifyHeaders', responseHeaders: [
      {header: 'content-disposition', operation: 'set', value: 'attachment'}
    ]}
  };
  const redirectAction = {type: 'redirect', redirect: {regexSubstitution: chrome.runtime.getURL('player.html') + '#\\0'}};
  const addRules = mode === 'download' ? [
    {id: DOWNLOAD_RULE_ID, priority: 100, ...downloadAction, condition: {
      regexFilter: VIDEO_URL_PATTERN, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame']
    }},
    {id: DOWNLOAD_MIME_RULE_ID, priority: 100, ...downloadAction, condition: {
      urlFilter: '|http', responseHeaders: VIDEO_RESPONSE, resourceTypes: ['main_frame']
    }},
    {id: HLS_DOWNLOAD_IDS[0], priority: 100, ...downloadAction, condition: {
      regexFilter: HLS_URL_PATTERN, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame']
    }},
    {id: HLS_DOWNLOAD_IDS[1], priority: 100, ...downloadAction, condition: {
      urlFilter: '|http', responseHeaders: HLS_RESPONSE, resourceTypes: ['main_frame']
    }}
  ] : [
    {id: HLS_RULE_IDS[0], priority: 30, action: redirectAction, condition: {
      regexFilter: HLS_URL_PATTERN, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame']
    }},
    {id: HLS_RULE_IDS[1], priority: 30, action: redirectAction, condition: {
      regexFilter: '^https?://.*$', responseHeaders: HLS_RESPONSE, resourceTypes: ['main_frame']
    }}
  ];
  await chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds: [2, DOWNLOAD_RULE_ID, DOWNLOAD_MIME_RULE_ID, ...HLS_DOWNLOAD_IDS, ...HLS_RULE_IDS], addRules});
  await updateBadge(mode);
  return mode;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !['getMode', 'setMode'].includes(message.type)) return;
  (async () => {
    try {
      const mode = message.type === 'setMode' ? await setMode(message.mode) : await getMode();
      respond({ok: true, mode});
    } catch (error) { respond({ok: false, error: error.message}); }
  })();
  return true;
});
async function refreshBadge() {
  try { await updateBadge(await getMode()); } catch (error) { console.error(error); }
}
chrome.runtime.onInstalled.addListener(async () => {
  try { await setMode(await getMode()); } catch (error) { console.error(error); }
});
chrome.runtime.onStartup.addListener(async () => {
  try { await setMode(await getMode()); } catch (error) { console.error(error); }
});
