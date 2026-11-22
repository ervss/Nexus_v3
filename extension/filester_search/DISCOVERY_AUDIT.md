# Filester discovery audit — 2026-10-09

Branch: `codex/filester-discovery-audit`. Baseline: the original dirty working tree, preserved in `artifacts/filester-discovery-audit/before_source`, not Git HEAD. Research baseline: `filester_discovery_research.md`. Changes remain uncommitted; pre-existing user edits were retained.

## Entry points and production evidence

| Entry point | Actual path | Policy and persistence |
| --- | --- | --- |
| Web / extension dashboard | `extension/dashboard.js:582` submits POST `/discover`; `filester_api.py:624` schedules `_run_job:671`, which calls `run_collectors` and `validate_pool` | Priority order, shared seen set across validation waves, current-job candidates only; source callbacks launch validation before all collectors finish |
| Dashboard backlog | Same POST with `backlog_only=true` / sources `['local_frontier']` | Skips collectors, seeds stored edges, allows backlog, still bounded by validation/request/frontier/depth limits |
| Extension popup / background | Popup opens the dashboard; background reads `/bridge` and maintains cache/open-tab queue | No separate discovery engine |
| CLI `crawl`, `watch` | `filester_search.py → cli.py → CrawlScheduler` | Separate crawl queue, Fetcher and AdaptiveLimiter; **crawl does not use DiscoveryEngine** |
| CLI `discover` | `cli.py:313 → DiscoveryEngine` | Seeded graph discovery and YieldTracker; separate queue/fetch policy |
| CLI `discover-web` | `cli.py:267 → WebDiscoveryEngine → run_collectors` | Collects first, validates its own batch; no API rotator. CLI reads a `strategy` attribute that its parser does not define, so the current default is the legacy non-priority path, which shuffles despite being labelled FIFO |
| CLI `validate-pool`, `ab-pool`, `source-stats` | Pool validation, legacy random split A/B, or collectors respectively | validate-pool defaults FIFO; ab-pool writes validation state and is unsuitable for this production-safe audit |

`scripts/start_filester.ps1` and the target's launcher start `filester_api.py` on localhost:8765. Existing server logs show dashboard `/bridge` and job-result requests. At audit time there was no live Filester process/listener on 8765. Thus the configured production path is verified by source/launchers and historical logs, not an observation of an active production discovery job. Browser click workflow was not exercised: no running service, and no production job was started. No UI files were changed.

## Verified fixes

1. **ID contract:** align both discovery extractors and legacy CLI seed/known-ID handling with the existing parser/normalizer's 8–64 hex contract. Reject truncated 65-character IDs, non-hex suffixes and foreign-host substrings; keep case normalization, mirrors, JSON slash escaping, relative legacy links and operator exclusions. The defect is inconsistent acceptance in the code. Live validity of 8–11-character service IDs was not established; all short-ID results below are synthetic.
2. **Query forwarding:** API now passes exact `pick_queries` tuples, including complete co-occurrence pairs, to DDG/Bing/Brave. Planned queries run first within each HTML source, deduplicated by expression, followed by existing generic families. Bing now supports keyword-only legacy callers too. Archives, urlscan and public hubs retain native URL/domain queries. Global wire budgets and source deadlines remain enforced; a shared budget can still starve individual sources.
3. **Stored frontier:** compare live pages and existing candidates by normalized ID after SQL filtering, so mirror/case/query URL variants do not seed known live content. The evidence scan is bounded at 10,000 rows rather than the previous `limit * 4`, avoiding the reproduced duplicate crowding case. Unexpanded collections remain eligible; successful candidate state and operator exclusions are preserved. Seeding issues zero HTTP requests.

## Original benchmark: regression comparison

Three fresh-process repeats per arm before and after; same unmodified `benchmark_discovery.py`, fixture SHA256 `f5d940754878b75a6ec9c2975caa95aff51ceafb430ff783e248a4335cf7a3b1`, validation budget 12, harness total request ceiling 15, 20 ms mock response latency, real GuardedClient pacing and disposable SQLite/cache. Times are wall-clock medians, including client setup and SQLite; no real network latency or TLS handshake is measured.

