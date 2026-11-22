const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const extensionRoot = "extensions/nexus_thread_intake";
const manifest = JSON.parse(fs.readFileSync(`${extensionRoot}/manifest.json`, "utf8"));

// 1. Overenie manifest match patterns
const searchScript = manifest.content_scripts.find(s => s.js.includes("search.js"));
assert.ok(searchScript, "search.js musí byť uvedený v content_scripts");
assert.ok(searchScript.matches.includes("https://*.simpcity.cr/tags/*"), "manifest.json musí matchovať https://*.simpcity.cr/tags/*");
assert.ok(searchScript.matches.includes("https://*.simpcity.cr/search/*"), "manifest.json musí matchovať https://*.simpcity.cr/search/*");
assert.ok(searchScript.matches.includes("https://*.simpcity.cr/watched/threads*"), "manifest.json musí matchovať https://*.simpcity.cr/watched/threads*");
assert.ok(searchScript.matches.includes("https://*.simpcity.cr/forums/*"), "manifest.json musí matchovať https://*.simpcity.cr/forums/*");

// 2. Overenie spustenia search.js na https://simpcity.cr/tags/bimbo/
function createSearchEnv(href) {
  class MockElement {
    constructor(tagName, text = "", className = "") {
      this.tagName = tagName.toUpperCase();
      this.textContent = text;
      this.className = className;
      this.children = [];
      this.classList = {
        add: (cls) => { if (!this.className.includes(cls)) this.className = `${this.className} ${cls}`.trim(); },
        remove: (cls) => { this.className = this.className.replace(cls, "").trim(); },
        toggle: (cls, force) => {
          if (force) this.classList.add(cls);
          else this.classList.remove(cls);
        },
        contains: (cls) => this.className.includes(cls),
      };
      this.attributes = {};
      this.parentElement = null;
      this.hidden = false;
      this.style = {};
      this.dataset = {};
      this.value = "";
      this.checked = false;
      this._innerHTML = "";
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] || null; }
    append(...children) {
      for (const ch of children) {
        if (ch) {
          ch.parentElement = this;
          this.children.push(ch);
        }
      }
    }
    prepend(...children) {
      for (const ch of [...children].reverse()) {
        if (ch) {
          ch.parentElement = this;
          this.children.unshift(ch);
        }
      }
    }
    after(el) {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        el.parentElement = this.parentElement;
        this.parentElement.children.splice(idx + 1, 0, el);
      }
    }
    set innerHTML(val) {
      this._innerHTML = val;
      // Vytvoríme mock elementy pre všetky data-f, data-part, data-a
      const regex = /<(input|select|button|b|span|small|pre)[^>]*?(data-(?:f|part|a)="([^"]+)")/gi;
      let match;
      while ((match = regex.exec(val)) !== null) {
        const tag = match[1];
        const attrType = match[2].split("=")[0];
        const attrVal = match[3];
        const child = new MockElement(tag);
        if (attrType === "data-f") child.dataset.f = attrVal;
        if (attrType === "data-part") child.dataset.part = attrVal;
        if (attrType === "data-a") child.dataset.a = attrVal;
        if (val.includes(`data-f="${attrVal}"`) && val.includes("checked")) child.checked = true;
        this.append(child);
      }
    }
    get innerHTML() { return this._innerHTML; }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const res = [];
      const mF = sel.match(/^\[data-f="([^"]+)"\]$/);
      const mPart = sel.match(/^\[data-part="([^"]+)"\]$/);
      const mA = sel.match(/^\[data-a="([^"]+)"\]$/);

      const check = (node) => {
        if (!node || typeof node !== "object") return;
        const classes = (node.className || "").split(/\s+/);
        if (mF && node.dataset?.f === mF[1]) res.push(node);
        else if (mPart && node.dataset?.part === mPart[1]) res.push(node);
        else if (mA && node.dataset?.a === mA[1]) res.push(node);
        else if (sel === "[data-f]" && node.dataset?.f) res.push(node);
        else if (sel === ".structItem--thread" && classes.includes("structItem--thread")) res.push(node);
        else if (sel.includes(".structItem-title") && classes.includes("structItem-title")) res.push(node);
        else if (sel.includes("a[href*=\"/threads/\"]") && node.tagName === "A" && (node.getAttribute("href") || "").includes("/threads/")) res.push(node);
        for (const child of node.children || []) check(child);
      };
      for (const child of this.children || []) check(child);
      return res;
    }
    addEventListener() {}
    cloneNode(deep) {
      const copy = new MockElement(this.tagName, this.textContent, this.className);
      copy.attributes = { ...this.attributes };
      copy.dataset = { ...this.dataset };
      if (deep) {
        copy.children = this.children.map(c => c.cloneNode?.(true) || c);
      }
      return copy;
    }
    replaceChildren(...newChildren) {
      this.children = [];
      this.append(...newChildren);
    }
  }

  const body = new MockElement("BODY");
  const docElement = new MockElement("HTML");
  docElement.append(body);

  const doc = {
    body,
    documentElement: docElement,
    createElement: (tag) => new MockElement(tag),
    importNode: (node) => node,
    title: "Bimbo Threads | SimpCity",
    querySelector: (sel) => body.querySelector(sel) || docElement.querySelector(sel),
    querySelectorAll: (sel) => [...body.querySelectorAll(sel), ...docElement.querySelectorAll(sel)],
  };

  // Vytvoríme mock structItem v body pre tag zoznam
  const threadRow = new MockElement("DIV", "", "structItem structItem--thread");
  const threadTitle = new MockElement("DIV", "", "structItem-title");
  const titleLink = new MockElement("A", "Sample Bimbo Thread", "");
  titleLink.setAttribute("href", "/threads/sample-bimbo-model.12345/");
  threadTitle.append(titleLink);
  threadRow.append(threadTitle);
  body.append(threadRow);

  const context = {
    location: { href },
    document: doc,
    window: {
      location: { href },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    URL,
    DOMParser: class {
      parseFromString() { return doc; }
    },
    Option: class {
      constructor(text, val) { this.text = text; this.value = val; }
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => ({}),
          remove: async () => ({}),
        },
      },
      runtime: {
        sendMessage: async () => ({ ok: true, count: 1 }),
      },
    },
    globalThis: {
      __nexusThreadIntakeScrapeDocument: () => ({ posts: [] }),
    },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    AbortController,
    DOMException,
  };

  const scriptCode = fs.readFileSync(`${extensionRoot}/search.js`, "utf8");
  vm.runInNewContext(scriptCode, context);

  return { context, doc, body };
}

