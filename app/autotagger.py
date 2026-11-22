import re

# Comprehensive dictionary of known performers/creators and tags for NexusPWC Auto-Tagging
KNOWN_MODELS = [
    "riley reid", "mia khalifa", "lana rhoades", "abella danger", "angela white",
    "nicole aniston", "dani daniels", "sophie dee", "brandi love", "kendra lust",
    "asa akira", "lexi luna", "eva elfie", "gabbie carter", "adriana chechik",
    "sweetie fox", "belle delphine", "amouranth", "rae lil black", "little caprice",
    "mia malkova", "sasha grey", "remi lacroix", "jessa rhodes", "lena paul",
    "kelsi monroe", "autumn falls", "cory chase", "sirena dallas", "alexis texas",
    "leolulu", "anjela white", "karlee grey", "emily willis", "kendall woods",
    "kaylee gunner", "sarah jessie", "courtney tillia", "rebecca more", "rebecca moore",
    "danae mari", "petra karoshova", "lisa evans", "daisy lee", "candi katty",
    "anna polina", "sami hayes", "nicol love", "tatti roana", "selena blaze",
    "bracey bella", "kristen hancher", "nicolette shea", "alicia amira",
    "stefanie knight", "stefanie gurzanski", "foxy menagerie", "azul hermosa",
    "riley rae", "jennyfer stone", "frances bentley", "marina maya", "ruth lee",
    "alanna pow", "alura luxe", "lexis star", "reese robbins", "alex blake",
    "jaye summers", "anna mukydza", "jak knife", "jmac", "lila geller",
    "kenziee jayy", "milana sw", "reagan foxx", "kali roses", "emma starletto",
    "victoria nova", "dixie lynn", "natalia queen", "maddy black", "evelin stone",
    "sara retali", "nuria millan", "violet myers", "savannah bond", "skylar vox",
    "melody marks", "gia derza", "blake blossom", "vanna bardot", "kylie rocket",
    "lulu chu", "vina sky", "alina lopez", "aidra fox", "chloe temple",
    "gianna dior", "kenzie reeves", "aria lee", "lily larimar", "maya bijou",
    "val Valentina", "valentina nappi", "ava addams", "bridgette b", "romi rain",
    "luna star", "alexis fawx", "cherie deville", "india summer", "veronica avluv",
    "syren de mer", "aletta ocean", "madison ivy", "peta jensen", "august ames",
    "megan rain", "janice griffith", "leah gotti", "elsieff", "dillion harper",
]

KNOWN_TAGS = {
    "pov": ["pov", "point of view", "firstclasspov", "baddiesonlypov"],
    "teen": ["teen", "18yo", "19yo", "young", "college", "schoolgirl"],
    "milf": ["milf", "mom", "mother", "stepmom", "step mom", "mature", "cougar", "housewife"],
    "stepfantasy": ["step", "stepbro", "stepsis", "stepdad", "stepson", "stepdaughter", "stepsister", "stepbrother"],
    "amateur": ["amateur", "homemade", "home video", "real couple", "gf"],
    "anal": ["anal", "asshole", "sodomy", "butt plug", "buttplug", "dp", "double penetration"],
    "creampie": ["creampie", "cum inside", "internal", "breed", "breeding"],
    "cumshot": ["cumshot", "facial", "swallow", "cum on", "bukkake", "cumswap"],
    "threesome": ["threesome", "3some", "mmf", "ffm", "threesom", "foursome", "orgy", "gangbang"],
    "lesbian": ["lesbian", "lesbo", "girl on girl", "gog", "tribbing", "scissoring"],
    "blowjob": ["blowjob", "bj", "sucking", "cocksucker", "fellatio", "deepthroat", "sloppy bj", "throatpie", "facefuck", "gagging"],
    "handjob": ["handjob", "hj", "stroking", "footjob", "titfuck", "paizuri", "tittyfuck"],
    "big tits": ["big tits", "boobs", "busty", "big boobs", "huge tits", "massive tits", "natural tits"],
    "big ass": ["big ass", "pawg", "booty", "juicy ass", "twerk", "bubble butt", "phat ass"],
    "petite": ["petite", "small", "tiny", "skinny", "slim", "spinner"],
    "ebony": ["ebony", "black girl", "african"],
    "bbc": ["bbc", "interracial", "blacked", "big black cock"],
    "asian": ["asian", "japanese", "korean", "chinese", "jav", "thai", "filipina"],
    "latina": ["latina", "spanish", "mexican", "colombian", "brazilian", "argentinian"],
    "british": ["british", "uk", "english girl"],
    "blonde": ["blonde", "blond"],
    "brunette": ["brunette"],
    "redhead": ["redhead", "ginger"],
    "bdsm": ["bdsm", "bondage", "rough", "choking", "spanking", "submissive", "femdom", "domination", "slave"],
    "hardcore": ["hardcore", "rough", "brutal", "pounding", "drilling"],
    "doggystyle": ["doggystyle", "doggy style", "doggy", "from behind", "backshots"],
    "cowgirl": ["cowgirl", "reverse cowgirl", "riding"],
    "masturbation": ["masturbation", "solo", "dildo", "vibrator", "fingering", "fuck machine", "squirt", "squirting", "orgasm"],
    "lingerie": ["lingerie", "stockings", "fishnets", "pantyhose", "garter", "heels", "bra"],
    "bikini": ["bikini", "swimsuit", "pool", "beach"],
    "cosplay": ["cosplay", "costume", "parody", "maid", "nurse", " cheerleader"],
    "outdoor": ["outdoor", "public", "car", "nature", "balcony", "forest"],
    "shower": ["shower", "bathroom", "bath", "bathtub"],
    "tattoo": ["tattoo", "tattooed", "inked"],
    "oiled": ["oiled", "oil", "shiny", "wet"],
    "glasses": ["glasses"],
    "vr": ["vr", "virtual reality", "180", "360"],
    "onlyfans": ["onlyfans", "fansly", "patreon", "manyvids", "ppv"],
    "twitch": ["twitch", "streamer", "gamer girl", "camgirl", "chaturbate", "stripchat"],
}

def auto_tag_video(title: str) -> dict:
    if not title:
        return {"tags": [], "models": []}
    
    title_lower = title.lower()
    
    found_models = []
    for model in KNOWN_MODELS:
        if re.search(r'\b' + re.escape(model) + r'\b', title_lower):
            found_models.append(model.title())
            
    found_tags = []
    for tag_name, keywords in KNOWN_TAGS.items():
        for kw in keywords:
            if re.search(r'\b' + re.escape(kw) + r'\b', title_lower):
                found_tags.append(tag_name)
                break # Move to next tag category
                
    return {
        "tags": found_tags,
        "models": found_models
    }
