import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.maintenance.test_all_68_extractors import ALL_CANARIES

path = 'app/routers/extractor_health.py'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

dict_code = 'CANARY_URLS = {\n'
for k, v in sorted(ALL_CANARIES.items()):
    dict_code += f'    "{k}": "{v}",\n'
dict_code += '}\n'

new_text = re.sub(r'CANARY_URLS\s*=\s*\{.*?\n\}', dict_code.strip(), text, flags=re.S)

with open(path, 'w', encoding='utf-8') as f:
    f.write(new_text)

print('app/routers/extractor_health.py successfully updated with all 68 canaries!')
