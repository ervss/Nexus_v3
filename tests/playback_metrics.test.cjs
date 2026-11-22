const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function fixture(autoplay=true) {
 const context={window:{}, performance:{now:()=>0}};
 vm.runInNewContext(fs.readFileSync('app/static/playback_metrics.js','utf8'),context);
 let now=0;
 const metrics=new context.window.NexusPlaybackMetrics(()=>now,autoplay);
 const media={paused:false,seeking:false,currentTime:0};
 return {metrics,media,at:t=>now=t};
}
test('startup requires time advancement, not metadata or canplay',()=>{
 const {metrics,media,at}=fixture();
 at(100);metrics.event('canplay',media);assert.equal(metrics.snapshot().startup_ms,null);
 at(800);media.currentTime=.25;metrics.event('timeupdate',media);
 assert.equal(metrics.snapshot().startup_ms,800);
});
test('waiting counts once per stall and seek or pause does not count as a stall',()=>{
 const {metrics,media,at}=fixture();
 media.currentTime=1;metrics.event('timeupdate',media);metrics.event('playing',media);
 at(1000);metrics.event('waiting',media);metrics.event('waiting',media);
 at(3500);metrics.event('playing',media);
 assert.equal(metrics.snapshot().stalls,1);assert.equal(metrics.snapshot().stall_ms,2500);
 media.seeking=true;metrics.event('waiting',media);
 media.seeking=false;media.paused=true;metrics.event('waiting',media);
 assert.equal(metrics.snapshot().stalls,1);
 at(5000);metrics.event('pause',media);at(15000);
 assert.equal(metrics.snapshot().observed_ms,5000);
});
test('recovery measures until actual progression and multiple signals share the start',()=>{
 const {metrics,media,at}=fixture();
 at(1000);metrics.event('recover',media);at(2000);metrics.event('recover',media);
 metrics.event('canplay',media);assert.equal(metrics.snapshot().recovery_ms,null);
 at(4500);media.currentTime=1;metrics.event('timeupdate',media);
 assert.equal(metrics.snapshot().recovery_ms,3500);assert.equal(metrics.snapshot().recoveries,1);
});
test('manual play excludes waiting for user input from startup',()=>{
 const {metrics,media,at}=fixture(false);
 at(60000);metrics.event('play',media);at(61000);media.currentTime=.2;metrics.event('timeupdate',media);
 assert.equal(metrics.snapshot().startup_ms,1000);
});
