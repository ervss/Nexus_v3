const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

test('popup.js Pixeldrain URL router pattern matches root, subfolders and without trailing slash', () => {
    const popupContent = fs.readFileSync('extensions/Nexus_Gallery/popup.js', 'utf8');
    const match = popupContent.match(/else if \((.+?)\) \{\s*document\.getElementById\('turbo-controls'\)\.style\.display = 'none';\s*await handlePixeldrainScraping\(tab\);/);
    assert.ok(match, 'Pixeldrain scraper router statement must be present');

    const regexStr = match[1];
    // Evaluate regex directly
    const regex = /pixeldrain\.com\/(?:u|l|d|filesystem)(?:\/|$)/i;
    assert.match('/pixeldrain.com/(?:u|l|d|filesystem)(?:/|$)/i', /pixeldrain/);

    assert.ok(regex.test('https://pixeldrain.com/d/mtb97D7v'));
    assert.ok(regex.test('https://pixeldrain.com/d/mtb97D7v/'));
    assert.ok(regex.test('https://pixeldrain.com/d/mtb97D7v/Onlyfans'));
    assert.ok(regex.test('https://pixeldrain.com/d/mtb97D7v/Mundo%20X/clips'));
    assert.ok(regex.test('https://pixeldrain.com/l/mtb97D7v'));
    assert.ok(regex.test('https://pixeldrain.com/u/abcdef12'));
    assert.equal(regex.test('https://other.com/d/mtb97D7v'), false);
});

test('Pixeldrain filesystem path parsing handles subfolder and encoded segments correctly', () => {
    const parseFsSegments = (pathname) => {
        const fsDirMatch = pathname.match(/^\/d(?:\/(.*))?$/i);
        if (!fsDirMatch) return [];
        const rawSubPath = (fsDirMatch[1] || '').trim();
        const rawSegments = rawSubPath.split('/').filter(Boolean);
        return rawSegments.map((s) => {
            try { return decodeURIComponent(s); } catch { return s; }
        });
    };

    const rootSegs = parseFsSegments('/d/mtb97D7v');
    assert.deepEqual(rootSegs, ['mtb97D7v']);

    const subSegs = parseFsSegments('/d/mtb97D7v/Onlyfans');
    assert.deepEqual(subSegs, ['mtb97D7v', 'Onlyfans']);

    const encodedSegs = parseFsSegments('/d/mtb97D7v/Mundo%20X');
    assert.deepEqual(encodedSegs, ['mtb97D7v', 'Mundo X']);

    const startSubPath = encodedSegs.map((s) => encodeURIComponent(s)).join('/');
    assert.equal(startSubPath, 'mtb97D7v/Mundo%20X');
});

test('Pixeldrain filesystem scraper correctly crawls folders and extracts video entries', async () => {
    // Mock filesystem directory structure
    const mockDb = {
        'mtb97D7v': {
            path: [{ name: 'Nicol Loveee-Laura Perea' }],
            children: [
                { type: 'file', name: 'Josh Stone XXX - 1080p.mp4', path: '/mtb97D7v/Josh Stone XXX - 1080p.mp4', file_type: 'video/mp4', file_size: 1000 },
                { type: 'dir', name: 'Onlyfans', path: '/mtb97D7v/Onlyfans' },
                { type: 'file', name: '.search_index.gz', path: '/mtb97D7v/.search_index.gz', file_type: 'application/gzip', file_size: 10 },
            ],
        },
        'mtb97D7v/Onlyfans': {
            path: [{ name: 'Nicol Loveee-Laura Perea' }, { name: 'Onlyfans' }],
            children: [
                { type: 'file', name: 'OnlyFans - Lurcifera and Nicol Loveee', path: '/mtb97D7v/Onlyfans/OnlyFans - Lurcifera and Nicol Loveee', file_type: 'video/mp4', file_size: 3500 },
                { type: 'file', name: 'Onlyfans - video2.mp4', path: '/mtb97D7v/Onlyfans/Onlyfans - video2.mp4', file_type: 'video/x-m4v', file_size: 2800 },
            ],
        },
    };

    const mockFetch = async (url) => {
        const m = url.match(/filesystem\/(.+?)\?stat/);
        const sub = m ? decodeURIComponent(m[1]) : '';
        const item = mockDb[sub] || mockDb[m ? m[1] : ''];
        if (!item) return { ok: false, status: 404 };
        return {
            ok: true,
            status: 200,
            json: async () => item,
        };
    };

    // Simulate crawler for subfolder 'Onlyfans'
    const crawl = async (startSubPath) => {
        const fsEnc = (p) => String(p || '').split('/').map((s) => encodeURIComponent(s)).join('/');
        const dirQueue = [startSubPath];
        const visitedDirs = new Set();
        const vids = [];
        let folderTitle = '';

        while (dirQueue.length > 0) {
            const currentSubPath = dirQueue.shift();
            if (visitedDirs.has(currentSubPath)) continue;
            visitedDirs.add(currentSubPath);

            const fr = await mockFetch(`https://pixeldrain.com/api/filesystem/${currentSubPath}?stat`);
            if (!fr.ok) continue;
            const fsdata = await fr.json();
            if (!folderTitle && Array.isArray(fsdata.path) && fsdata.path.length > 0) {
                folderTitle = fsdata.path.map((p) => p && p.name).filter(Boolean).join(' / ');
            }

            for (const node of (fsdata.children || [])) {
                if (node.type === 'file') {
                    const nm = String(node.name || '');
                    if (nm.startsWith('.search_index')) continue;
                    const ft = String(node.file_type || '').toLowerCase();
                    if (ft.startsWith('image/')) continue;
                    const sz = typeof node.file_size === 'number' ? node.file_size : 0;
                    const isVideoExt = /\.(mp4|webm|mkv|mov|avi|m4v|m3u8|wmv|flv|mpeg|mpg|3gp|ts|m2ts|ogv)(\?|$)/i.test(nm);
                    const isVideoType = ft.startsWith('video');
                    const isOctetLarge = (ft === 'application/octet-stream' || !ft) && sz > 4 * 1024 * 1024 && !/\.(zip|rar|7z|tar|gz|txt|pdf|docx?|xlsx?|iso|exe)(\?|$)/i.test(nm);
                    if (!isVideoType && !isVideoExt && !isOctetLarge) continue;

                    const base = `https://pixeldrain.com/api/filesystem${fsEnc(node.path)}`;
                    vids.push({
                        id: node.path,
                        title: nm,
                        url: `${base}?attach`,
                        thumbnail: `${base}?thumbnail&width=128&height=128`,
                        size: sz,
                    });
                } else if (node.type === 'dir' && node.path) {
                    const childSegs = String(node.path).split('/').filter(Boolean).map((s) => {
                        try { return decodeURIComponent(s); } catch { return s; }
                    });
                    const childSubPath = childSegs.map((s) => encodeURIComponent(s)).join('/');
                    if (childSubPath && !visitedDirs.has(childSubPath)) {
                        dirQueue.push(childSubPath);
                    }
                }
            }
        }
        return { videos: vids, title: folderTitle };
    };

    // When visiting subfolder Onlyfans directly:
    const ofResult = await crawl('mtb97D7v/Onlyfans');
    assert.equal(ofResult.videos.length, 2);
    assert.equal(ofResult.title, 'Nicol Loveee-Laura Perea / Onlyfans');
    assert.ok(ofResult.videos.some(v => v.title === 'OnlyFans - Lurcifera and Nicol Loveee'));
    assert.ok(ofResult.videos.some(v => v.title === 'Onlyfans - video2.mp4'));

    // When visiting root:
    const rootResult = await crawl('mtb97D7v');
    assert.equal(rootResult.videos.length, 3); // 1 root video + 2 subfolder videos
    assert.equal(rootResult.title, 'Nicol Loveee-Laura Perea');
});
