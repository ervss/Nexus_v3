import json

with open('scripts/prod_grade_results.json', 'r', encoding='utf-8') as f:
    d = json.load(f)

playable = [r for r in d['results'] if r['status'] == 'SUCCESS_PLAYABLE']
print(f"Máme {len(playable)} overených funkčných videí pripravených na vloženie do DB:")
for p in playable:
    title = (p.get('title') or '')[:35]
    url = (p.get('url') or '')[:45]
    print(f"  - {p['name']:14s}: {title:35s} | {url}")
