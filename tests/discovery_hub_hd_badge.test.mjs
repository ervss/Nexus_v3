import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = fs.readFileSync(path.join(root, 'app', 'templates', 'index.html'), 'utf8').replace(
    /\{%\s*include\s+"([^"]+)"\s*%\}/g,
    (_, rel) => fs.readFileSync(path.join(root, 'app', 'templates', rel), 'utf8')
);
const dashboardCss = fs.readFileSync(path.join(root, 'app', 'static', 'dashboard.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'app', 'static', 'main.js'), 'utf8');
const badgeStart = template.indexOf('class="av-hd-badge"');
assert.notEqual(badgeStart, -1, 'HD storyboard badge must exist on album cards');

const badge = template.slice(template.lastIndexOf('<span', badgeStart), template.indexOf('</span>', badgeStart) + '</span>'.length);
assert.match(badge, /x-show="file\._hdPreviewLoaded"/,
    'the HD badge must appear once the storyboard image has loaded');
assert.doesNotMatch(badge, /x-show="[^"]*albumViewer\.hdMode/,
    'badge visibility must not depend on the HD display mode');
assert.match(badge, /HD náhľad načítaný/,
    'the badge title must tell the user that an HD preview is available');

assert.match(template, /class="av-hd-preload"[\s\S]{0,220}@load="albumViewerHdPreviewLoaded\(\$event, file\)"[\s\S]{0,120}@error="albumViewerHdPreviewFailed\(file\)"/,
    'storyboard load state must be checked before showing its overlay');
assert.match(template, /x-if="file\._hdPreviewLoaded && \(albumViewer\.hdMode !== 'off' \|\| !file\.thumbnail\)"/,
    'the HD overlay should cover normal thumbnails only in HD mode, but can fill a missing thumbnail');
assert.match(template, /albumViewer\.hdMode === 'off' \? 'av-hd-fallback' : 'av-hd-' \+ albumViewer\.hdMode/,
    'a missing normal thumbnail should show one storyboard frame even with HD mode off');
assert.match(template, /albumViewerHdStyle\(file\)[^`]*file\._scrubStyle/,
    'the HD overlay should apply aspect-aware sizing before the scrub position');
assert.match(dashboardCss, /\.av-hd-overlay\.av-hd-2x2\s*\{\s*background-size: 200% auto;/,
    'the HD collage must preserve storyboard aspect ratio');
assert.match(dashboardCss, /\.av-hd-overlay\.av-hd-1x\s*\{\s*background-size: 400% auto;/,
    'single-frame HD previews must preserve storyboard aspect ratio');
assert.match(dashboardCss, /\.av-hd-overlay\s*\{[^}]*background-repeat: no-repeat;/,
    'fit-sized portrait storyboards must not repeat into the letterboxed space');
assert.match(script, /albumViewerHdFramePosition\(file, column = 1, row = 1, scale = 4\)/,
    'frame positions must be calculated for the source storyboard ratio');
assert.match(script, /albumViewerHdStyle\(file\)[\s\S]{0,450}ratio > 0\.75/,
    'portrait storyboard sheets should use fit-aware sizing');
assert.match(script, /background-size:auto 200%;background-position:50% 50%/,
    'portrait 2x2 collages should be centered and preserve their aspect ratio');
assert.match(script, /const size = ratio > 0\.75 \? 'auto 400%' : '400% auto';[\s\S]{0,140}background-size: \$\{size\} !important/,
    'scrubbing must retain aspect ratio while changing frames');
assert.match(template, /@error="file\.thumbnail=''; \$el\.style\.display='none'"/,
    'a failed normal thumbnail must reveal the card fallback icon');
assert.doesNotMatch(dashboardCss, /\.av-hd-overlay\s*\{[^}]*background-color:/,
    'a missing HD image must not paint a black layer over the normal thumbnail');
const hoverCss = dashboardCss.match(/\.av-item-hover-info\s*\{([^}]+)\}/)?.[1] || '';
assert.match(hoverCss, /inset:\s*auto 0 0/, 'hover information must stay at the bottom of the thumbnail');
assert.match(hoverCss, /max-height:\s*42px/, 'the hover treatment must not darken half the preview');
assert.doesNotMatch(dashboardCss, /\.av-item:hover \.av-item-thumb img\s*\{\s*transform:\s*scale/,
    'hovering must not upscale and blur the normal thumbnail');
assert.doesNotMatch(template, />HD thumb</,
    'the card should not repeat the HD status under the title');
assert.match(script, /albumViewerImageUrl\(url, sourceUrl\)[\s\S]{0,300}thumb_proxy\?url=/,
    'remote album thumbnails must load through the referer-aware image proxy');
assert.match(script, /async albumViewerCaptureHdFrames\(file, signal\)/,
    'unavailable storyboards must fall back to frames from a resolved video stream');
assert.match(script, /const proxyUrl = `\/api\/v1\/video_proxy\?url=\$\{encodeURIComponent\(streamUrl\)\}/,
    'video frames must be read through the same-origin stream proxy');
assert.match(script, /Math\.min\(1, 320 \/ video\.videoWidth, 320 \/ video\.videoHeight\)/,
    'fallback sprite dimensions must stay bounded for large albums');
assert.match(script, /file\._hdFallbackUrl = sheet\.toDataURL\('image\/jpeg', 0\.86\)/,
    'captured frames must become a renderable sprite sheet');
assert.match(script, /HD náhľady: \$\{loaded\} načítaných · \$\{unavailable\} nedostupných/,
    'the completion message must count rendered previews rather than discovered URLs');
assert.match(template, /:src="albumViewerImageUrl\(file\.thumbnail, file\.url\)"/,
    'normal thumbnails must use the image proxy');
assert.match(template, /:src="albumViewerImageUrl\(file\._hdFallbackUrl \|\| file\.storyboard_url, file\.url\)"/,
    'HD storyboard checks must use the image proxy');

console.log('Discovery Hub HD card badge contract passed.');
