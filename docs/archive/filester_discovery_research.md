# Research result

**Status: Partial**

The discovery loop is already closed: one GET of a canonical folder URL, six page labels, snowball growth only from live content, collection, and mixed pages, and an in-place update when the folder ID is already known. Hybrid reranking, focused crawling, and neural frontier scores improve the metrics published with them; those figures are not Filester yield or latency, and no ten changes have been scored. The controlled comparisons already available are an offline OLD/NEW harness, a read-only source-yield script, and a stored-edge frontier. Recon yield is not spread across page types: collection HTML is the only high-yield class. [S2][S3][S4][S5][S7][S9][S20][S18][S19][S21][S16]

### Current pipeline

GuardedClient treats filester.me, www.filester.me, filester.si, filester.sh, and filester.gg as one host at 1.5 requests/s with two in-flight slots; every other host is at 0.5 requests/s with one slot. Each wire call, including redirects, increments network_requests until the cap raises RequestBudgetExceeded. An unexpired non-secret cache row is returned without HTTP and is not counted. Collector runs use a 1800-second TTL and store that request counter in metrics. [S1]

Validation is one GET of the canonical folder URL, then a label from status, file count, and subfolder count. DEAD is 404 or 410. ERROR is status 0, 401, 403, 429, or 500 and above, including transport failures. UNKNOWN is anything other than 200 or 304. COLLECTION is a subfolder count of at least 8, or subfolders with no files. CONTENT_FOLDER is at least one file and at most two subfolders. MIXED is at least one file and more than two subfolders. The pool uses at most two workers and, on ERROR, defers the candidate instead of marking it validated. [S2]

Below the depth cap, normalized outbound IDs from live CONTENT_FOLDER, COLLECTION, and MIXED pages are inserted at depth+1 with sources snowball plus collection or outbound, and a link is stored to the child URL. The parent, a repeated link, or an existing candidate is a suppressed duplicate. Stored edges can be seeded with no HTTP and without revalidating indexed live content; that recovery is passed only for backlog jobs. New candidates stop at 1,000 minus snowball and local candidates already counted. The stage returns snowball and local candidate counts, a snowball content count, duplicates suppressed, network requests, max depth, and per-label counts. Per channel, the yield summary records unique new IDs, duplicates, IDs per request, and average latency. [S3][S21]

The public folder URL is `https://filester.me/f/{lowercase id}`. An ID is accepted as 8–64 hex characters or as a URL on those five Filester hosts, and other hosts and blocked IDs are rejected. Allowed mirror hosts are rewritten to that canonical host before outbound links are kept. An existing candidate is updated in place: sources and query classes are merged, the maximum score and the minimum discovery depth are kept, and the call reports no insert. A new row is stored unvalidated. [S4]

### Recon and latency baselines

| Class | Measured result |
| --- | --- |
| Collection HTML | ~467 unique /f/ IDs from one GET |
| Leaf HTML | 1–2 IDs from one GET |
| Mirrors versus filester.me | 0 differential |
| Public API | Absent (404/401) |
| Blog and static pages | 0 /f/ IDs |

Keep-alive beats a cold 200, a one-row Wayback CDX read is the timeout, and a disk-cache repeat is the fast outlier. On the logged job, discovery runs much longer than the wait for the first content folder. The writeup does not define a pass band around these probes. [S17]

| Probe | Result |
| --- | --- |
| Filester cold, HTTP 200 | 0.860 s |
| Filester keep-alive, HTTP 200 | 0.765 s |
| urlscan | 0.436 s, with 29 of 30 requests left |
| Wayback CDX, limit 1 | ReadTimeout at 12.381 s |
| Six mocked 800 ms validations | 6.661 s before, 4.166 s after the recorded change |
| Repeat of that validation | 6.654 s, then 0.029 s via disk cache |
| Job 1e2e89d40005, first content folder | 1.012 s |
| Same job, three HTTP 200 validations | 1.671 s |
| Same job, discovery | 20.548 s |

### Retrieval benchmarks

