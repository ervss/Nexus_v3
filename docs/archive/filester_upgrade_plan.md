You are the lead coding agent working directly inside the NexusPWC_fresh_v2 repository.

Your objective is NOT to blindly execute a roadmap or perform a broad cosmetic refactor.

Your objective is to inspect the real codebase, identify the highest-leverage causes limiting Filester and multi-source discovery, implement the best evidence-based solution, verify it rigorously, and leave the repository in a measurably better and stable state.

You have permission to inspect files, edit code, create tests and benchmark tooling, run commands, run the application locally, and iterate on failures without asking for routine approval.

Work autonomously until the task reaches a defensible final state.

---

# 0. IMPORTANT CONTEXT AND PRIORITY

Read `AGENT_BRIEF.md` first.

Treat it as:

- strategic context
- project direction
- known-problem inventory
- architectural background

Do NOT treat every proposed implementation detail inside it as mandatory architecture.

Any proposed technology or implementation in the brief — SQLAlchemy, React/Vue, Celery, plugin architecture, specific scoring weights, fixed result counts, etc. — is a hypothesis, not a requirement.

Inspect the actual repository first.

Preserve working architecture unless measurements and code evidence justify changing it.

Avoid unnecessary framework migrations and unrelated refactors.

The highest priority for this task is DISCOVERY YIELD + STABILITY, especially Filester discovery.

---

# 1. PRIMARY BUSINESS / ENGINEERING GOAL

Improve the search/discovery system so it finds significantly more useful, unique, valid content with:

- equal or lower network cost where possible
- lower duplicate waste
- controlled concurrency
- stable memory/resource usage
- reproducible behavior
- no regression of existing Nexus functionality

The main KPI is NOT:

"number of supported sources"

The main KPI is:

USEFUL DISCOVERY YIELD.

Measure things such as:

- unique useful candidates per 100 requests
- CONTENT results per validation budget
- useful results per second
- time to first useful result
- duplicate rate
- request cost per useful result
- error/deferred rate
- discovery depth
- source contribution

More requests alone do NOT count as an improvement.

---

# 2. CRITICAL EXISTING LEAD TO VERIFY FIRST

A previous audit identified a potentially high-value issue in the existing Filester discovery path:

- `parse_html` already extracts `outbound_folders`
- `ValidatedFolder` appears not to propagate them
- `pool.validate_one()` appears to discard them
- therefore parent/child/related folder IDs discovered during validation may never enter the next discovery/validation stage

DO NOT assume this diagnosis is automatically correct.

Trace the current implementation and confirm it yourself.

If confirmed, treat it as a root-cause candidate with very high priority.

The desirable conceptual behavior is:

seed candidate
→ validate page
→ parse folder
→ extract outbound/related folder IDs
→ deduplicate
→ persist provenance
→ add unseen candidates to discovery frontier
→ prioritize
→ validate within remaining budget
→ repeat safely

This should produce bounded graph/snowball discovery rather than only first-layer discovery.

---

# 3. FIRST ACTION: REPOSITORY AUDIT

Before making substantial edits, inspect the repository.

At minimum review:

- `AGENT_BRIEF.md`
- `app/search_engine.py`
- `app/source_catalog.py`
- `app/database.py`
- `app/main.py`
- Filester-specific code
- discovery-related modules
- crawler modules
- index/search modules
- network/rate-limit modules
- bridge/API code
- extension integration
- Nexus integration
- benchmark / metrics code
- relevant tests

Also inspect Git status.

Do not overwrite unrelated local work.

Record the initial state.

If Git is available, create a safe checkpoint or feature branch before major edits unless an existing suitable working branch already exists.

Do not merge to master automatically.

---

# 4. MAP THE REAL CURRENT PIPELINE

Produce an internal technical map of the actual runtime flow.

Trace:

query
→ source selection
→ external collectors/search
→ result/candidate extraction
→ candidate normalization
→ DB persistence
→ prioritization
→ validation
→ HTML/JSON parsing
→ outbound/related ID extraction
→ classification
→ dedup
→ result storage
→ API aggregation
→ UI exposure

Also determine how the existing local search/index participates.

Identify:

