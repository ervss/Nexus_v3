import importlib
from .registry import ExtractorRegistry

_CORE_EXTRACTOR_SPECS = [
    ("InternetChicks", "app.extractors.internetchicks", "InternetChicksExtractor", ("internetchicks.",)),
    ("PornOne", "app.extractors.pornone", "PornOneExtractor", ("pornone.",)),
    ("Eporner", "app.extractors.eporner", "EpornerExtractor", ("eporner.",)),
    ("GoFile", "app.extractors.gofile", "GoFileExtractor", ("gofile.io",)),
    ("PornTrex", "app.extractors.porntrex", "PorntrexExtractor", ("porntrex.",)),
    ("WhoresHub", "app.extractors.whoreshub", "WhoresHubExtractor", ("whoreshub.",)),
    ("Turbo", "app.extractors.turbo", "TurboExtractor", ("turbo.cr",)),
    ("Bunkr", "app.extractors.bunkr", "BunkrExtractor", ("bunkr", "findr.to")),
    ("Camwhores", "app.extractors.camwhores", "CamwhoresExtractor", ("camwhores.tv",)),
    ("iXXX", "app.extractors.ixxx", "IxxxExtractor", ("ixxx.",)),
    ("Filester", "app.extractors.filester", "FilesterExtractor", ("filester.", "fileditch", "theditch.", "donotsharethesetemplinksyouidiot.")),
    ("CyberFile", "app.extractors.cyberfile", "CyberFileExtractor", ("cyberfile.",)),
    ("LeakPorner", "app.extractors.leakporner", "LeakPornerExtractor", ("leakporner.", "pornerleak.", "mypornerleak.")),
    ("PornHoarder", "app.extractors.pornhoarder", "PornHoarderExtractor", ("pornhoarder.",)),
    ("Archivebate", "app.extractors.archivebate", "ArchivebateExtractor", ("archivebate.",)),
    ("Recurbate", "app.extractors.recurbate", "RecurbateExtractor", ("recurbate.", "rec-ur-bate.")),
    ("NoodleMagazine", "app.extractors.noodlemagazine", "NoodleMagazineExtractor", ("noodlemagazine.", "ukdevilz.")),
    ("ThotsTv", "app.extractors.thotstv", "ThotsTvExtractor", ("thots.tv", "thot.tv")),
    ("Vidara", "app.extractors.vidara", "VidaraExtractor", ("vidara.", "vidfast.", "vidsonic.")),
    ("vTube", "app.extractors.vtbe", "VtbeExtractor", ("vtbe.",)),
    ("LuluStream", "app.extractors.lulustream", "LuluStreamExtractor", ("lulu.", "lulust.", "lulustream.", "luluvdo.")),
    ("KrakenFiles", "app.extractors.krakenfiles", "KrakenFilesExtractor", ("krakenfiles.",)),
    ("SxyPrn", "app.extractors.sxyprn", "SxyPrnExtractor", ("sxyprn.",)),
    ("HornySimp", "app.extractors.hornysimp", "HornySimpExtractor", ("hornysimp",)),
    ("PornHat", "app.extractors.pornhat", "PornHatExtractor", ("pornhat.",)),
    ("Beeg", "app.extractors.beeg", "BeegExtractor", ("beeg.",)),
    ("CyberLeaks", "app.extractors.cyberleaks", "CyberLeaksExtractor", ("cyberleaks.",)),
    ("8KPorner", "app.extractors.eightk_porner", "EightKPornerExtractor", ("8kporner.",)),
    ("MyPornerLeak", "app.extractors.mypornerleak", "MyPornerLeakExtractor", ("mypornerleak.",)),
    ("SlutVids", "app.extractors.slutvids", "SlutVidsExtractor", ("slutvids.",)),
    ("FNXTube", "app.extractors.fnxtube", "FNXTubeExtractor", ("fnxtube.",)),
    ("PimpBunny", "app.extractors.pimpbunny", "PimpBunnyExtractor", ("pimpbunny.",)),
    ("PornHD4K", "app.extractors.pornhd4k", "PornHD4KExtractor", ("pornhd4k.",)),
    ("Pornonahobka", "app.extractors.pornonahobka", "PornonahobkaExtractor", ("pornonahobka.",)),
    ("Erome", "app.extractors.erome", "EromeExtractor", ("erome.",)),
    ("Shareanynudes", "app.extractors.shareanynudes", "ShareanynudesExtractor", ("shareanynudes.",)),
    ("ThisVid", "app.extractors.thisvid", "ThisVidExtractor", ("thisvid.",)),
    ("Fpo", "app.extractors.fpo", "FpoExtractor", ("fpo.xxx",)),
    ("Porneec", "app.extractors.porneec", "PorneecExtractor", ("porneec.",)),
    ("1Porn", "app.extractors.oneporn", "OnePornExtractor", ("1porn.",)),
    ("Coomerfans", "app.extractors.coomerfans", "CoomerfansExtractor", ("coomerfans.",)),
    ("Pixeldrain", "app.extractors.pixeldrain", "PixeldrainExtractor", ("pixeldrain.",)),
    ("CyberDrop", "app.extractors.cyberdrop", "CyberDropExtractor", ("cyberdrop.",)),
    ("BigPorn", "app.extractors.bigporn", "BigPornExtractor", ("bigporn.",)),
    ("Freeuseporn", "app.extractors.freeuseporn", "FreeusepornExtractor", ("freeuseporn.",)),
    ("FreePornFun", "app.extractors.freepornfun", "FreepornfunExtractor", ("freepornfun.",)),
    ("BaddieHub", "app.extractors.baddiehub", "BaddieHubExtractor", ("baddiehub.",)),
    ("Civitai", "app.extractors.civitai", "CivitaiExtractor", ("civitai.",)),
    ("Xxxdbx", "app.extractors.xxxdbx", "XxxdbxExtractor", ("xxxdbx.",)),
    ("Xfree", "app.extractors.xfree", "XfreeExtractor", ("xfree.",)),
    ("XGroovy", "app.extractors.xgroovy", "XGroovyExtractor", ("xgroovy",)),
    ("RedGifs", "app.extractors.redgifs", "RedGifsExtractor", ("redgifs.",)),
    ("HQPorner", "app.extractors.hqporner", "HQPornerExtractor", ("hqporner.", "mydaddy.")),
    ("69Tubed", "app.extractors.tubed69", "Tubed69Extractor", ("69tubed.", "q8y5z.")),
    ("Faphouse", "app.extractors.faphouse", "FaphouseExtractor", ("faphouse.",)),
    ("Thothub", "app.extractors.thothub", "ThothubExtractor", ("thothub.",)),
    ("CamWhoresBay", "app.extractors.camwhoresbay", "CamwhoresbayExtractor", ("camwhoresbay.",)),
    ("XXBrits", "app.extractors.xxbrits", "XXBritsExtractor", ("xxbrits.",)),
    ("PornFans", "app.extractors.pornfans", "PornFansExtractor", ("pornfans.",)),
    ("Leakedzone", "app.extractors.leakedzone", "LeakedzoneExtractor", ("leakedzone.",)),
    ("DJAV", "app.extractors.djav", "DjavExtractor", ("djav.",)),
]