On T2-RAGBench (23,088 financial queries, 7,318 text-and-table documents), adjacent pairwise differences were significant under paired bootstrap testing (p<0.001). Reranking is the step that lifts hybrid fusion; lexical search beat dense search alone on Recall@5. [S5]

| Retriever | Recall@5 | MRR@3 |
| --- | --- | --- |
| Hybrid RRF + Cohere Rerank v4.0 Pro | 0.816 | 0.605 |
| Hybrid RRF | 0.695 | 0.433 |
| BM25 | 0.644 | — |
| Dense text-embedding-3-large | 0.587 | — |

Weighted reciprocal rank fusion of BM25 and Qwen3-Embedding-0.6B improved MRR over the training-selected individual retriever on four collections and matched BM25 on Open Tender. Those four gains stay distinguishable from zero after Holm correction. In all 50 unrestricted cross-validation selections both static embeddings received zero weight, so every selection sits on the BM25–Qwen edge. [S6]

| Collection | MRR change vs training-selected individual |
| --- | --- |
| Dutch News | +0.061 |
| VABB | +0.029 |
| WebFAQ NL | +0.004 |
| Wikipedia NL | +0.025 |
| Open Tender | 0 |

### Crawl scheduling and open-source comparators

A sleeping-bandit crawler that groups hyperlinks by HTML tag path retrieved 90% of target statistics files while touching 20% of pages on some very large sites, inside an 18-site collection of 22.2 million pages. A Google site-and-filetype query on justice.gouv.fr returned 302 PDFs where more than 9,000 existed, and 240 ODS files out of 910, so in-site search under-covered the crawl. On English ClueWeb22-B, QFirst and QMin propagate a QT5-Small quality score over links and, versus BFS on Researchy Questions, improved harvest rate by up to 149%, maxNDCG by up to 152%, and BM25-then-MonoELECTRA nDCG@10 by up to 139%; QMin’s mean speedup versus BFS was 1.601. For refresh scheduling, sitemap change signals on pages whose sitemaps were declared perfect had precision below 0.2 and recall below 0.5; only 4% of 18,532,314 URLs had side information, but that slice was 26.4% of importance-adjusted weight. [S7][S8][S9][S10]

The focused-crawl sample enables online learning of a binary forward link classifier with a learning limit of 1,000, top-k frontier selection, and a 5000 ms minimum gap between requests to the same host. Master was still updated on 31 August 2025; the newest tag in that history is 0.15.0, committed on 12 March 2023. [S11][S12]

On an uncapped 20,000-page crawl, harvest stayed high while relevant-domain coverage stayed far smaller than the comparison crawler. [S13]

| Topic | TRES harvest rate | TRES domains | ACHE domains |
| --- | --- | --- | --- |
| Sports | 97.43% | 83 | 2,081 |
| Food | 95.59% | 78 | 2,153 |
| Hardware | 93.64% | 55 | 940 |

At a cap of 10 pages per domain, ACHE aborted after running out of URLs, so averages were not reported. The only filled row is Sports, harvest rate 36.79 and 6,084 domains; Food and Hardware are blank. [S14]

The multi-archive URL client was updated on 20 March 2026 and queries AlienVault OTX, the Wayback Machine, Common Crawl, and URLScan. Its client example uses 10 retries and a 60-second timeout, and it publishes no yield or requests-per-accepted result. [S15]

### Ten directions

A change is judged on the same dataset, seed queries, pool, and budgets by useful discovery yield and requests per CONTENT. Effort and regression risk are required separately as LOW, MEDIUM, or HIGH and are not filled for a ten-item list; committed next steps are capped at five. None of the rows below has a Filester yield, request, or latency delta beyond the baselines already stated, so effort and regression risk stay unrated. [S20]