// Otestovanie tag URL
const tagEnv = createSearchEnv("https://simpcity.cr/tags/bimbo/");
assert.ok(tagEnv.context.globalThis.__nexusSearchInstalled, "search.js sa musí úspešne nainštalovať na https://simpcity.cr/tags/bimbo/");

// Overenie, že sa vytvoril Nexus Search trigger button
const trigger = tagEnv.body.children.find(c => (c.className || "").includes("nti-s-trigger"));
assert.ok(trigger, "Tlačidlo 'Nexus Search' (.nti-s-trigger) musí byť prítomné na stránke tagov");
assert.equal(trigger.textContent, "Nexus Search");

// Overenie, že sa vytvoril panel
const panel = tagEnv.body.children.find(c => (c.className || "").includes("nti-s-panel"));
assert.ok(panel, "Panel (.nti-s-panel) musí byť pripojený do body");
assert.ok(panel.querySelector('[data-f="thread"]'), "Panel musí obsahovať filter threadov [data-f='thread']");

const bgCode = fs.readFileSync(`${extensionRoot}/background.js`, "utf8");
assert.match(bgCode, /watched\\\/threads\|search\|tags\|forums\|threads/, "background.js musí povoliť odoslanie aj z /tags/, /forums/ a /threads/");

const searchCode = fs.readFileSync(`${extensionRoot}/search.js`, "utf8");
assert.match(searchCode, /threads,\s*\n\s*title:/, "search.js musí posielať aj zoznam threadov do background.js");

console.log("Nexus Search tag URL and manifest contract tests passed successfully!");
