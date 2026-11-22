# 🤖 AI AGENT DEVELOPMENT BRIEF
## NexusPWC Multi-Source Discovery & Search Engine Overhaul

**Project**: NexusPWC_fresh_v2  
**Repository**: https://github.com/ervss/NexusPWC_fresh_v2  
**Scope**: Full-stack refactor of multi-source search, discovery, and results aggregation  
**Duration**: 6 weeks (4 phases)  
**Status**: PLANNING → PHASE 1 ACTIVE

---

## 📊 CURRENT STATE ANALYSIS

### Architecture
- **Frontend**: JavaScript/HTML dashboard (tests/quality_hunt_workbench_ui.cjs)
- **Backend**: Python FastAPI (app/search_engine.py, app/source_catalog.py)
- **Data Layer**: SQLite + FTS5 (app/database.py)
- **Integrations**: Playwright, aiohttp, BeautifulSoup, Telethon, curl_cffi

### Known Issues
1. **Code Quality**:
   - Duplicate method definitions (search_simpcity_async, search_pixeldrain_async defined twice)
   - Monolithic search_engine.py (3000+ lines, 40+ search methods)
   - No unified result schema → ranking/dedup inconsistent
   - Ad-hoc fallback logic per source

2. **Performance**:
   - Aggressive parallel execution (100+ concurrent tasks) → high latency
   - No result caching or batch dedup
   - Memory leaks in Playwright sessions
   - SQL transaction contention

3. **Coverage**:
   - Only 25 discovery sources (Erome, Kemono, XVideos, Pornhub, Bunkr, etc.)
   - Filester is "import only" — no search/discovery
   - No support for plugin-based extractors (MediaMatic, Racaty, Mediafire)
   - Single-threaded fallback search exhausts timeouts

4. **Testing**:
   - No regression tests for multi-source search
   - No deduplication tests
   - No ranking correctness tests
   - Manual test fixtures only

---

## 🎯 FOUR-PHASE DELIVERY PLAN

### PHASE 1: BUG FIXES + MULTI-SOURCE STABILITY (Week 1)
**Goal**: Rock-solid crawler on 5+ sites, zero crashes, no memory leaks

**Deliverables**:
1. **Fix Duplicate Methods**
   - Consolidate search_simpcity_async (2 definitions → 1)
   - Consolidate search_pixeldrain_async (2 definitions → 1)
   - Remove dead code, extract common fallback logic

2. **SQL & Memory Hardening**
   - Review app/database.py for transaction deadlocks
   - Add connection pooling (SQLAlchemy pool_size/max_overflow)
   - Fix Playwright session leaks (context managers, cleanup on error)
   - Add process-level resource monitoring

3. **Parallel Execution Throttling**
   - Cap concurrent tasks per source (currently unbounded)
   - Implement semaphores per domain
   - Add backpressure when result queue > threshold
   - Timeout per-source at 15s (configurable)

4. **Stabilize 5 Key Sources**
   - Erome, Bunkr, Kemono, Pixeldrain, GoFile
   - Add retry logic with exponential backoff
   - Log failures per source (HTTP 429/503/timeout)
   - Fallback: if direct source fails, use Yahoo/DDG

**Testing**:
- Run 20x sequential searches on each source
- Monitor peak memory, connection count
- Verify no orphaned processes/sockets

**Acceptance Criteria**:
- Zero crashes over 100 searches
- Peak memory < 500MB per source
- No pending sockets after search completes
- All 5 sources return ≥5 results 90% of the time

---

### PHASE 2: PLUGIN-BASED FILESTER DISCOVERY (Week 2-3)
**Goal**: 10x more sources via unified extractor framework

**Deliverables**:
1. **Unified Extractor Plugin System**
   - Create `app/extractors/base.py`:
     ```python
     class BaseExtractor:
         async def search(query: str, limit: int = 24) -> List[SearchResult]
         async def extract(url: str) -> FileMetadata
         def normalize(raw_item: dict) -> SearchResult
     ```
   - Define `SearchResult` contract (title, url, source, quality, size, duration, etc.)

