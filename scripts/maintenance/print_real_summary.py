import json

with open('scripts/real_live_extraction_results.json', 'r', encoding='utf-8') as f:
    d = json.load(f)

print('=== 🟢 PLNE FUNKČNÉ A PREHRÁVATEĽNÉ EXTRAKTORY (14) ===')
for r in d['results']:
    if r['status'] == 'SUCCESS_FULLY_PLAYABLE':
        title = (r.get('extracted_title') or '')[:35]
        print(f"  - {r['name']:16s} | Názov: {title:35s} | {r['detail']}")

print('\n=== 🟡 EXTRAKTORY ČO ZÍSKALI METADÁTA (5) ===')
for r in d['results']:
    if r['status'] == 'EXTRACTED_METADATA_ONLY':
        title = (r.get('extracted_title') or '')[:35]
        print(f"  - {r['name']:16s} | Názov: {title:35s} | {r['detail']}")

print('\n=== 🔴 ZLYHALA EXTRAKCIA ZO STRÁNKY (33) ===')
for r in d['results']:
    if r['status'] == 'EXTRACT_FAILED':
        url = (r.get('real_url') or '')[:45]
        print(f"  - {r['name']:16s} | URL: {url:45s} | Chyba: {r['detail'][:35]}")

print('\n=== ⚪ CHÝBA ŽIVÝ ODKAZ / CLOUDFLARE BOT OCHRANA (15) ===')
for r in d['results']:
    if r['status'] == 'NO_LIVE_URL':
        print(f"  - {r['name']:16s}")
