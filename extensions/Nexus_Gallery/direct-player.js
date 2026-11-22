(async () => {
    const video=document.getElementById('video');const status=document.getElementById('status');
    let hls;
    try {
        const session=new URLSearchParams(location.search).get('session');
        const data=await chrome.runtime.sendMessage({action:'GET_DIRECT_PLAYER',session});
        if(!data?.ok)throw new Error(data?.error || 'Chýba stream. Otvor video znova z panelu.');
        async function play(){try{await video.play();}catch{status.textContent='Klikni Play pre spustenie videa.';}}
        video.addEventListener('playing',()=>{status.textContent='';});
        video.addEventListener('error',()=>{status.textContent='Stream sa nedá prehrať. Obnov stránku zdroja a otvor čerstvú URL; Chrome musí podporovať kodek videa.';});
        if(data.isHls && Hls.isSupported()){
            hls=new Hls({enableWorker:false,xhrSetup:xhr=>{xhr.withCredentials=true;}});
            hls.on(Hls.Events.MANIFEST_PARSED,play);
            hls.on(Hls.Events.ERROR,(_,error)=>{if(error.fatal)status.textContent=`HLS stream sa nepodarilo načítať${error.response?.code ? ` (HTTP ${error.response.code})` : ''}. Obnov video na zdrojovej stránke a otvor ho znova.`;});
            hls.loadSource(data.streamUrl);hls.attachMedia(video);
        }else{
            video.src=data.streamUrl;await play();
        }
        window.addEventListener('pagehide',()=>hls?.destroy());
    }catch(error){status.textContent=error.message;}
})();
