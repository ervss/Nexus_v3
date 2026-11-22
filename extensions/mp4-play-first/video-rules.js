// Shared by the worker; static rules are the same conditions and MIME mappings.
const VIDEO_URL_PATTERN = '^https?://[^/]+/.*\\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|mpg|mpeg|3gp|3g2|ts|m2ts|flv|wmv)([?&#]|$)';
const VIDEO_RESPONSE = [{header: 'content-type', values: ['video/*', 'application/ogg*']}];
const HLS_URL_PATTERN = '^https?://[^/]+/.*\\.m3u8([?&#]|$)';
const HLS_RESPONSE = [{header: 'content-type', values: ['application/vnd.apple.mpegurl*', 'application/x-mpegurl*', 'audio/mpegurl*', 'audio/x-mpegurl*']}];
