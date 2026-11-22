# Simpcity Search

Unpacked Chrome extension that adds a Simpcity search item to the selection context menu and provides a toolbar popup for entering or pasting a query.

## Install in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this `simpcity-search` folder.

Selecting text and opening its right-click menu shows **Vyhľadať na Simpcity: "..."**. Clicking the toolbar icon opens a small query form. Both actions open a new tab at `https://simpcity.cr/search/53345003/?q=...&o=relevance`.

Example: `Nick Morris` becomes `https://simpcity.cr/search/53345003/?searchform=1&q=Nick+Morris&o=relevance`.

The extension adds a temporary cache-busting parameter to the request so a previously displayed result document is not reused. The normal search parameters remain unchanged.
