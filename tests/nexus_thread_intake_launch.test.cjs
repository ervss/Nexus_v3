const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const extensionRoot = "extensions/nexus_thread_intake";
const manifest = JSON.parse(fs.readFileSync(`${extensionRoot}/manifest.json`, "utf8"));
assert.ok(manifest.host_permissions.includes("https://*.simpcity.cr/*"));
assert.ok(manifest.content_scripts.some(script => script.matches.includes("https://*.simpcity.cr/*")));

function runContentScript(href) {
  let button;
  let sentMessage;
  const document = {
    documentElement: { appendChild: element => { button = element; } },
    getElementById: () => null,
    createElement: () => ({
      style: {},
      setAttribute() {},
      addEventListener: (_event, handler) => { buttonHandler = handler; },
    }),
  };
  let buttonHandler;
  const context = {
    document,
    window: { location: { href } },
    URL,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage(message, callback) {
          sentMessage = message;
          callback({ ok: true });
        },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(`${extensionRoot}/content.js`, "utf8"), context);
  return { get button() { return button; }, click: () => buttonHandler(), get sentMessage() { return sentMessage; } };
}

function scrapeLinks(urls) {
  const anchor = url => ({
    textContent: url,
    closest: () => null,
    getAttribute: name => name === "href" ? url : null,
  });
  const body = {
    innerText: urls.join("\n"),
    querySelectorAll: () => urls.map(anchor),
  };
  const doc = {
    body,
    getElementById: () => null,
    documentElement: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }),
    querySelector: () => null,
    querySelectorAll: selector => selector.startsWith("article.message") ? [post] : [],
  };
  const post = {
    id: "post-123",
    getAttribute: () => null,
    querySelector: selector => selector.includes("message-body") ? body : null,
  };
  let onMessage;
  const context = {
    document: doc,
    window: { location: { href: "https://simpcity.cr/threads/example.123/" } },
    URL,
    chrome: { runtime: { onMessage: { addListener: listener => { onMessage = listener; } } } },
  };
  vm.runInNewContext(fs.readFileSync(`${extensionRoot}/content.js`, "utf8"), context);

  let result;
  onMessage({ action: "nexusThreadIntake.scrapeCurrent" }, {}, response => { result = response; });
  assert.equal(result?.ok, true, result?.error || "Thread intake did not respond to the scrape request");
  return Array.from(result.data.posts.flatMap(item => item.links.map(link => link.url)));
}

const forum = runContentScript("https://simpcity.cr/threads/example.123/page-2");
assert.equal(forum.button.textContent, "T");
assert.equal(forum.button.style.position, "fixed");
forum.click();
assert.equal(forum.sentMessage.action, "nexusThreadIntake.openDashboard");

const nonThreadPage = runContentScript("https://simpcity.cr/forums/general.1/");
assert.equal(nonThreadPage.button, undefined);

const scraped = scrapeLinks([
  "https://turbo.cr/v/video123",
  "https://cdn.example/video.mp4?token=abc",
  "https://pixeldrain.com/u/knownfile",
  "https://goonbox.example/watch/123",
  "https://images.example/picture.jpg",
]);
assert.deepEqual(scraped, [
  "https://turbo.cr/v/video123",
  "https://cdn.example/video.mp4?token=abc",
  "https://pixeldrain.com/u/knownfile",
]);

const dashboard = fs.readFileSync(`${extensionRoot}/dashboard.js`, "utf8");
assert.match(dashboard, /const AUTO_SCAN_PAGE_LIMIT = 3/);
assert.match(dashboard, /Math\.min\(Number\(\$\("#toPage"\)\.value\).*state\.pagination\.totalPages/);
assert.match(dashboard, /const autoImport = state\.auto \? "&autoimport=1" : ""/);
assert.match(dashboard, /autostart=1&autoselect=1\$\{autoImport\}/);

const tester = fs.readFileSync("app/templates/tester.html", "utf8");
assert.match(tester, /hunterAutoImport = params\.get\('autoimport'\) === '1'/);
assert.match(tester, /if \(hunterAutoImport && selectedResultUrls\.size\)/);
assert.match(tester, /await runFetchMeta\(collectSelectedMetaTargets\(\), fetchMetaBtn, false\)/);
assert.match(tester, /return runImport\(hunterThreadTitle\)/);
assert.match(tester, /const previewStream = data\.stream_url \|\| batchMeta\.stream_url \|\| ''/);

const frameStart = tester.indexOf("        function streamFrameUrl(streamUrl)");
const frameEnd = tester.indexOf("\n        function ", frameStart + 1);
const frameContext = {};
vm.createContext(frameContext);
vm.runInContext(tester.slice(frameStart, frameEnd), frameContext);
assert.match(frameContext.streamFrameUrl("https://cdn1.turbocdn.st/video.mp4?token=x"), /^\/api\/tester\/frame\?/);
assert.match(frameContext.streamFrameUrl("https://cdn.example/video.mp4"), /^\/api\/tester\/stream-frame\?/);

console.log("Thread T filtering, three-page scan, automatic import, and Turbo preview contracts passed.");
