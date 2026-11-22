(() => {
    const hostname = location.hostname.toLowerCase();
    if (!/(^|\.)bunkr\.(?:pk|cr|ph|si|ac|ru|black|media|site|red|is|la|ws|fi|ps|sk|ci)$|(^|\.)bunkrr\.pics$/.test(hostname)) return;
    if (!/^\/(?:f|v|d)\//i.test(location.pathname)) return;

    function isAdLink(anchor) {
        try {
            const host = new URL(anchor.href, location.href).hostname.toLowerCase();
            return host === 'fh-dxy.com' || host.endsWith('.fh-dxy.com');
        } catch {
            return false;
        }
    }

    function removeAdCreative(anchor) {
        if (!isAdLink(anchor) || anchor.closest('.nexus-import-overlay')) return;
        if (anchor.querySelector('img, picture') && !anchor.querySelector('video, audio, iframe')) {
            anchor.remove();
        }
    }

    document.addEventListener('click', event => {
        const anchor = event.composedPath().find(node =>
            node instanceof HTMLAnchorElement && isAdLink(node)
        );
        if (!anchor) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        removeAdCreative(anchor);
    }, true);

    const scan = (root) => {
        if (root instanceof HTMLAnchorElement) removeAdCreative(root);
        root.querySelectorAll?.('a[href]').forEach(removeAdCreative);
    };

    scan(document);
    new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') {
                const anchor = record.target.closest('a[href]');
                if (anchor) removeAdCreative(anchor);
                continue;
            }
            record.addedNodes.forEach(node => {
                if (node instanceof Element) scan(node);
            });
        }
    }).observe(document, {
        attributes: true,
        attributeFilter: ['href'],
        childList: true,
        subtree: true,
    });
})();