2. **Filester Extractor**
   - `app/extractors/filester.py`: search + extract via Selenium/Playwright
   - Auto-detect: plagát (image), stream (video), metadata (json)
   - Cache auth cookies, rotate proxies if needed
   - Return normalized results

3. **MediaMatic, Racaty, Mediafire Extractors**
   - Similar structure, parallel development
   - Each in separate file under app/extractors/
   - Register in app/extractors/__init__.py

4. **Plugin Registry**
   - `app/extractor_registry.py`: auto-discover, load, manage lifecycle
   - Enable/disable per extractor
   - Track health (uptime, avg response time, error rate)

5. **Unified Discovery Endpoint**
   - `/api/search?query=X&sources=[filester,erome,bunkr]&limit=30`
   - Aggregates results from discovery (search_engine.py) + extractors
   - Single dedup + ranking pipeline

**Testing**:
- Unit tests for each extractor (mock HTTP, parse HTML)
- Integration tests: search filester + 1 other source, verify results
- Health check: each extractor responds in < 20s

**Acceptance Criteria**:
- Filester returns ≥10 results per query (vs. 0 today)
- MediaMatic, Racaty, Mediafire return ≥5 results each
- Plugin registry reports health for all 4 sources
- No search latency regression (total < 30s)

---

### PHASE 3: INTERACTIVE SEARCH + RESULTS UI (Week 2-3 parallel)
**Goal**: Modern dashboard, faceted search, inline preview, bulk actions

**Deliverables**:
1. **Faceted Search UI**
   - New page: `/search` with:
     - Query input + advanced filters:
       - Quality (4K / 1080p / 720p / SD)
       - Host/Source (Erome, Bunkr, Filester, etc.)
       - Size (< 1GB, 1-5GB, > 5GB)
       - Category (if metadata detected)
     - Real-time facet counts (e.g., "234 results, 45 in 4K")
   - Facet UI state saved to URL (shareable filters)

2. **Results Grid + Inline Preview**
   - Grid layout (4 columns, responsive)
   - Per result card:
     - Thumbnail (lazy-load, blur hash placeholder)
     - Title, source, quality badge, size
     - **Hover preview**: overlay with metadata (duration, resolution, uploader)
     - Quick-action buttons (View, Import, Add to Watchlist)

3. **Bulk Actions**
   - Multi-select checkbox per result
   - Bulk import (selected → library immediately or queue for later)
   - Bulk add to watchlist (re-check daily, auto-import if healthy)
   - Bulk copy URLs to clipboard

4. **Results Sorting**
   - Relevance (default, improved ranking)
   - Newest first
   - Highest quality
   - Largest size
   - Source (group by)

**Technology**:
- Frontend: Vue.js 3 or React (use existing dashboard framework)
- Icons: Feather or Font Awesome
- State management: Vuex or Redux
- API: existing FastAPI endpoints + new `/api/facets` endpoint

**Testing**:
- E2E: search → apply filters → verify result count changes
- E2E: multi-select + bulk import → verify library updated
- Performance: 1000 results grid loads in < 2s

**Acceptance Criteria**:
- Filters work without page reload
- Inline preview shows metadata within 500ms
- Bulk import of 100 results completes in < 5s
- UI responsive on mobile (≥320px width)

---

### PHASE 4: INTELLIGENT DEDUP + AUTO-IMPORT (Week 1-2)
**Goal**: No duplicates, auto-prioritization, scheduled background import

**Deliverables**:
1. **Perceptual Deduplication Engine**
   - `app/dedup_engine.py`:
     - Exact URL match (fast)
     - Fuzzy title match (Levenshtein distance > 0.9)
     - Image hash dedup (if thumbnails available, perceptual hash)
   - Merge duplicates: keep highest quality, mark others as "duplicate of X"

2. **Result Prioritization**
   - Score function:
     ```
     score = 0.4 * relevance + 0.3 * quality + 0.2 * freshness + 0.1 * source_health
     ```
   - Freshness: date found (newer = higher)
   - Source health: uptime % from PHASE 1 monitoring
   - Sort by score descending