- where candidates are created
- where they are deduplicated
- where they are prioritized
- where requests are spent
- where duplicates can survive too long
- where transient failures become permanent state
- where pagination/cursor state is stored or lost
- where useful related IDs are dropped
- where concurrency can duplicate work

Do not begin a large rewrite until this path is understood.

---

# 5. ESTABLISH A CLEAN BASELINE

Before changing behavior, run the existing relevant tests.

Do not silently ignore failures.

Record:

- command
- passed
- failed
- skipped
- duration
- environment-specific warnings

Distinguish:

A. real application regressions

from:

B. external-environment failures such as blocked network endpoints, sandbox HTTP 403, unavailable third-party services, credentials, etc.

Where possible run existing:

- network tests
- bridge/API tests
- search tests
- discovery tests
- database tests
- regression tests
- JS/frontend tests relevant to the changed paths

Do not weaken tests to obtain green output.

---

# 6. BUILD A REPRODUCIBLE DISCOVERY BENCHMARK

Live internet testing alone is not sufficient.

Create or improve a deterministic benchmark harness using a simulated/fake transport where appropriate.

OLD and NEW implementations must be tested against the SAME controlled dataset.

The simulated world should be capable of representing:

- content folder
- empty folder
- collection/hub
- parent folder
- child folder
- related folder
- duplicate IDs
- multiple source provenance
- cyclic relationships
- dead URL
- HTTP 404
- HTTP 429
- HTTP 503
- timeout
- transient error
- pagination
- rate limiting
- delayed response
- repeated source result
- collection → folder graph expansion

Example graph condition that MUST be tested:

A → B
B → C
C → A

The system must discover useful nodes without infinite traversal.

Also include graphs where the highest-value content is only reachable after depth 2+.

The purpose is to test actual discovery intelligence, not simply first-page scraping.

---

# 7. FIX FILSTER GRAPH / SNOWBALL DISCOVERY IF CONFIRMED

If the outbound-folder loss is confirmed, fix it cleanly.

Requirements:

### 7.1 Data flow

Do not rely on hidden global state.

Validation/parsing should return enough structured information for the discovery layer to make decisions.

Carry outbound relationships through a typed/explicit result model.

### 7.2 Provenance

Preserve why a candidate exists.

Examples:

- existing_index
- wayback
- urlscan
- commoncrawl
- direct_search
- collection
- parent
- child
- related
- outbound
- snowball

Use existing project terminology if a provenance model already exists.

A candidate discovered independently from multiple sources should preserve that signal.

### 7.3 Dedup before network spend

Never spend another validation request merely because the same folder ID was discovered twice.

Normalize IDs consistently.

Check:

- current job frontier
- currently validating
- already validated in job
- persisted candidate state
- existing indexed results

before scheduling duplicate work.

### 7.4 Cycle prevention

Graph traversal must not loop.

A → B → A must terminate.

### 7.5 Budget control

Snowball expansion must respect:

- validation budget
- network budget where applicable
- source limits
- cancellation
- job lifecycle

Do not turn one discovered folder into an uncontrolled crawler.

### 7.6 Depth

Do not hardcode depth=1 if deeper traversal yields useful content.

But do not allow unbounded expansion.

Use a bounded frontier/budget-driven design.

---

# 8. REVIEW CANDIDATE PRIORITIZATION

Inspect the existing priority/order logic.

Improve it only if the evidence supports doing so.

Useful signals may include:

- unseen candidate
- multiple independent sources
- discovered from confirmed CONTENT
- discovered from confirmed COLLECTION
- graph relationship confidence
- source reliability
- freshness where meaningful
- prior transient failure
- already indexed state
- duplicate probability
- discovery depth
- prior successful neighborhood

Keep the scoring transparent and deterministic.

Do NOT build unnecessary ML.

Do NOT blindly use fixed weights from `AGENT_BRIEF.md`.

If introducing a scoring formula:

- document each signal
- justify weights
- test deterministic ordering
- compare yield against the old ordering

A priority system is successful only if it increases useful yield for the same or lower budget.

---

# 9. REVIEW DISCOVERY SOURCES

Inspect the real collectors currently present.

Pay attention to any implementation for:

