import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync('app/static/main.js', 'utf8');
const start = source.indexOf('        discoveryHubVideoSamples(item) {');
const end = source.indexOf('        discoveryHubMergeEnriched(', start);
const missingStart = source.indexOf('        discoveryHubIsMissingMeta(item) {');
const missingEnd = source.indexOf('        discoveryHubMissingMetaItems(', missingStart);
const methods = new Function(`return ({${source.slice(start,end)}${source.slice(missingStart,missingEnd)}})`)();
const card = {type:'album', video_count:2, file_count:4, _enriched:true,
    size_bytes:100, thumbnail:'cover.jpg', preview_status:'ok', first_upload_at:'2025-01-01', last_upload_at:'2025-01-01',
    sample_files:[{type:'image',title:'photo.jpg',thumbnail:'photo.jpg'},
        {type:'file',title:'archive.zip',thumbnail:'file.svg'},
        {type:'video',title:'video.mp4',thumbnail:'video.jpg'}]};
assert.deepEqual(methods.discoveryHubVideoSamples(card).map(sample => sample.title), ['video.mp4']);
assert.equal(methods.discoveryHubIsMissingMeta(card), true, 'missing video thumbnails can be fetched again');
card.sample_files.push({type:'video',title:'second.mp4',thumbnail:'second.jpg'});
assert.equal(methods.discoveryHubIsMissingMeta(card), false);