| Arm | New valid IDs B→A | CONTENT B→A | Requests B→A | Req/CONTENT B→A | Duplicates B→A | First content s B→A | Total s B→A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| fifo:local=False | 15 → 15 | 1 → 1 | 14 → 14 | 14.000 → 14.000 | 14 → 14 | 2.833 → 2.817 | 9.464 → 9.439 |
| priority:local=False | 19 → 19 | 6 → 6 | 15 → 15 | 2.500 → 2.500 | 20 → 20 | 2.831 → 2.790 | 9.500 → 9.472 |
| fifo:local=True | 17 → 17 | 1 → 1 | 14 → 14 | 14.000 → 14.000 | 14 → 14 | 2.842 → 2.797 | 9.488 → 9.430 |
| priority:local=True | 21 → 21 | 8 → 8 | 15 → 15 | 1.875 → 1.875 | 20 → 20 | 2.168 → 2.148 | 9.506 → 9.486 |

Counts and ratios match BEFORE/AFTER in every repeat. Small timing deltas are not a demonstrated speedup. The existing priority policy outperforms FIFO on this fixture already: 6 vs 1 CONTENT without local reuse, or 8 vs 1 with reuse. This is a policy comparison, not a gain caused by this patch. Duplicate counts use the existing harness's repeated-ingestion plus snowball definition, not every repeated string in raw HTML. Every run asserts no folder is validated twice and budgets are respected.

## Targeted identical-workload comparison

Same audit harness executed against snapshot and final source, three repeats each, matching per-case workload hashes. CONTENT counts are validated labels on mock responses. 'New CONTENT' excludes folders indexed before the run.

| Fixture | New valid IDs B→A | CONTENT B→A | New CONTENT B→A | Requests B→A | Req/new CONTENT B→A | First useful s B→A | Total s B→A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| id_lengths:priority | 3 → 7 | 3 → 7 | 3 → 7 | 4 → 8 | 1.333 → 1.143 | 0.080 → 0.082 | 1.410 → 4.086 |
| local_reuse:priority | 0 → 1 | 1 → 1 | 0 → 1 | 1 → 1 | — → 1.000 | — → 0.053 | 0.053 → 0.056 |

The ID fix finds four previously dropped valid fixture IDs. It also performs four additional validations, so total latency rises; this is increased coverage, not a latency win. The frontier fixture spends its one request on known content BEFORE and new content AFTER: known-content requests 1→0, seed requests 0→0. All targeted runs have zero duplicate validations. Request ratios for the ID fixture include its one collector request (4/3→8/7); local ratios use its one validation request. Neither fixture estimates production yield.

## Collection-first experiment

An experimental stable partition by stored live collection evidence is applied only in the mock harness; production ordering is unchanged. Identical candidates, stored hint, six validations/requests and real pacing per arm. AFTER medians:

| Workload | Order | New IDs | CONTENT | Requests | Req/CONTENT | First useful s | Total s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| collection_late | fifo | 7 | 2 | 6 | 3.000 | 2.721 | 3.392 |
| collection_late | priority | 7 | 2 | 6 | 3.000 | 2.714 | 3.395 |
| collection_late | collection_first | 7 | 4 | 6 | 1.500 | 1.395 | 3.400 |
| content_first | fifo | 7 | 5 | 6 | 1.200 | 0.054 | 3.389 |
| content_first | priority | 7 | 5 | 6 | 1.200 | 0.054 | 3.389 |
| content_first | collection_first | 7 | 5 | 6 | 1.200 | 0.731 | 3.397 |

Collection-first improves yield when a productive collection arrives behind dead leaves, but delays the first useful result when early leaves are productive. This measured tradeoff is why it was not enabled in production. Ranking unknown folders as collections solely because they are collection children is not justified by the research baseline.

## Source-yield experiment and safety

Ran the existing `experiment_source_yield.measure` for baseline wayback+urlscan and expanded +commoncrawl+DDG+Bing through a safety wrapper: per-source limit 20, timeout 8 seconds, global maximum 6 wire requests per arm. These differ from the original uncapped 120/20-second script defaults. Production known IDs are read with SQLite mode=ro and the connection is closed; cache/cooldowns are backed up read-only into disposable copies, preserving restrictions. Each live arm starts from the same initial cache snapshot. No production SQL writes, restart, API job or recursive folder crawl occurred.

| Mode | Baseline unique / new vs index | Expanded unique / new vs index | Requests baseline / expanded | Seconds baseline / expanded |
| --- | ---: | ---: | ---: | ---: |
| offline fixture (before) | 2 / 1 | 3 / 2 | 6 / 6 | 8.04 / 8.03 |
| offline fixture (after) | 2 / 1 | 4 / 3 | 6 / 6 | 8.03 / 8.03 |
| live exploratory (live) | 3 / 0 | 2 / 0 | 5 / 6 | 8.72 / 8.90 |