- Wayback/CDX
- urlscan
- Common Crawl
- local index
- search engine fallback
- other archival/index discovery mechanisms

Look for:

- repeated identical queries
- duplicate pages
- duplicate candidate extraction
- wasted pagination
- cursor loss
- rescanning old windows
- request storms
- retries without backoff
- shared cooldown bugs
- incorrect timeout handling
- unnecessary browser automation

Improve only what is supported by evidence.

Where appropriate implement:

- persistent cursor/checkpoint
- incremental scanning
- bounded retries
- adaptive/exponential backoff
- host-specific cooldown
- source-specific timeout
- request dedup
- pagination dedup

Never hammer external services.

---

# 10. DO NOT DEFAULT TO PLAYWRIGHT / SELENIUM

Before creating a new Filester Playwright/Selenium extractor, determine whether the existing HTTP/parser/discovery path can deliver better yield more cheaply and reliably.

Prefer this order:

1. existing structured data/API
2. direct HTTP
3. archive/index sources
4. parsed HTML
5. browser automation only when required

Browser automation is acceptable when truly necessary.

If Playwright is required:

- reuse sessions safely
- close contexts/pages
- clean up on exception
- prevent orphaned processes
- limit concurrent browser work
- measure memory

---

# 11. CONCURRENCY AND RESOURCE CONTROL

Audit current concurrency.

The AGENT_BRIEF reports very aggressive parallelism; verify the actual current state rather than assuming the documented number is still accurate.

Check:

- asyncio task count
- per-domain concurrency
- Playwright process count
- HTTP client lifecycle
- socket cleanup
- semaphores
- cancellation
- background jobs
- DB concurrency
- transaction boundaries

Concurrency should maximize throughput without causing:

- duplicate work
- rate-limit amplification
- memory spikes
- SQL contention
- timeout cascades
- orphaned tasks

Prefer per-source / per-host limits.

Backpressure is preferable to unlimited fan-out.

Do not choose a concurrency number because the brief suggested one.

Benchmark candidate values.

---

# 12. SQLITE / DATABASE SAFETY

Inspect actual SQLite usage before changing database technology.

Review:

- WAL mode
- synchronous mode
- connection sharing
- `check_same_thread`
- async/thread interactions
- transaction lifetime
- read/write contention
- indexes
- write frequency
- bulk insert opportunities

Do NOT introduce SQLAlchemy or connection pooling merely because `AGENT_BRIEF.md` proposed it.

Only introduce an abstraction change if measurement demonstrates a real benefit.

Prefer minimal hardening of the existing DB layer if sufficient.

Ensure collector + validator activity cannot corrupt or inconsistently update:

- candidates
- jobs
- results
- source state
- bridge results
- history
- collections

---

# 13. RESULT NORMALIZATION

Inspect how heterogeneous source results are currently represented.

If inconsistent schemas materially complicate:

- ranking
- dedup
- API aggregation
- UI behavior

then introduce the smallest viable normalized result contract.

Reuse existing project structures where possible.

Do not refactor every source simply for aesthetic consistency.

The normalized model should support only fields the real project needs.

Possible fields:

- canonical URL
- title
- source
- source-specific ID
- media/file type
- quality
- size
- duration
- thumbnail
- discovered_at
- provenance
- metadata
- score

Make optional fields genuinely optional.

Do not require every source to synthesize metadata it does not possess.

---

# 14. DEDUPLICATION

Deduplication quality must be measured against truth, not against a target percentage.

Do NOT implement acceptance criteria such as:

"remove exactly 30% of results"

Instead test:

- true duplicates merge
- unique results remain separate
- normalized URLs dedup correctly
- same folder discovered from multiple sources preserves provenance
- title similarity alone does not incorrectly merge unrelated content
- duplicate suppression occurs early enough to save requests

Start with reliable cheap signals.

Use fuzzy/perceptual matching only where justified.

Avoid expensive image hashing unless it creates measurable value for the real workflow.

---

# 15. FAILURE CLASSIFICATION

Review how the current system classifies:

- DEAD
- ERROR
- timeout
- deferred
- blocked
- throttled
- challenge
- empty
- collection
- content

Transient failure must NOT automatically become permanent DEAD.

Examples:

- timeout
- HTTP 429
- temporary HTTP 503
- network reset

should generally be retryable/deferred according to policy.

Permanent failure should require stronger evidence.

Add tests.

---

# 16. JOB LIFECYCLE / RESTART SAFETY

Preserve and improve current job persistence behavior.

Verify:

- start
- progress
- completion
- failure
- cancellation
- restart/interruption

No task should silently disappear.

Cancellation should actually stop child work.

Locks/semaphores/resources must be released.

Restarted server state should not claim interrupted work completed successfully.

Existing notes, favorites, collections, opened history, search history and bridge job behavior must not regress.

---

# 17. API AND EXTENSION COMPATIBILITY

Preserve existing API contracts unless changing them is absolutely necessary.

If a change is necessary:

- maintain backward compatibility if reasonably possible
- document it
- add tests
- update callers in the same change

Do not break:

- browser extension
- Nexus dashboard
- bridge integration
- import workflows
- local index/search
- saved history
- notes/favorites
- collections

Do not rebuild the UI framework during this task.

Frontend changes should be minimal and directly tied to exposing or verifying new discovery behavior.

---

# 18. TESTS TO ADD

At minimum add regression coverage for the following where applicable:

1. parser returns outbound folders

2. validation result preserves outbound folders

3. outbound folders become candidates

4. unseen snowball candidates enter the frontier

5. discovered snowball candidates are actually validated

6. A → B → A does not loop

7. A → B → C discovers C within available budget

8. duplicate IDs do not cause duplicate validation requests

9. multiple provenance sources are preserved

10. validation budget is respected

11. cancellation stops expansion

12. transient timeout does not become permanent DEAD

13. 429 behavior respects cooldown/backoff

14. source rate limits remain isolated where appropriate

15. persisted cooldown survives restart if designed to persist

16. candidate priority is deterministic

17. useful graph neighbor outranks low-value duplicate where intended

18. collector + validator concurrency does not double-process the same candidate

19. job persistence remains valid

20. API output remains compatible

21. existing index results remain accessible

22. bridge results remain correct

23. no regression of existing notes/favorites/history/collections

Use deterministic mocks/fakes for network-sensitive unit tests.

Live integration tests may exist separately.

---

# 19. OLD VS NEW BENCHMARK

This is mandatory.

Do not finish with only "tests pass".

Compare OLD vs NEW behavior on identical workloads.

Use:

- same dataset
- same seed queries
- same candidate pool
- same network/request budget
- same validation budget
- same timeout configuration
- same rate limits

Report at minimum:

| Metric | OLD | NEW | Delta |
|---|---:|---:|---:|
| Unique candidates | | | |
| New candidates | | | |
| Validated | | | |
| CONTENT | | | |
| COLLECTION | | | |
| Snowball candidates | | | |
| Snowball CONTENT | | | |
| Max discovery depth | | | |
| Duplicates suppressed | | | |
| Network requests | | | |
| Requests / CONTENT | | | |
| Deferred/transient errors | | | |
| Permanent DEAD | | | |
| Time to first CONTENT | | | |
| Total runtime | | | |

Interpret the result.

For example:

+40% CONTENT with +80% requests

is not automatically a good result.

+30% CONTENT with equal requests

is much more interesting.

The goal is efficiency, not brute force.

---

# 20. PERFORMANCE AND RESOURCE BENCHMARKS

Where technically practical measure:

- wall-clock time
- request count
- peak process memory
- browser process count
- HTTP connection count
- pending tasks after completion
- DB transaction/query hotspots

Do not invent values when the environment prevents reliable measurement.

Label limitations honestly.

---

# 21. ITERATE, DO NOT STOP AT FIRST FAILURE

Your workflow should be:

inspect
→ baseline
→ hypothesis
→ minimal implementation
→ tests
→ benchmark
→ inspect regressions
→ fix
→ rerun
→ simplify where possible
→ final verification

Do not stop after writing code.

Do not stop after one passing unit test.

Do not declare success from static inspection alone.

---

# 22. AVOID THESE FAILURE MODES

Do NOT:

- rewrite the entire project
- migrate frontend frameworks
- replace SQLite without evidence
- introduce Celery without need
- introduce SQLAlchemy simply because the brief mentions it
- add proxies/cookie rotation without an explicit real requirement
- increase concurrency just to improve headline runtime
- weaken tests
- delete failing tests
- hide errors
- fake benchmark results
- hardcode expected production result counts
- mark blocked sandbox requests as application failure
- call a feature complete without running it
- optimize for LOC written
- refactor unrelated modules
- duplicate existing mechanisms under new names

Prefer the smallest coherent architecture that achieves the measurable goal.

---

# 23. CODE QUALITY

For changed/new code:

- use type hints where they materially help
- keep functions understandable
- document non-obvious algorithms
- log actionable failures
- avoid silent `except`
- avoid global mutable state when a scoped object/state model is better
- preserve current naming conventions
- keep compatibility with the current supported Python/JS environment

Do not perform mass formatting of unrelated files.

---

# 24. COMMITS / CHECKPOINTS

If Git is available and the working tree permits it, keep changes logically separated.

Suggested checkpoints:

1. baseline / benchmark harness
2. outbound propagation
3. frontier / priority / dedup
4. network/source reliability
5. regression tests
6. final cleanup

Do not rewrite unrelated history.

Do not merge automatically.

---

# 25. SUCCESS CRITERIA

A successful solution should demonstrate most of the following:

- confirmed root cause(s), not guesses
- snowball graph discovery works if appropriate
- useful outbound IDs are no longer discarded
- dedup happens before unnecessary network spend
- graph cycles are bounded
- budgets are respected
- transient failures remain retryable
- concurrency is controlled
- existing workflows remain intact
- tests cover new behavior
- OLD vs NEW benchmark demonstrates measurable improvement
- no significant unexplained performance regression
- architecture remains understandable

If the benchmark shows the proposed architecture is worse, do not hide it.

Investigate and adjust.

If the original hypothesis is wrong, say so and pursue the next highest-value cause discovered from the code.

---

# 26. FINAL VERIFICATION

Before finishing:

Run the relevant full test suite again.

Check Git diff carefully.

Look specifically for:

- debug leftovers
- accidental secrets
- hardcoded local paths
- generated junk
- duplicated implementations
- temporary benchmark data
- unintended API changes
- disabled tests

Ensure `.env`, cookies, API keys and credentials are not added to Git.

---

# 27. FINAL REPORT FORMAT

When the work is complete, respond with EXACTLY these sections:

## 1. Executive Summary

What materially improved.

## 2. Root Causes Confirmed

For each:
- evidence
- affected code path
- impact

## 3. Architecture Before

Concise current/old discovery flow.

## 4. Architecture After

Concise new discovery flow.

Include snowball/frontier behavior if implemented.

## 5. Changed Files

For every changed or new file:
- path
- purpose
- significant behavior change

## 6. Tests

For every relevant test command:
- command
- passed
- failed
- skipped
- duration if available

Clearly separate environment/network limitations from code failures.

## 7. OLD vs NEW Benchmark

Provide the comparison table.

## 8. Performance Interpretation

Explain:
- yield
- request efficiency
- latency
- duplicate reduction
- resource behavior

Do not merely repeat numbers.

## 9. Compatibility Check

State status of:
- Nexus UI
- extension
- API
- DB
- bridge
- history
- notes/favorites
- collections

## 10. Known Limitations

Only real remaining limitations.

## 11. Highest-Value Next Steps

Maximum 5.

For each provide:
- expected benefit
- regression risk
- effort: LOW / MEDIUM / HIGH

Do not begin those additional projects unless required for this task.

## 12. Final Status

Use exactly one:

READY

READY WITH KNOWN LIMITATIONS

NOT READY

Only use READY if:

- relevant tests pass
- benchmark confirms the intended improvement
- no material known regression remains

---

# 28. START NOW

Start with:

1. inspect `AGENT_BRIEF.md`
2. inspect Git status and repository structure
3. locate the complete current Filester/discovery path
4. verify or falsify the `outbound_folders` propagation issue
5. run baseline tests
6. establish OLD benchmark
7. only then begin implementation

Do not stop after the audit.

Proceed through implementation, testing, benchmarking and final verification autonomously.