3. **Watchlist + Scheduler**
   - UI: "Add to Watchlist" button on result
   - Watchlist table: query, last checked, status (pending/found/imported/dead)
   - Background job (cron): every 6h, re-run watchlist queries
   - Auto-import: if result found, passes health checks, import directly to library
   - Notification: "5 new items imported from watchlist"

4. **Import Queue**
   - `app/import_queue.py`: async task queue (Celery or simple SQLite queue)
   - Accept batch imports: [url1, url2, url3]
   - Process in background: extract metadata, validate, add to library
   - Status UI: % complete, failures, retry logic

5. **Library Health Tracking**
   - Track per-item: source health, last-checked date, error count
   - Auto-clean: items from dead sources marked "archived"
   - Dashboard: library stats (total items, by source, health %)

**Testing**:
- Unit: dedup engine merges 3 identical results → 1
- Unit: ranking function orders by score
- Integration: watchlist query → reimport after 6h
- Integration: batch import 100 URLs → library updated, queue status ✓

**Acceptance Criteria**:
- Dedup reduces 1000 raw results to 700 (30% duplicates removed)
- Top 10 results ranked by score, no low-quality items first
- Watchlist re-runs every 6h, auto-imports 5+ items per day
- Batch import queue never blocks UI (async)

---

## 🔧 TECHNICAL GUIDELINES FOR AGENT

### Code Organization
```
app/
├── search_engine.py           [REFACTOR in PHASE 1] Remove dupes, split into modules
├── search_sources/
│   ├── __init__.py
│   ├── base.py                [NEW] Abstract base for all sources
│   ├── direct_scrapers.py    [NEW] Erome, Kemono, XVideos, etc.
│   └── fallback_scrapers.py  [NEW] Yahoo, DDG, Reddit fallbacks
├── extractors/                [NEW in PHASE 2]
│   ├── __init__.py
│   ├── base.py                [NEW] BaseExtractor
│   ├── filester.py
│   ├── mediamatic.py
│   ├── racaty.py
│   └── mediafire.py
├── dedup_engine.py            [NEW in PHASE 4]
├── import_queue.py            [NEW in PHASE 4]
├── result_normalizer.py       [NEW in PHASE 1] Unified result schema
├── source_catalog.py          [EXISTING] Keep canonical source registry
└── database.py                [HARDENING in PHASE 1]

tests/
├── test_search_sources.py     [NEW] Unit + integration for all sources
├── test_extractors.py         [NEW] Each extractor tested in isolation
├── test_dedup.py              [NEW] Dedup correctness
├── test_ranking.py            [NEW] Ranking order validation
└── test_ui_search.py          [NEW] E2E for faceted search UI
```

### Coding Standards
- **Type hints**: All functions must have input/output types
- **Docstrings**: Google style, include exceptions
- **Error handling**: Never silently fail; log + report to caller
- **Testing**: Unit test coverage ≥ 80%, integration tests for all new APIs
- **Performance**: Benchmark new code; accept only if < 10% regression
- **Logging**: Use structured logging (JSON) for all events

### API Contract Examples

**Unified SearchResult**:
```python
@dataclass
class SearchResult:
    title: str
    url: str
    source: str  # e.g., "Erome", "Filester", "GoFile"
    quality: Optional[str]  # "4K", "1080p", "720p", "SD", None
    size: Optional[int]  # bytes
    duration: Optional[int]  # seconds
    thumbnail: Optional[str]  # URL
    metadata: dict  # Extra fields per source
    fetched_at: datetime
    score: float = 0.0  # Ranking score (PHASE 4)
```

**Search Endpoint** (existing, normalize results):
```python
GET /api/search?query=X&sources=erome,filester&limit=30
Response: {
    "results": [SearchResult, ...],
    "total": 150,
    "sources_queried": ["erome", "filester"],
    "sources_status": {"erome": "ok", "filester": "timeout"},
    "elapsed_ms": 3500
}
```