| # | Direction | Yield | Requests per validated result | Latency | Effort | Regression risk |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Prefer collection HTML over leaf HTML for the next GET | Only high-yield recon class | Recon IDs per GET favor that class; not measured as requests per CONTENT | Not timed by class | — | — |
| 2 | Stop buying mirror fetches for coverage | No ID differential versus the canonical host | A mirror call still spends the shared Filester slot budget | — | — | — |
| 3 | Leave blog, static, and the public API out of ID collection | No folder IDs; API absent | Those GETs added no IDs in recon | — | — | — |
| 4 | Keep the single canonical URL and in-place upsert | Repeat IDs remain one candidate | A duplicate does not create a new unvalidated row | — | — | — |
| 5 | Seed backlog frontiers from stored edges before new GETs | Reuses links already stored | Documented as no HTTP | Indexed live content is not revalidated | — | — |
| 6 | Keep cache hits uncounted and count every redirect, including toward max_requests | No yield change claimed | Preserves the current budget definition | Disk-cache repeat is the fast path in the probe table | — | — |
| 7 | Do not replace the six labels with an off-corpus neural frontier or tag-path bandit | Published harvest and nDCG gains are other corpora | Score any local priority change as requests per CONTENT | Published speedups are other corpora | — | — |
| 8 | Widen archive and HTML-search collectors only in the read-only yield script | No stored new-versus-index result; no published gau yield | No requests-per-accepted figure for that client | — | — | — |
| 9 | Do not copy the sample crawler’s same-host gap or the tree crawler’s domain mix into the Filester budget | High harvest there came with much smaller domain counts; the other crawler aborted at the tight per-domain cap | That gap is a different same-host policy than the current Filester slots | — | — | — |
| 10 | Do not add static-embedding fusion or sitemap-perfect refresh as a discovery signal | Static embeddings took no positive weight; declared-perfect sitemap flags are weak on precision and recall | No requests-per-CONTENT result for either signal | No latency result for either signal | — | — |

### Three experiments

The offline harness is OLD versus NEW on one fixture set, with validation budget 12, request budget 15, and 0.02 s transport latency, a mock transport, and no external traffic. It records network calls divided by CONTENT, and time to first content, and it fails if attempts exceed the validation budget or the same folder is validated twice. On that identical workload, the decision rule treats a CONTENT gain at equal requests as the interesting case; the plan’s own illustrations are +30% CONTENT at equal requests versus +40% CONTENT with +80% requests, which is not automatically a good result. Those illustrations are not measured outcomes. [S18][S20]

The source-yield script does not write the production index. It compares baseline sources wayback and urlscan with those plus commoncrawl, duckduckgo_html, and bing_html, at 120 per source and a 20.0 s source timeout, and prints new_vs_index. No completed number is stored, so the measurable success criterion is a recorded new_vs_index for the expanded set against that baseline, not a win over a previous delta. [S19]

The third run stays on a backlog job and uses the existing local seed. Success is local candidates appearing while that seed adds no network requests, with duplicates and the channel summary (unique new IDs, duplicates, IDs per request, average latency) as the yield record, and without revalidating indexed live content. The candidate cap remains 1,000 minus snowball and local counts already taken. [S3][S21]