Offline responses and known-ID fixture are identical before/after; the extra expanded-set ID is the recovered eight-character fixture ID. Live is one exploratory AFTER sample, not a controlled before/after gain or source-coverage verdict. Live accepted candidates are syntactically normalized but no live CONTENT validation was performed. urlscan yielded already-known IDs; Wayback returned 503/transport failures. Deadline/budget/cooldown limits prevented useful data from several expanded sources; a local status 0 does not establish a remote access block. No access restriction was bypassed. Mirror archive/search queries remain because different historical indexes can contain different URLs; live folder validation already uses only canonical filester.me URLs.

## Regression results and exact files

BEFORE: existing 34 unittest cases PASS; bridge integration PASS; three keyword-feedback checks PASS; Node background suite PASS. New audit contracts reproduce the defects against the saved baseline (11 tests, 12 failing subtests/assertions and 2 missing-query-interface errors). AFTER: existing 34 plus 11 new unittest cases PASS; bridge integration, keyword feedback and Node background suite PASS; all 24 original benchmark runs and 48 targeted runs complete and enforce budgets/no duplicate validations. Syntax/whitespace checks are recorded separately. No claim of browser UI verification is made.

Production files changed by this audit:

- `discovery/web_extract.py`: shared ID pattern, boundary validation, slash escaping and folder-path normalization.
- `discovery/extract.py`: consistent ID lengths and legacy relative-link/host boundaries.
- `discovery/engine.py`: normalized short seed, stored-queue and processed IDs.
- `discovery/pool.py`: normalized stored-edge deduplication and bounded wider evidence scan.
- `discovery/web_sources.py`: exact optional query plans, Bing keyword forwarding and expression deduplication.
- `filester_api.py`: preserve full query tuples and co-occurrence keywords.

Added target files: `test_discovery_audit.py`, `benchmark_discovery_audit.py`, and this `DISCOVERY_AUDIT.md`. Added evidence/helpers only under `artifacts/filester-discovery-audit/`: source snapshot/manifest, original working-tree status/HEAD, runtime package versions, test logs, JSON reports, `comparison.json`, `audit-changes.patch`, `changed_files.json`, `run_baseline.py`, `run_source_yield.py`, `build_report.py`, `final_checks.py` and check outputs. The patch is against the pre-task working tree, so it excludes pre-existing user edits. Neither original benchmark/experiment nor research baseline was changed.

## Next iteration

1. Add per-source query/request allocation and attempted-query telemetry; verify manual plans are not starved by concurrent archive collectors. Effort MEDIUM, regression risk MEDIUM.
2. Evaluate a gated collection-first policy on read-only captured real fixtures, including productive leaves, stale collections and sparse/dead descendants. Do not enable it solely from these synthetic gains. Effort MEDIUM, risk MEDIUM.
3. Unify CLI and API execution/budget semantics, repair misleading CLI FIFO/shuffle and ignored strategy behavior, and replace random disjoint-half A/B with identical offline replay. Effort MEDIUM, risk MEDIUM.
4. Profile normalized frontier scans on large stored graphs; preserve the 10,000-row scan cap and exclusions, then consider indexed normalized identities. Current malformed/duplicate rows can still crowd a very large capped frontier. Effort MEDIUM, risk LOW–MEDIUM.
5. Improve archive freshness/capability health with bounded probes; require measured new IDs and validated content before removing or widening source/mirror queries. Effort LOW–MEDIUM, risk LOW.

## Reproduction

From project root, use `extension/filester_search/.venv/Scripts/python.exe` (Python 3.12.10, httpx 0.28.1, FastAPI 0.142.2):

```powershell
& extension/filester_search/.venv/Scripts/python.exe artifacts/filester-discovery-audit/run_baseline.py --source-root extension/filester_search --label after
& extension/filester_search/.venv/Scripts/python.exe extension/filester_search/benchmark_discovery_audit.py --source-root extension/filester_search --output artifacts/filester-discovery-audit/audit-after.json
& extension/filester_search/.venv/Scripts/python.exe -m unittest discover -s extension/filester_search -p test_discovery_audit.py -v
& extension/filester_search/.venv/Scripts/python.exe artifacts/filester-discovery-audit/run_source_yield.py --source-root extension/filester_search --output artifacts/filester-discovery-audit/source-yield-after.json
```

The default wrapper run is offline. The recorded live sample used `--live` once; it should not be scheduled or repeated aggressively. BEFORE commands replace source-root with `artifacts/filester-discovery-audit/before_source`; the audit harness stays the same. Timing ranges and raw attempt/request lists are in the saved JSON.