**New Facets Endpoint** (PHASE 3):
```python
GET /api/search/facets?query=X
Response: {
    "quality": {"4K": 45, "1080p": 120, "720p": 80, "SD": 10},
    "source": {"Erome": 100, "Filester": 80, "Bunkr": 75, ...},
    "size_buckets": {"<1GB": 50, "1-5GB": 120, ">5GB": 85}
}
```

### Git Workflow
- Work on **feature branches** per phase: `phase-1-stability`, `phase-2-extractors`, etc.
- Commit **atomically**: one feature/fix per commit, clear message
- PR template includes: phase, testing done, acceptance criteria met
- Code review: at least 1 approval before merge
- Merge to `master` only after all tests pass

### Testing Commands
```bash
# Unit tests only
pytest tests/ -k "not integration" -v

# Integration tests (slower, needs live services)
pytest tests/ -k "integration" -v --timeout=60

# Specific test file
pytest tests/test_search_sources.py -v

# Coverage report
pytest tests/ --cov=app --cov-report=html

# Performance benchmark
pytest tests/ --benchmark-only
```

### Local Development Setup
```bash
# Create venv
python3 -m venv venv
source venv/bin/activate

# Install deps
pip install -r requirements.txt
pip install -r requirements-dev.txt  # Testing, formatting, linting

# Run linter
black app/ tests/
flake8 app/ tests/ --max-line-length=120

# Run type checker
mypy app/ --ignore-missing-imports

# Run all tests
pytest tests/ -v --cov=app
```

---

## 📋 PHASE 1 CHECKLIST (Week 1)

- [ ] **Audit complete**: Identify all duplicate methods, unused code
- [ ] **Dedupe fixed**: search_simpcity_async, search_pixeldrain_async consolidated
- [ ] **Result normalizer written**: All search sources return unified SearchResult
- [ ] **Memory hardening**: Playwright sessions cleaned up, connection pooling enabled
- [ ] **Parallel throttling**: Semaphore per source, max 10 concurrent tasks
- [ ] **Tests added**: test_search_sources.py, 20 searches per source, memory profiling
- [ ] **Stability verified**: 100+ searches, zero crashes, peak memory < 500MB
- [ ] **PR merged**: Phase 1 complete, ready for Phase 2

---

## 🚀 PHASE 2-4 KICKOFF (After Phase 1 Approval)

Each phase has its own branch, checklist, and PR. Agent will:
1. Implement deliverables per spec
2. Add tests BEFORE shipping code
3. Document new APIs in code comments + README
4. Measure performance, log any regressions
5. Request code review, iterate on feedback

---

## 💬 COMMUNICATION

- **Status updates**: Every 3-4 days, comment on relevant PR/issue
- **Blockers**: Create issue immediately, tag @ervss
- **Design decisions**: Document in commit message or PR description
- **Questions**: Reference this brief + existing code, propose solution

---

## 🎓 CONTEXT FILES TO REVIEW FIRST

1. **Current search implementation**:
   - `app/search_engine.py` (3071 lines) — main aggregator
   - `app/source_catalog.py` (265 lines) — source registry

2. **Database schema**:
   - `app/database.py` — Video model, FTS5 index

3. **Existing tests** (learn patterns):
   - `tests/test_quality_hunt_regressions.py`
   - `tests/test_quality_hunt_search_identity.py`

4. **UI reference** (current dashboard):
   - `tests/quality_hunt_workbench_ui.cjs`

5. **API routes** (FastAPI):
   - Find `@app.get("/api/search")` in `app/main.py` or similar

---

## ✅ DONE = SHIPPED TO PRODUCTION

Each phase is "done" only when:
- All acceptance criteria met
- Tests pass locally + CI/CD
- No performance regression
- Code reviewed + approved
- Deployed to staging, verified working
- User-facing feature (if any) tested in browser

---

**Agent Role**: Full-stack developer with access to codebase, tests, and deployment pipeline.  
**Start Here**: Review Phase 1 checklist, audit app/search_engine.py, create feature branch.

Good luck! 🚀
