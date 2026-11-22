(function () {
    'use strict';

    if (window.top !== window) return;
    if (!/(^|\.)fapfolder\.club$/i.test(location.hostname)) return;
    if (location.pathname !== '/') return;

    const MENU_STORAGE_KEY = 'nexus_ff_feed_menu_open';
    const VIDEO_FILTER_STORAGE_KEY = 'nexus_ff_feed_videos_only';
    const GRID_COLUMNS_STORAGE_KEY = 'nexus_ff_feed_columns';
    const GRID_COLUMN_OPTIONS = ['4', '5', '6'];
    const MENU_OPEN_CLASS = 'nexus-ff-feed-menu-open';
    const VIDEO_FILTER_CLASS = 'nexus-ff-feed-video-only';
    const VIDEO_POST_CLASS = 'nexus-ff-feed-has-video';
    const PHOTO_POST_CLASS = 'nexus-ff-feed-no-video';

    function enableGallery() {
        const root = document.documentElement;
        if (!root) return false;
        root.classList.add('nexus-ff-feed-gallery');
        let columns = '4';
        try {
            if (localStorage.getItem(MENU_STORAGE_KEY) === 'true') root.classList.add(MENU_OPEN_CLASS);
            if (localStorage.getItem(VIDEO_FILTER_STORAGE_KEY) === 'true') root.classList.add(VIDEO_FILTER_CLASS);
            const storedColumns = localStorage.getItem(GRID_COLUMNS_STORAGE_KEY);
            if (GRID_COLUMN_OPTIONS.includes(storedColumns)) columns = storedColumns;
        } catch {}
        root.setAttribute('data-nexus-ff-feed-columns', columns);
        return true;
    }

    if (!enableGallery()) {
        const handleReadyState = () => {
            if (enableGallery()) document.removeEventListener('readystatechange', handleReadyState);
        };
        document.addEventListener('readystatechange', handleReadyState);
    }

    function refreshFeedLayout() {
        window.dispatchEvent(new Event('resize'));
    }

    function classifyFeedPosts(scope = document) {
        const posts = [];
        if (scope.matches?.('.post')) posts.push(scope);
        scope.querySelectorAll?.('.js_posts_stream .post').forEach((post) => posts.push(post));

        for (const post of posts) {
            if (post.classList?.contains?.('nexus-ff-community')) {
                post.classList.remove('nexus-ff-community');
                post.querySelector?.('.nexus-ff-community-cover')?.remove?.();
                post.querySelector?.('.nexus-ff-community-handle')?.remove?.();
                post.querySelector?.('.nexus-ff-community-stats')?.remove?.();
                post.querySelector?.('.nexus-ff-community-footer')?.remove?.();
                const original = post.querySelector('.nexus-ff-community-original');
                if (original) {
                    while (original.firstChild) post.insertBefore(original.firstChild, original);
                    original.remove();
                }
            }
            post.querySelector?.('.nexus-ff-date')?.remove?.();
            const postTime = post.querySelector('.post-time')?.textContent || '';
            const hasVideo = /\badded\s+video\b/i.test(postTime)
                || !!post.querySelector('video, .video-auth-placeholder-thumb, .vid-placeholder');
            const item = post.closest('li') || post;
            item.classList.toggle(VIDEO_POST_CLASS, hasVideo);
            item.classList.toggle(PHOTO_POST_CLASS, !hasVideo);
        }
    }

    function createControls() {
        if (document.getElementById('nexus-ff-feed-controls')) return;
        const root = document.documentElement;
        if (!root) return;

        const scrim = document.createElement('div');
        scrim.className = 'nexus-ff-feed-menu-scrim';
        scrim.setAttribute('aria-hidden', 'true');
        document.body.appendChild(scrim);

        const controls = document.createElement('div');
        controls.id = 'nexus-ff-feed-controls';
        controls.className = 'nexus-ff-feed-controls';

        const menuButton = document.createElement('button');
        menuButton.type = 'button';
        menuButton.className = 'nexus-ff-feed-control';
        menuButton.textContent = '☰ Menu';
        menuButton.setAttribute('aria-controls', 'nexus-ff-feed-menu');

        const filterButton = document.createElement('button');
        filterButton.type = 'button';
        filterButton.className = 'nexus-ff-feed-control nexus-ff-feed-filter';
        filterButton.textContent = '🎞 Len videá';
        filterButton.title = 'Zobraziť iba video-príspevky';
        filterButton.setAttribute('aria-label', 'Zobraziť iba video-príspevky');

        const fetchButton = document.createElement('button');
        fetchButton.type = 'button';
        fetchButton.className = 'nexus-ff-feed-control nexus-ff-feed-fetch';
        fetchButton.textContent = '⚡ Fetch visible';
        fetchButton.title = 'Zistiť údaje o načítaných video-príspevkoch';

        const layoutSelect = document.createElement('select');
        layoutSelect.className = 'nexus-ff-feed-control nexus-ff-feed-layout';
        layoutSelect.setAttribute('aria-label', 'Počet stĺpcov v galérii');
        layoutSelect.title = 'Hustota galérie; feed pokračuje nadol';
        for (const columns of GRID_COLUMN_OPTIONS) {
            const option = document.createElement('option');
            option.value = columns;
            option.textContent = `${columns} stĺpcov`;
            layoutSelect.append(option);
        }

        const sidebar = document.querySelector('.offcanvas-sidebar');
        if (sidebar) {
            sidebar.id = 'nexus-ff-feed-menu';
            sidebar.setAttribute('aria-label', 'Hlavné menu');
        }

        const setMenuOpen = (open) => {
            root.classList.toggle(MENU_OPEN_CLASS, open);
            menuButton.setAttribute('aria-expanded', String(open));
            try { localStorage.setItem(MENU_STORAGE_KEY, String(open)); } catch {}
        };

        const setVideoFilter = (enabled) => {
            root.classList.toggle(VIDEO_FILTER_CLASS, enabled);
            filterButton.setAttribute('aria-pressed', String(enabled));
            filterButton.classList.toggle('active', enabled);
            try { localStorage.setItem(VIDEO_FILTER_STORAGE_KEY, String(enabled)); } catch {}
        };

        const setGridColumns = (columns) => {
            if (!GRID_COLUMN_OPTIONS.includes(columns)) return;
            root.setAttribute('data-nexus-ff-feed-columns', columns);
            layoutSelect.value = columns;
            try { localStorage.setItem(GRID_COLUMNS_STORAGE_KEY, columns); } catch {}
            requestAnimationFrame(refreshFeedLayout);
        };

        menuButton.addEventListener('click', () => setMenuOpen(!root.classList.contains(MENU_OPEN_CLASS)));
        filterButton.addEventListener('click', () => setVideoFilter(!root.classList.contains(VIDEO_FILTER_CLASS)));
        layoutSelect.addEventListener('change', () => setGridColumns(layoutSelect.value));
        scrim.addEventListener('click', () => setMenuOpen(false));
        fetchButton.addEventListener('click', () => {
            document.dispatchEvent(new Event('nexus-fapfolder-fetch-visible'));
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && root.classList.contains(MENU_OPEN_CLASS)) setMenuOpen(false);
        });
        controls.append(menuButton, layoutSelect, filterButton, fetchButton);
        document.body.append(controls);
        setMenuOpen(root.classList.contains(MENU_OPEN_CLASS));
        setVideoFilter(root.classList.contains(VIDEO_FILTER_CLASS));
        setGridColumns(root.getAttribute('data-nexus-ff-feed-columns') || '4');
        classifyFeedPosts();

        const observer = new MutationObserver((records) => {
            let addedPosts = false;
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE || (!node.matches('.post') && !node.querySelector('.post'))) continue;
                    classifyFeedPosts(node);
                    addedPosts = true;
                }
            }
            if (addedPosts) requestAnimationFrame(refreshFeedLayout);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        requestAnimationFrame(() => requestAnimationFrame(refreshFeedLayout));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createControls, { once: true });
    } else {
        createControls();
    }
})();