## Sources
- [S1] "network.py" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/network.py:37-41,180-231" (independently checked against "discovery/network.py GuardedClient" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/network.py:37-40,190-199,214-225")
- [S2] "validate.py" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/validate.py:34-63"
- [S3] "pool.py" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/pool.py:94-127,222-248,319-333" (independently checked against "discovery/pool.py" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/pool.py:94-127,222-248,319-330")
- [S4] "web_extract.py" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/web_extract.py:20-52" (independently checked against "web_extract.py and index/database.py" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/web_extract.py:20-52; C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/index/database.py:186-222")
- [S5] "From BM25 to Corrective RAG: Benchmarking Retrieval Strategies for Text-and-Table Documents" — "https://arxiv.org/html/2604.01733v1"
- [S6] "Do Static Embeddings Add Value to Hybrid Dutch Retrieval?" — "https://arxiv.org/abs/2608.02112" (independently checked against "Do Static Embeddings Add Value to Hybrid Dutch Retrieval?" — "https://arxiv.org/html/2608.02112v1#S5.SS3")
- [S7] "Efficient Crawling for Scalable Web Data Acquisition (Extended Version)" — "https://arxiv.org/html/2602.11874v1"
- [S8] "Efficient Crawling for Scalable Web Data Acquisition (Extended Version)" — "https://arxiv.org/html/2602.11874v1" (independently checked against "Efficient Crawling for Scalable Web Data Acquisition (Extended Version)" — "https://arxiv.org/html/2602.11874v1#S4.SS2")
- [S9] "Neural Prioritisation for Web Crawling" — "https://ar5iv.labs.arxiv.org/html/2506.16146"
- [S10] "A Scalable Crawling Algorithm Utilizing Noisy Change-Indicating Signals" — "https://arxiv.org/html/2502.02430v3" (independently checked against "A Scalable Crawling Algorithm Utilizing Noisy Change-Indicating Signals" — "https://arxiv.org/html/2502.02430v3#S2")
- [S11] "ACHE config/config_focused_crawl/ache.yml" — "https://raw.githubusercontent.com/VIDA-NYU/ache/master/config/config_focused_crawl/ache.yml"
- [S12] "Commits · VIDA-NYU/ache" — "https://github.com/VIDA-NYU/ache/commits/master/" (independently checked against "Commits · VIDA-NYU/ache" — "https://github.com/VIDA-NYU/ache/commit/81b29c09bd6cde03e97cad174959a660620bff3c")
- [S13] [S14] "Tree-based Focused Web Crawling with Reinforcement Learning" — "https://ar5iv.labs.arxiv.org/html/2112.07620"
- [S15] "Commits · lc/gau and getallurls README" — "https://github.com/lc/gau/commits/master/" (independently checked against "getallurls (gau) README" — "https://github.com/lc/gau/blob/master/README.md")
- [S16] "Discovery engine v3 recon baseline" — "C:\\Users\\Peto\\Desktop\\NexusPWC_fresh_v2\\extension\\filester_search\\discovery\\engine.py" (independently checked against "Discovery engine v3 recon baseline" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/engine.py:6-11")
- [S17] "Filester 13.1 measurement 2026-09-30" — "C:\\Users\\Peto\\Desktop\\NexusPWC_fresh_v2\\extension\\filester_search\\PERFORMANCE.md" (independently checked against "Filester 13.1 measurement 2026-09-30" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/PERFORMANCE.md")
- [S18] "Offline OLD/NEW discovery benchmark" — "C:\\Users\\Peto\\Desktop\\NexusPWC_fresh_v2\\extension\\filester_search\\benchmark_discovery.py" (independently checked against "Offline OLD/NEW discovery benchmark" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/benchmark_discovery.py:1-5,45-47,133-135")
- [S19] "Read-only source-yield experiment" — "C:\\Users\\Peto\\Desktop\\NexusPWC_fresh_v2\\extension\\filester_search\\experiment_source_yield.py" (independently checked against "Read-only source-yield experiment" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/experiment_source_yield.py:1-73")
- [S20] "Filester upgrade plan sections 19 and 27" — "C:\\Users\\Peto\\Desktop\\NexusPWC_fresh_v2\\filester_upgrade_plan.md" (independently checked against "Filester upgrade plan" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/filester_upgrade_plan.md:53-69,728-778,1009-1016")
- [S21] "seed_local_frontier and yield tracker" — "C:\\Users\\Peto\\Desktop\\NexusPWC_fresh_v2\\extension\\filester_search\\discovery\\pool.py" (independently checked against "seed_local_frontier and YieldTracker" — "C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/discovery/pool.py:94-127; C:/Users/Peto/Desktop/NexusPWC_fresh_v2/extension/filester_search/metrics/yield_tracker.py:25-102")

## Coverage and uncertainty
- "Question 1 uncertainty: CLI commands crawl and discover still run DiscoveryEngine, which emits YieldTracker channel metrics; discover-web runs WebDiscoveryEngine. Those are not the filester_api.py job started by start_filester.ps1."
- "Question 1 uncertainty: pick_queries builds full site: and quoted-path strings, but _run_job forwards only keyword tokens, and Bing, urlscan, Wayback, Common Crawl, and public hubs do not take a keywords argument."
- "Question 1 uncertainty: seed_local_frontier extracts IDs with SQL SUBSTR after '/f/'; that expression was not checked against every stored URL shape."
- "Question 1 uncertainty: extract_folder_ids requires 12–64 hex characters, while normalize_folder_id and the parser folder regex accept 8–64, so the stages do not use one ID-length rule."
- "Question 2 uncertainty: No 2025–2026 primary paper inspected here reports a controlled measured effect for URL canonicalization as a crawling or retrieval technique."
- "Question 2 uncertainty: No inspected primary paper isolates source-reputation scoring with a before-and-after retrieval metric."
- "Question 2 uncertainty: A reported 10–20% refresh-bandwidth saving appears in secondary snippets of the WWW 2025 PDF but was not in the arXiv HTML portion read here, so it is not used."
- "Question 2 uncertainty: The SB-CLASSIFIER 90%/20% result is stated for some large sites, not for every one of the 18 evaluated sites."
- "Question 2 uncertainty: Method labels in the rendered Table I of arXiv:2604.01733 were misaligned; the hybrid and BM25 figures above are taken from the paper’s prose, not from that broken table."
- "Question 3 uncertainty: The question's phrase 'those same mechanisms' is not defined in the question; these claims map it to online frontier prioritization and Wayback/Common Crawl/urlscan discovery as implemented in the local filester discovery code."
- "Question 3 uncertainty: The TRES paper reports page harvest rate, not HTTP requests per accepted page or measured fetch latency, so inverting harvest rate is not a measured request count."
- "Question 3 uncertainty: ACHE's REST documentation value target.storage.harvest.rate 0.9777777777777777 is an example response body, not a published crawl benchmark."
- "Question 3 uncertainty: TRES's public commit history shows a 16 Feb 2026 README update, but the inspected crawling-code commits stop in 2023, so continued maintenance of the crawler itself is not established."
- "Question 3 uncertainty: gau returns archived URLs and the inspected README does not show a live-acceptance or validation step, so its output is not an accepted-content yield."
- "Question 3 uncertainty: No inspected source reports one benchmark that jointly measures yield, requests per accepted result, and latency for these systems."
- "Question 4 uncertainty: No inspected file lists at most ten concrete changes that preserve current working behavior and already assigns each a score for discovery yield, requests per validated result, latency, implementation effort, and regression risk."
- "Question 4 uncertainty: benchmark_discovery.py and experiment_source_yield.py define experiments but do not store a completed numeric OLD/NEW or new_vs_index run in the files read."
- "Question 4 uncertainty: The Desktop Filester Search Data database was not opened, so the read-only audit scripts' live job aggregates were not measured in this pass."
- "Question 4 uncertainty: The '~467 unique /f/ IDs' figure is a source comment labeled recon, not a measurement reproduced here."
- "Question 4 uncertainty: ab_test_pool defines a FIFO-versus-priority split with a default budget of 50 but records no pass/fail threshold or saved result."
- "Claim claim-0 was excluded by verification: A non-backlog job calls run_collectors with body.sources when that list is non-empty, not unconditionally with public_hubs, wayback, urlscan, commoncrawl, duckduckgo_html, and bing_html. Those six names are only DEFAULT_DISCOVERY_SOURCES and the dashboard's default checkboxes; Brave can be added and any default can be unchecked. Backlog jobs (backlog_only or sources ['local_frontier']) skip collectors. The keyword half does match: keywords are body.keywords plus q[0].split('+')[0] from pick_queries tuples, not the query strings in q[1].."
- "Claim claim-1 was excluded by verification: Collectors do share one GuardedClient, default to a 20-second asyncio timeout, and dedupe inside each source, but DuckDuckGo does not append at most 12 keyword queries. For each of keywords[:12] it appends both '\"filester.me/f/\" {kw}' and 'site:filester.me/f {kw}', so the added set is up to 24 queries.."
- "Claim claim-14 was excluded by verification: Harvest rate is defined as relevant retrieved pages divided by all retrieved pages, and the uncapped ACHE row is HR 54.43, 60.45, and 49.25 on Sports, Food, and Hardware. The claim that each crawl retrieves 20,000 pages is not exact: 20,000 is the configured target, but the paper says that for MAX<=10 ACHE aborted after running out of URLs and did not retrieve the defined number of pages.."