_EXTENDED_EXTRACTOR_SPECS = [
    ("XVideos", "app.extractors.xvideos", "XVideosExtractor", ("xvideos.",)),
    ("XNXX", "app.extractors.xnxx", "XnxxExtractor", ("xnxx.",)),
    ("SpankBang", "app.extractors.spankbang", "SpankBangExtractor", ("spankbang.", "sb-cd.")),
    ("NSFW247", "app.extractors.nsfw247", "NSFW247Extractor", ("nsfw247.",)),
    ("VK", "app.extractors.vk", "VKExtractor", ("vk.com", "vk.ru", "vk.video", "vkvideo.", "okcdn.ru")),
    ("xHamster", "app.extractors.xhamster", "XHamsterExtractor", ("xhamster.",)),
    ("Pornhub", "app.extractors.pornhub", "PornhubExtractor", ("pornhub.", "phncdn.")),
    ("RedTube", "app.extractors.redtube", "RedTubeExtractor", ("redtube.",)),
]

_CLASS_TO_MODULE = {
    cls_name: mod_path
    for _, mod_path, cls_name, _ in (_CORE_EXTRACTOR_SPECS + _EXTENDED_EXTRACTOR_SPECS)
}


def __getattr__(name: str):
    mod_path = _CLASS_TO_MODULE.get(name)
    if mod_path:
        return getattr(importlib.import_module(mod_path), name)
    try:
        return importlib.import_module(f"app.extractors.{name}")
    except ImportError as exc:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc


def get_video_metadata(video_url):
    import requests
    from bs4 import BeautifulSoup

    response = requests.get(video_url)
    soup = BeautifulSoup(response.text, 'html.parser')
    metadata = {}
    title_tag = soup.title
    if title_tag:
        metadata['title'] = title_tag.string
    description_tag = soup.find('meta', attrs={'name': 'description'})
    if description_tag and 'content' in description_tag.attrs:
        metadata['description'] = description_tag['content']
    return metadata


def init_registry():
    for name, mod_path, cls_name, hints in _CORE_EXTRACTOR_SPECS:
        ExtractorRegistry.register_lazy(name, mod_path, cls_name, hints)


def register_extended_extractors():
    for name, mod_path, cls_name, hints in _EXTENDED_EXTRACTOR_SPECS:
        ExtractorRegistry.register_lazy(name, mod_path, cls_name, hints)


init_registry()
