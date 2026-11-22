const statusEl = document.getElementById("status");
const btn = document.getElementById("save");

function status(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + type;
}

function toFileUrl(path) {
  // Windows cesta → file:// URL
  let p = path.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;
  // Encode medzery, #, ?, atď.
  p = p.split("/").map(seg => encodeURIComponent(seg)).join("/");
  return "file://" + p;
}

// Niektoré weby (napr. sme.sk) vykresľujú zvyšok článku až pri scrollovaní.
// Pred uložením preto postupne prescrollujeme koniec článku a počkáme,
// kým sa obsah prestane meniť. Potom vrátime pôvodnú pozíciu.
async function expandPage(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const root = document.scrollingElement || document.documentElement;
      const startY = window.scrollY;

      function articleElement() {
        const candidates = [
          ...document.querySelectorAll('[itemprop="articleBody"], article')
        ];
        if (!candidates.length) return null;
        return candidates.reduce((best, el) =>
          (el.innerText || "").length > (best.innerText || "").length ? el : best
        );
      }

      function targetBottom() {
        const article = articleElement();
        if (article) {
          const rect = article.getBoundingClientRect();
          return window.scrollY + rect.bottom + window.innerHeight;
        }
        return root.scrollHeight;
      }

      const deadline = Date.now() + 12000;
      let y = window.scrollY;
      let lastSignature = "";
      let stable = 0;

      while (Date.now() < deadline) {
        const bottom = targetBottom();
        if (y < bottom - window.innerHeight) {
          y += Math.max(300, window.innerHeight * 0.7);
          window.scrollTo(0, y);
          await sleep(120);
          continue;
        }
        // Sme na konci článku – čakáme, či sa ešte niečo nedokreslí.
        await sleep(400);
        const article = articleElement();
        const signature = `${root.scrollHeight}:${article ? (article.innerText || "").length : 0}`;
        if (signature === lastSignature) {
          if (++stable >= 3) break;
        } else {
          stable = 0;
          lastSignature = signature;
        }
      }

      window.scrollTo(0, startY);
      await sleep(200);
    }
  });
}

async function readCurrentPage(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const MAX_HTML_BYTES = 7 * 1024 * 1024;
      const encoder = new TextEncoder();

      function clean(root) {
        const copy = root.cloneNode(true);

        // V tele článku odkry skrytý obsah: <template> prevedieme na <div>
        // a odstránime atribúty, ktoré text skrývajú (inak by sa zahodil).
        copy.querySelectorAll('[itemprop="articleBody"], article').forEach((article) => {
          article.querySelectorAll("template").forEach((template) => {
            const div = document.createElement("div");
            div.append(template.content.cloneNode(true));
            template.replaceWith(div);
          });
          article.querySelectorAll("[hidden], [aria-hidden]").forEach((element) => {
            element.removeAttribute("hidden");
            element.removeAttribute("aria-hidden");
          });
        });

        copy.querySelectorAll([
          "script",
          "style",
          "noscript",
          "template",
          "iframe",
          "object",
          "embed",
          "canvas",
          "svg",
          "video",
          "audio",
          "source",
          'link[rel~="stylesheet"]',
          'link[rel="preload"]',
          'link[rel="modulepreload"]'
        ].join(",")).forEach((element) => element.remove());

        copy.querySelectorAll("*").forEach((element) => {
          for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            if (
              name.startsWith("on") ||
              name.startsWith("data-") ||
              name === "style" ||
              name === "srcset" ||
              name === "integrity" ||
              name === "nonce"
            ) {
              element.removeAttribute(attribute.name);
            }
          }
        });

        return copy;
      }

      function documentHtml(content) {
        const title = document.title
          ? `<title>${document.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</title>`
          : "";
        const metadata = [...document.head.querySelectorAll([
          'meta[name="author"]',
          'meta[name="description"]',
          'meta[property^="og:"]',
          'meta[name^="twitter:"]',
          'link[rel="canonical"]'
        ].join(","))].map((element) => element.outerHTML).join("");
        return `<!doctype html><html><head><meta charset="utf-8">${title}${metadata}</head><body>${content}</body></html>`;
      }

      const cleanedDocument = clean(document.documentElement);
      let html = "<!doctype html>" + cleanedDocument.outerHTML;

      if (encoder.encode(html).length > MAX_HTML_BYTES) {
        const focusedContent = document.querySelector("article, main, [role='main']");
        if (!focusedContent) {
          throw new Error("Stránka je priveľká a hlavný obsah sa nepodarilo nájsť.");
        }
        html = documentHtml(clean(focusedContent).outerHTML);
      }

      if (encoder.encode(html).length > MAX_HTML_BYTES) {
        throw new Error("Obsah článku je priveľký na spracovanie (>7 MB).");
      }

      return { html, url: location.href };
    }
  });

  const page = result?.result;
  if (!page?.html || !page?.url) {
    throw new Error("Obsah otvorenej stránky sa nepodarilo načítať.");
  }
  return page;
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  status("Sťahujem a spracúvam článok…");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:\/\//i.test(tab.url || "")) {
      throw new Error("Otvor webový článok (http/https).");
    }

    status("Načítavam celý článok…");
    try {
      await expandPage(tab.id);
    } catch (_) {
      // Ak scrollovanie zlyhá, pokračujeme s tým, čo je už načítané.
    }

    status("Sťahujem a spracúvam článok…");
    const page = await readCurrentPage(tab.id);

    const result = await chrome.runtime.sendMessage({
      action: "save_article",
      url: page.url,
      html: page.html
    });

    if (!result || result.error) {
      throw new Error(result?.error || "Host neodpovedá.");
    }

    const openPath = result.html_path || result.md_path || result.path;
    const paywallNote = result.paywall
      ? " ⚠ Článok je za paywallom – uložená je len voľne dostupná časť. Pre celý text sa prihlás s predplatným."
      : "";
    status("Uložené: " + openPath + paywallNote, result.paywall ? "err" : "ok");

    // Skús otvoriť v novom tabe
    try {
      const fileUrl = toFileUrl(openPath);
      const newTab = await chrome.tabs.create({ url: fileUrl });
      // Ak Chrome zablokuje file:// (nedá sa), tab sa otvorí prázdny.
      // Skontroluj po 500ms, či URL sedí.
      setTimeout(async () => {
        try {
          const t = await chrome.tabs.get(newTab.id);
          if (!t.url.startsWith("file://")) {
            // Fallback — zobraz cestu
            status("Uložené. Otvor manuálne: " + openPath, "ok");
          }
        } catch (_) {}
      }, 500);
    } catch (e) {
      status("Uložené. Otvor manuálne: " + openPath, "ok");
    }

    // Nechaj tlačidlo disabled — človek už klikol, netreba znova
  } catch (e) {
    status("Chyba: " + e.message, "err");
    btn.disabled = false;
  }
});
