const params = new URLSearchParams(window.location.search);
const url = params.get('url');
const video = document.getElementById('player');

if (url) {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({ autoStartLoad: true });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, function() {
            video.play().catch(e => console.error(e));
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
        video.addEventListener('loadedmetadata', function() {
            video.play().catch(e => console.error(e));
        });
    }
}
