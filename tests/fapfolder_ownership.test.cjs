const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,'');
const hosts=['https://fapfolder.club/*','https://*.fapfolder.club/*'];
test('FapFolder has dedicated gallery importer and NVS stays guarded',()=>{
 const gallery=JSON.parse(read('extensions/Nexus_Gallery/manifest.json'));
 const selector=JSON.parse(read('extensions/nexus-video-selector/manifest.json'));
 const galleryGeneric=gallery.content_scripts.find(row=>row.js?.includes('universal_importer.js'));
 assert.ok(galleryGeneric);
 for(const host of hosts)assert.ok(galleryGeneric.exclude_matches.includes(host),'universal_importer.js: '+host);
 const selectorGuard=selector.content_scripts.find(row=>row.js?.includes('nvs-ui-guard.js'));
 assert.ok(selectorGuard);
 const dedicated=gallery.content_scripts.find(row=>row.js?.includes('fapfolder_grid_importer.js'));
 for(const host of hosts)assert.ok(dedicated.matches.includes(host));
 assert.ok(dedicated.css.includes('fapfolder_grid_importer.css'));
});
test('Nexus Gallery universal_importer exits on FapFolder',()=>{
 for(const hostname of ['fapfolder.club','www.fapfolder.club','media.fapfolder.club']){
  const location={hostname,href:'https://'+hostname+'/groups/example/videos',port:''};
  const window={location};
  vm.runInNewContext(read('extensions/Nexus_Gallery/universal_importer.js'),{window});
 }
});
function popup(url){
 const calls=[];
 const context={URL,document:{addEventListener:()=>{}},chrome:{tabs:{query:async()=>[{id:8,url}]},storage:{sync:{get:async()=>{calls.push('storage');return{};}}},scripting:{executeScript:async()=>calls.push('inject'),insertCSS:async()=>calls.push('css')}}};
 vm.createContext(context);
 vm.runInContext(read('extensions/nexus-video-selector/popup.js')+';this.api={getActiveTabInfo,enableHostAndInject};',context);
 return {...context.api,calls};
}
test('selector popup resolves active host support on FapFolder and normal sites',async()=>{
 const h=popup('https://fapfolder.club/ervssik/groups');
 const info=await h.getActiveTabInfo();assert.equal(info.host,'fapfolder.club');
 assert.equal(info.isSupported,true);
});
test('ownership routing does not disable unrelated websites or lookalike domains',async()=>{
 for(const url of ['https://example.org/videos','https://fapfolder.club.example.org/videos']){
  const h=popup(url);assert.equal((await h.getActiveTabInfo()).isSupported,true);
 }
});
