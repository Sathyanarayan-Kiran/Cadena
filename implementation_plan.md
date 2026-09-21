# Implementation Plan and Delivery Record

This document records the delivered pilot architecture and subsequent implementation increments. Codex-authored delivery records are kept above the original Gemini Epic 3 plan so ownership and current status are explicit.

## Codex master-backlog consolidation — 2026-09-21

> **Attribution boundary:** Everything in this section was reviewed and consolidated by **Codex** from `cadena-master-epics-and-user-stories.md` on 2026-09-21. The source document is retained unchanged; the canonical, non-conflicting result lives in `Backlog.md` and `backlog.json`.

**Status:** Complete. The canonical backlog moves from **16 epics / 56 stories** to **20 epics / 71 stories**. Delivery status remains **23 done / 7 partial**; all newly introduced scope is explicitly not started.

### Consolidation method

The new document presents ten “master” epics numbered 1–10, but those identifiers collide with the platform's original Epic 1–10 and several of its stories repeat capabilities already introduced by the earlier research expansion. Appending it literally would have produced two incompatible Epic 1s and credited duplicate requirements as net-new scope.

Codex therefore used the existing backlog as the canonical identity system:

- Preserve every original epic and story id, implementation status and acceptance criterion.
- Merge richer criteria into an existing story when the user outcome is the same.
- Add a new story only when the requested outcome cannot be accepted by an existing story.
- Add a new epic only when the capability has no coherent existing epic home.
- Record the source, baseline, additions and expansions as machine-readable delta metadata so the generated status page can prove how its totals changed.

### Delta added by Codex

#### Four new epics

- **E17 — Connector, mapping & ingestion automation:** native connector/entity discovery, visual mappings with a constrained JS/TS sandbox, scheduled JQL/WIQL/encoded-query triggers, and governed historical backfill.
- **E18 — Cross-organization federation & proxy identity:** invitation-based independent node pairing and project-scoped proxy credentials separated from console identity.
- **E19 — Configuration lifecycle & simulation:** draft/published versions, visual diffs, rollback and non-destructive dry runs.
- **E20 — In-context synchronization experience:** a Chrome/Edge ticket panel with twin status and RBAC-gated resync/unlink actions.

#### Fifteen genuinely new stories

- Added to existing epics: **US9.5**, **US10.7**, **US10.8**, **US11.3**, **US16.4**, **US16.5**.
- Added under E17–E20: **US17.1–US17.4**, **US18.1–US18.2**, **US19.1–US19.2**, **US20.1**.

#### Nine existing stories expanded rather than duplicated

- **US13.1:** validates target-required fields and logs invalid lifecycle jumps.
- **US13.2:** immutable correlation now covers one-to-many and many-to-one trees.
- **US13.4:** comment privacy now includes direction, role filtering and author attribution.
- **US14.1:** explicit bidirectional HTML/ADF/wiki round trips and active-content sanitization.
- **US14.2:** direction, MIME and size governance for media.
- **US15.1:** default similarity threshold, score evidence and consolidation recommendation.
- **US15.2:** hostname/IP/error-code extraction with CMDB evidence.
- **US15.3:** policy-controlled low-risk auto-approval alongside high-risk CAB routing.
- **US16.1:** jittered exponential backoff and operational rate-limit telemetry.

The master story for workflow closure is already fully represented by **US13.1** and **US13.5**, so it did not create another story. This is the kind of semantic de-duplication the consolidation was intended to preserve.

### Delivery ledger changes

- Added `latest_delta` to `implementation-status.json`, recording the source document, date, 16/56 baseline, 20/71 current totals, four added epic ids, fifteen added story ids and nine expanded story ids.
- Added `addedIn` and `expandedIn` markers without changing any implementation status.
- Extended `scripts/build-tracker.mjs` to validate that delta metadata against the canonical backlog before generating.
- Added a fifth headline tally, a dated consolidation callout, **NEW MASTER** / **EXPANDED** badges, and a **Latest master delta** filter to `public/status.html`.
- Added tracker regression coverage proving the arithmetic, ids and source attribution cannot silently drift.

### Files updated by Codex

- `Backlog.md`
- `backlog.json`
- `implementation-status.json`
- `scripts/build-tracker.mjs`
- `public/status.html` (generated)
- `test/tracker.spec.ts`
- `README.md`
- `implementation_plan.md`

### Verification result

- JSON/backlog consistency: **PASS — 20 epics, 71 stories, 71 status entries, no missing or orphaned ids**
- Tracker generation: **PASS — current page includes the dated delta and all 71 stories**
- Focused tracker/backlog tests: **PASS**
- Full non-browser regression: **PASS — 28 files, 93 tests**
- `npm run build`: **PASS**
- Generated `status.html` JavaScript parse and required delta-content check: **PASS**
- `git diff --check`: **PASS**

### Deliberate boundaries

- This increment consolidates requirements; it does not claim implementation of the new master-backlog capabilities.
- The original master document is not renamed or rewritten. Its local Epic 1–10 numbering remains source context only, while E1–E20 in the canonical backlog remains authoritative for delivery tracking.
- The in-app browser had no available backend in this session, so visual click-through QA of `status.html` was not possible. The generated JavaScript parses, the delta content is explicitly asserted, and model/drift behaviour is covered by `test/tracker.spec.ts`.

---

## Codex reliability and review hardening update — 2026-09-20

> **Attribution boundary:** Everything in this section was implemented by **Codex** after reviewing commit `ebc53c2`. It records the corrective work separately from the earlier Gemini baseline and the feature increments below.

**Status:** Complete. All four review findings are fixed and protected by automated regressions; the generated delivery tracker and browser suite are current.

### Why this pass came before another feature

Persistence, notifications and reliable consumption were individually covered, but their interaction exposed failure modes that happy-path story tests did not: tenant checks stopped at the DLQ list endpoint, bootstrap upserts reverted persisted configuration, simultaneous deliveries could both execute a consumer, and process-local SLA suppression forgot every prior notification on restart. Those defects affect trust in the platform foundation, so they were corrected before taking on another backlog slice.

### Scope delivered by Codex

#### Tenant-safe dead-letter operations

- `GET /dlq/:id`, replay and discard now carry the authenticated `x-org-id` into the service and query by both entry id and tenant.
- Cross-tenant probes return `404`, including replay attempts containing a replacement payload, so an entry cannot be discovered or modified through its UUID.
- List and depth remain tenant-scoped and expose no global or untenanted failure metadata.
- **Follow-up review remediation (2026-09-21).** `DeadLetterService.list()` and `depth()` still accepted an optional tenant and fell back to global scope when it was omitted. No caller did so, but that is the same shape as the defect just fixed on `get`/`replay`/`discard` and would have become reachable with a second caller. Both now take the tenant as a required argument, making the guarantee structural rather than conventional.
- **Untenanted dead letters are logged (2026-09-21).** Removing `untenanted_total` was correct — a global failure count handed to every tenant leaks cross-tenant operational signal — but it left an unresolvable-tenant event absent from every view with nothing recording that it happened. Such an event is now logged at dead-letter time, covered by `test/review-regressions.spec.ts`. This reduces the gap from silent to observable; it does not close it, and the platform-operator surface remains unbuilt by choice.
- Tenant resolution used by the event store and dead-letter writer now shares one implementation, including the work-item fallback for envelopes whose payload omitted `org_id`.

#### Atomic consumer idempotency and crash recovery

- Replaced the read-then-handle idempotency check with an atomic `processing` claim in `event_consumptions`. Two concurrent deliveries now produce one `processed` result and one `skipped_duplicate`, with the handler running once.
- Failed claims remain eligible for retry and operator replay can deliberately reclaim a settled event.
- On application startup, abandoned `processing` rows are returned to `failed`. PGlite is a single-process datastore, so those rows can only belong to the process that stopped; this avoids turning a crash between claim and completion into permanent suppression.

#### Durable SLA emission suppression

- Added `sla_emissions`, keyed by work item, state, state-entry timestamp and event kind.
- Warning, breach and escalation paths atomically claim an emission before publishing. A new engine instance therefore cannot produce fresh event ids and duplicate notifications for a state entry already handled before restart.
- The same claim also prevents overlapping aging ticks from emitting twice.

#### Insert-only pilot configuration

- Extracted supporting defaults into `seedPilotConfiguration`, making restart behaviour independently testable.
- Notification preferences, the team escalation target, monitoring settings and Service records are now created only when absent. Curated channel addresses, monitoring thresholds, ownership, CMDB source and service metadata survive every subsequent startup.
- Re-running the seed remains idempotent: three pilot people and two Services stay three and two.

#### Browser and documentation closure

- Extended the headless-Chrome suite from seven to nine scenarios with working Flow Metrics and Dead Letters views, including metric coverage text, window changes, DLQ depth and status filtering.
- Corrected the README production boundary that still described dead-lettering as unfinished Epic 5 work.
- Added the previously missing Codex delivery records for the research-derived backlog expansion and generated implementation tracker.
- Regenerated `public/status.html`: **16 epics, 56 stories — 23 done, 7 partial, 26 not started — across 29 spec files including browser QA**. No story status changed during this hardening pass.

### Regression coverage added by Codex

- `test/review-regressions.spec.ts` (6 tests): cross-tenant DLQ read, replay/edit and discard rejection; tenant-scoped list/depth; SLA suppression across a fresh engine instance; and preservation of customised persisted configuration across repeated pilot seeding.
- `test/us5.spec.ts` now has 10 tests, adding simultaneous-delivery proof and abandoned-claim recovery.
- `test/ui-smoke.spec.ts` now has 9 browser scenarios, adding Flow Metrics and Dead Letters.

### Files added by Codex

- `src/bootstrap/pilot-configuration.ts`
- `src/modules/events/tenant-resolution.ts`
- `test/review-regressions.spec.ts`

### Primary files updated by Codex

- `src/database/database.service.ts`
- `src/modules/events/consumer-registry.service.ts`
- `src/modules/events/dead-letter.controller.ts`
- `src/modules/events/dead-letter.service.ts`
- `src/modules/events/event-store.service.ts`
- `src/modules/sla/aging-engine.service.ts`
- `src/server.ts`
- `test/us5.spec.ts`
- `test/ui-smoke.spec.ts`
- `README.md`
- `public/status.html`
- `implementation_plan.md`

### Verification result

- `npm run build`: **PASS**
- Focused hardening suites: **PASS — 2 files, 16 tests**
- Full non-browser regression: **PASS — 28 files, 92 tests**
- Headless-Chrome suite: **PASS — 1 file, 9 tests**
- Tracker generation: **PASS — 16 epics, 56 stories; generated page current**
- `git diff --check`: **PASS**

### Deliberate boundaries

- The in-process bus is still not a transactional outbox or durable broker. This pass makes each consumer claim reliable within the embedded single-process architecture; US5.1 and US5.4 remain partial/deferred as already recorded.
- Events with no resolvable tenant are excluded from tenant APIs. A future platform-operator surface needs its own authorization model before it can expose those failures.
- Channel transports remain stubs. This pass prevents duplicate delivery records and repeat routing after restart; it does not add SES, Slack or Microsoft Graph.

---

## Codex Epic 5 reliable consumption update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20. The earlier Codex records and the original Gemini plan remain below as prior-history sections.

**Status:** US5.2, US5.3 and US5.5 implemented and covered by `test/us5.spec.ts`. US5.1 remains partial and US5.4 was deliberately deferred.

### Why this came next

The platform had exactly one real event consumer, and it caught its own errors and logged them. A persistent fault produced a log line nobody reads and a notification nobody received: no retry, no record, no recovery path. With a durable event stream and a datastore that now survives a restart, the missing piece was reliable consumption on top of them.

### Scope delivered by Codex

- Added `EventConsumerRegistry`, which wraps every registered consumer with idempotency, retry and dead-lettering. Consumers remain ordinary async functions and no longer carry that logic themselves.
- Added `event_consumptions`, keyed on (consumer, event_id), so a redelivery is a no-op for that consumer while leaving others free to process the same event. That per-consumer scoping is what US5.2 actually asks for; a global seen-set would have been wrong.
- Added `dead_letter_events` and `DeadLetterService`: an exhausted event is stored with its full envelope, attempt count and last error, and a `DeadLetterQueueAlert` is published carrying the current depth.
- Added `GET /dlq`, `GET /dlq/depth`, `POST /dlq/:id/replay` and `POST /dlq/:id/discard`.
- Added a **Dead letters** view to the workspace showing each entry with its payload in an editable box, so an operator can correct a malformed event and re-inject it.
- Migrated `NotificationService` onto the framework, removing its internal error-swallowing.

### Design decisions

- **Idempotency is per consumer, not global.** Two consumers must both see an event; only a repeat delivery to the *same* consumer is a no-op.
- **Replay preserves identity.** A corrected event keeps its original `event_id` and is re-dispatched only to the consumer that failed. Issuing a new id would break the audit trail, and republishing to the bus would re-trigger consumers that had already succeeded.
- **A failed replay stays queued.** It updates the existing entry's attempts and error rather than resolving or duplicating it, so nothing is lost by trying.
- **Dispatch never throws into the publisher.** A consumer failure surfaces through the queue, not as an exception in the aging tick or webhook handler that happened to publish the event.
- **The production consumer was migrated deliberately.** A framework proven only against test doubles proves little; the 12 existing notification tests passing unchanged is the evidence that the contract holds for real code.

### Deferred: US5.4

Asynchronous HTTP 202 ingestion changes the response contract that ten Epic 6 and Epic 7 tests assert against. It deserves its own slice with a considered migration — most likely opt-in per request so existing integrations keep their synchronous contract — rather than being smuggled in beside a consumer framework.

### Verification added by Codex

- `test/us5.spec.ts` (8 tests): once-per-consumer processing with redelivery as a no-op; a transient failure retried to success without dead-lettering; exhaustion producing a queue entry with payload, attempts and error plus a depth alert; corrected-payload replay clearing the entry while preserving the event id; a failed replay staying queued; discard removing an entry from depth; rejection of replaying a discarded entry and of an unknown id; and confirmation that the production notification consumer is registered through the framework.
- Full regression: the 12 notification tests pass unchanged after migration.

### Files added by Codex in this increment

- `src/modules/events/consumer-registry.service.ts`
- `src/modules/events/dead-letter.service.ts`
- `src/modules/events/dead-letter.controller.ts`
- `test/us5.spec.ts`

### Files updated by Codex in this increment

- `src/app.module.ts`
- `src/database/database.service.ts`
- `src/modules/metrics/metrics.module.ts`
- `src/modules/notifications/notification.service.ts`
- `public/index.html`
- `implementation-status.json`
- `README.md`
- `walkthrough.md`
- `implementation_plan.md`

### Deliberate boundaries

- Retries are in-process and immediate, with linear backoff measured in milliseconds. A consumer whose dependency is down for minutes will exhaust its attempts and dead-letter rather than waiting it out; scheduled redelivery belongs with the durable queue that replaces the in-process bus.
- The dead-letter alert is published as a domain event. Nothing routes it to a person yet, so DLQ depth is visible in the dashboard and the event stream but does not page anyone.
- Replay requires the consumer to be registered in the running process. An entry belonging to a consumer that has since been removed or renamed cannot be replayed, and the API says so rather than failing silently.
- There is no automatic retry schedule for dead-lettered events; recovery is an operator action by design, because an event that failed three times usually needs a human to look at it.

### Verification result

- `npm run build`: **PASS**
- Focused suite (`test/us5.spec.ts`): **PASS — 8 tests**
- Full regression suite: **PASS — 27 test files, 84 tests**
- UI JavaScript parse check: **PASS**
- `git diff --check`: **PASS**
- Browser QA of the new Dead letters view: **not run in this increment; completed later in the Codex reliability and review hardening update above**

---

## Codex datastore persistence update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20. The earlier Codex records and the original Gemini plan remain below as prior-history sections.

**Status:** Implemented and covered by `test/persistence.spec.ts`, and verified by restarting the server rather than by unit test alone.

### Why this came next

PGlite was constructed without a data directory, so the database lived in memory and every restart began from the seed. That collided with the flow metrics delivered earlier the same day: a 30-day DORA window cannot show a trend on a datastore that dies with the process, so deployment frequency, lead time and change failure rate were structurally incapable of measuring anything beyond a single session. The measurement layer had been built on ground that reset nightly.

It also unblocks two things previously recorded as blocked: demonstrations that survive a restart, and any future attempt at genuine dogfooding, which was explicitly blocked on the backlog evaporating between sessions.

### Scope delivered by Codex

- Added `CADENA_DATA_DIR`, which selects the PGlite directory. `npm run dev` and `npm start` set it to `./data` via `cross-env`; `npm run dev:ephemeral` preserves the previous throwaway behaviour.
- Added `DatabaseService.createIsolated(dir)` for opening a directory outside the process singleton, plus `close()` and `isPersistent()`, and a public `dataDir`.
- The server prints its storage mode at boot, so which mode is active is never ambiguous.
- Added `npm run db:reset` and gitignored `data/`.

### Design decisions

- **In-memory remains the default.** Persistence is opted into through the environment rather than assumed in code. The alternative — defaulting to durable and having each test runner opt out — fails dangerously: a forgotten opt-out silently shares a database across twenty-six spec files. Defaulting to ephemeral fails safely, because the worst outcome is a lost throwaway.
- **The browser suite forces ephemeral explicitly.** It spawns the built server with `CADENA_DATA_DIR: ''` rather than inheriting the parent environment, because it seeds its own scenario and must begin from the seed on every run. Inheriting a developer's exported data directory would have made it pass or fail depending on whose machine ran it.
- **`cross-env` was added rather than inlining `VAR=value` in the npm script.** POSIX-style environment prefixes do not work when npm runs scripts through `cmd.exe`, which is the situation on this machine.
- **Migration safety was already present and is now relied upon.** Schema creation uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` throughout, so reopening an existing directory with a newer build migrates rather than resets. Demo seeding is guarded on an empty tenant, and every supporting insert is an upsert, so a restart does not duplicate the seed.

### Verification added by Codex

- `test/persistence.spec.ts` (5 tests): the in-memory default, work items surviving a close and reopen, additive re-initialisation over a populated directory without loss or duplication, retained `domain_events` history, and isolation between two separate directories.
- End-to-end restart, performed against the built server rather than asserted in isolation: created `STORY-7893449E` on the first boot with five items present; killed the process; reopened the same directory and found five items with that story intact, two services rather than four, and no re-seed in the log.
- The full suite was then run with `./data` deleted, confirming it creates no directory: 26 files, 76 tests, no `./data` afterwards.
- The browser smoke suite passes unchanged with the forced-ephemeral spawn.

### Files added by Codex in this increment

- `test/persistence.spec.ts`

### Files updated by Codex in this increment

- `src/database/database.service.ts`
- `src/server.ts`
- `test/ui-smoke.spec.ts`
- `package.json`
- `.gitignore`
- `README.md`
- `walkthrough.md`
- `implementation_plan.md`

### Deliberate boundaries

- This is a single-process embedded datastore, durable but not managed. No replication, no point-in-time recovery, no concurrent access from a second process, and backup means copying the directory while the server is stopped.
- There is no migration framework and no schema version table. Additive DDL covers the changes made so far; a destructive change — renaming a column, tightening a constraint — has no supported path and would need one.
- Seed events are not captured in `domain_events`, because bootstrap seeding runs before the Nest application starts and therefore before the event store subscribes. Fixture creation is arguably not history, but the asymmetry is worth knowing when reading early event counts.
- Nothing prunes the data directory. A long-running instance accumulates `domain_events` rows indefinitely, and retention is unaddressed.

### Verification result

- `npm run build`: **PASS**
- Focused suite (`test/persistence.spec.ts`): **PASS — 5 tests**
- Full regression suite: **PASS — 26 test files, 76 tests**
- Browser smoke suite: **PASS — 7 tests**
- Restart durability against the built server: **PASS**
- Test suite creates no data directory: **PASS**
- `git diff --check`: **PASS**

---

## Codex implementation tracker update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20. It was originally recorded only incidentally inside the US9.4 section; external review noted the omission and this section was written to correct it.

**Status:** Implemented and guarded by `test/tracker.spec.ts`.

### Why a generated tracker

The first delivery-status page was written by hand. It was accurate the day it was written and would have drifted from `Backlog.md` the moment a requirement changed, with nothing to detect the drift. A status page that quietly goes stale is worse than none, because it is still consulted.

### Scope delivered by Codex

- Split ownership across two files: `backlog.json` owns epics, stories and acceptance criteria; `implementation-status.json` owns delivery status, the abridged titles the tracker shows, and phase alignment.
- Added `scripts/build-tracker.mjs`, which merges them into `public/status.html` and exits non-zero naming any story that appears in one file and not the other.
- Added `npm run tracker`.
- Added `test/tracker.spec.ts`, which fails when a story has no status entry, when a status entry names a story nobody wrote, on an unrecognised status or an unknown phase, on a missing title or explanatory note, and when the generated page is stale.
- The page counts spec files from disk rather than carrying a hand-typed suite size.

### Design decisions

- **Status lives outside `backlog.json`.** Keeping them apart means adding a requirement cannot silently change a status, and a status cannot silently invent a requirement.
- **The generator refuses rather than guesses.** A story with no status entry stops the build; it does not render as unknown, because an unknown row is the thing a reader skims past.
- **The drift guard was verified, not assumed.** A fake `US1.9` was injected into `backlog.json`: the generator exited non-zero naming it and two tracker tests failed by name. The story was then removed.

### Files added

- `implementation-status.json`
- `scripts/build-tracker.mjs`
- `test/tracker.spec.ts`

### Files updated

- `package.json`
- `public/status.html`

### Deliberate boundaries

- Status is asserted by hand in `implementation-status.json`. The guard proves every story has *a* status, not that the status is truthful; that judgement stays human and is stated as such on the page.
- The page is a build artefact committed to the repository. It is regenerated by `npm run tracker` and will be stale between a status change and the next run, which `test/tracker.spec.ts` catches only for added or removed stories, not for an edited note.

---

## Codex research-derived backlog expansion — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20. External review noted that this increment had no delivery section of its own; this corrects that.

**Status:** Requirements recorded in `Backlog.md` and `backlog.json`. None of the added stories are implemented.

### Source

`Cadena Research.docx`, an architecture and engineering playbook framing Cadena as a bridge between ServiceNow (ITSM) and Jira (SDLC). The backlog predated it and had no home for most of what it describes.

### Scope delivered by Codex

Eighteen user stories, taking the backlog from 12 epics and 38 stories to **16 epics and 56 stories**.

Added to existing epics:

- **US3.4** SLA clock suspension while an item sits in a hold state.
- **US5.4** HTTP 202 ingestion, so a slow downstream cannot cause a provider-side webhook timeout.
- **US5.5** dead-letter replay with inline payload correction.
- **US10.5** identity resolved by immutable account identifier rather than email address.
- **US10.6** deactivation via SCIM `PATCH` where the target REST API offers no deactivation endpoint.

New epics:

- **E13 — ServiceNow / Jira bidirectional synchronization** (5 stories): configurable ITIL-to-Agile state matrix, immutable correlation references, echo-loop suppression, work-note privacy in comment sync, resolution code write-back.
- **E14 — Rich-text fidelity and AST transformer** (2 stories).
- **E15 — Agentic AI subsystem** (3 stories): incident-storm duplicate detection, stack-trace entity extraction, CAB release risk scoring.
- **E16 — Integration resilience and network topology** (3 stories): adaptive rate governance, indexed-query safety, zero-inbound-port relay connectivity.

### A discrepancy worth recording

The playbook's own §7 backlog execution status does not match the repository, and the divergence is not symmetrical:

- **Epic 2 is understated** as *In Progress*; US2.1–US2.3 are implemented and covered by `us2.1`–`us2.3`.
- **Epic 10 is overstated, and it matters.** US10.1–US10.2 (SSO and SCIM provisioning) are recorded as *Completed*. Neither exists; identity is a header-based stub. Treating that table as a delivery signal would credit the platform with an enterprise identity posture it does not have.
- Epic 4 is fairly described as in progress.

The repository is treated as authoritative, and the divergences are printed on the delivery tracker rather than silently reconciled.

### Knock-on change

`test/stage-b-dogfooding.spec.ts` hard-coded 12 epics and 38 stories, so expanding the backlog broke it. The expectations now derive from `backlog.json`: adding a requirement grows the fixture rather than breaking the test.

### Files updated

- `Backlog.md`
- `backlog.json`
- `test/stage-b-dogfooding.spec.ts` (later renamed `test/backlog-fixture.spec.ts`)

### Deliberate boundaries

- Requirements only. No implementation accompanies these stories, and all eighteen are recorded as not started.
- Acceptance criteria are written against capability rather than a named vendor API, because the pilot has no ServiceNow or Jira instance to build against and criteria written from documentation alone would encode assumptions no test could check.

---

## Codex US9.4 flow metrics update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20. The earlier Codex records and the original Gemini plan remain below as prior-history sections, with their original wording preserved even where terminology has since changed.

**Status:** Implemented and covered by automated acceptance tests for US9.4, with durable event history advancing US5.1 and US5.2 without completing either.

### Why this slice

Change failure rate is the figure that pays for the traceability graph. In a two-tool estate it depends on someone tagging each deployment by hand, and it is therefore usually wrong. Here it falls out of the `Incident caused_by Release` edge that Epic 4 already stores, so it needs no separate discipline. The rest of the DORA set was computable from artefacts the platform had been capturing since Epic 6 and simply never aggregating.

### Scope delivered by Codex

#### Durable event history

- Added a `domain_events` table and `EventStoreService`, which subscribes to every published event through a new `subscribeAll` hook on the bus and persists the full envelope.
- Wildcard handlers run before typed handlers, so an event is durable before any consumer acts on it.
- A failed history write is caught and logged; losing history must never break the mutation that produced the event.
- Added `GET /events`, filterable by event type, work item and time range, with the tenant scoping every other read already has.
- Added indexes on `(org_id, occurred_at)` and `(event_type, occurred_at)`, the two access patterns the metrics use.

#### DORA metrics

- **Deployment frequency** from successful deployment artefacts in the window, broken down by environment and normalised to a weekly rate.
- **Lead time for changes** from the earliest commit linked to any work item a deployment shipped, through to the deployment timestamp, reported as median, p90 and mean.
- **Change failure rate** from `Incident caused_by Release` where the release was shipped by a deployment in the window, returned with the deployment/incident pairs behind it so the number can be audited rather than trusted.
- **Time to restore service** from the incident's own first recorded transition into a resolved state.

#### ITIL metrics

- Incidents opened and resolved, severity mix, the share that were auto-created by the Epic 7 gateway, SLA breaches drawn from persisted `SLABreached` events, and reopen transitions out of a resolved state.

#### Honest coverage reporting

- The response carries a `coverage` block naming what each metric could and could not see: lead time counts only deployments whose work items also carry a linked commit, and time to restore counts only incidents with a recorded resolution. A metric computed over partial evidence says so rather than implying completeness.

#### Event contract fix

- `WorkItemStateChanged` carried no tenant, so a consumer could not tell which organisation a transition belonged to and the events fell out of every tenant-scoped query. `org_id` and `item_type` were added to the payload. The change is additive, which is exactly what US5.1's second acceptance criterion requires, and no existing consumer needed modifying.
- The event store additionally resolves a tenant from the referenced work item when a payload omits one, so no event is orphaned even if another event type forgets.

#### UI changes

- Replaced the nav's "Reports" coming-soon placeholder with a working **Flow metrics** view carrying a window selector, the four DORA figures with their denominators, the failed-change evidence list, the ITIL counts, and the coverage note.

### Design decisions

- **Metrics are computed per request, not materialised.** Spec §14 wants dashboards reading from materialised views so reporting never contends with the workflow engine. At pilot volume a live query is simpler and always correct; the view layer is Epic 9 hardening and is recorded as such rather than pretended away.
- **Every metric ships its denominator.** A rate without the count behind it invites misreading, so `change_failure_rate` returns `deployments`, `failed_deployments` and the pairs, not just the ratio.
- **An unresolved incident is excluded, never assumed.** Time to restore counts only incidents with a recorded resolution rather than treating open incidents as instant or infinite.
- **Durable history is not the outbox.** The event write lands immediately after the mutation rather than inside its transaction. That is a real improvement on an in-memory array but does not satisfy US5.1, so US5.1 stays Partial with the remaining gap named.

### Terminology change

The Stage B backlog import was described throughout as dogfooding. The imported items never transition, never age, carry no owners, and no commit ever links to them, so the label overstated what it was: a realistic data fixture. The function is now `importBacklogFixture`, the spec file is `test/backlog-fixture.spec.ts`, and the UI states what the import is for. Real dogfooding remains blocked on persistence, since PGlite runs in memory and a restart would discard the backlog. Historical sections below keep their original wording.

### Verification added by Codex

- `test/us9.4.spec.ts` (7 tests) over a constructed delivery history of two releases, two commits, two production deployments and two incidents, one of which was caused by a release:
  - deployment frequency and lead time derived from artefacts, with lead time landing in the expected 48-hour band;
  - change failure rate of exactly 0.5, with the failing deployment, release and incident returned as evidence;
  - time to restore counting the resolved incident and excluding the open one;
  - ITIL counts including severity mix and auto-created share;
  - window honoured, invalid and reversed ranges rejected with 422;
  - every metric scoped to the calling tenant, missing tenant rejected;
  - durable event history queryable and filterable, with envelope fields surviving the round trip.

### Files added by Codex in this increment

- `src/modules/events/event-store.service.ts`
- `src/modules/metrics/metrics.service.ts`
- `src/modules/metrics/metrics.controller.ts`
- `src/modules/metrics/metrics.module.ts`
- `test/us9.4.spec.ts`

### Files updated by Codex in this increment

- `src/app.module.ts`
- `src/database/database.service.ts`
- `src/modules/events/event-bus.ts`
- `src/modules/workflow/workflow.service.ts`
- `src/modules/work-items/work-item.controller.ts`
- `src/scripts/import-backlog.ts`
- `src/server.ts`
- `public/index.html`
- `implementation-status.json`
- `scripts/build-tracker.mjs`
- `test/backlog-fixture.spec.ts` (renamed from `test/stage-b-dogfooding.spec.ts`)
- `README.md`
- `walkthrough.md`
- `implementation_plan.md`

### Deliberate boundaries

- Metrics are computed live per request with one query per deployment and per incident. Correct and tenant-safe, but not optimised; materialised views are the scaling path.
- Lead time measures first commit to deployment. It does not model review time, queue time, or multiple commits per change separately.
- Change failure rate depends on someone recording the `caused_by` edge. The platform makes that edge cheap and auditable, but it does not infer causation.
- No trend series: figures are computed for one window, not bucketed over time, so the UI shows a value rather than a direction.
- US9.2's cross-team rollup and US9.3's interactive graph explorer remain unbuilt; this slice covers US9.4 only.

### Verification result

- `npm run build`: **PASS**
- Focused suite (`test/us9.4.spec.ts`): **PASS — 7 tests**
- Full regression suite: **PASS — 25 test files, 71 tests**
- Tracker drift guard (`test/tracker.spec.ts`): **PASS**
- UI JavaScript parse check: **PASS**
- `git diff --check`: **PASS**
- Live verification on the seeded tenant: deployment frequency, a change failure rate of 1/1 with `INC-D3220784 caused_by REL-5E5DFF18 via live-deploy-6.0.0`, and seven events persisted across four event types: **PASS**
- Browser screenshot/interaction QA of the new Flow metrics view: **not run in this increment; completed later in the Codex reliability and review hardening update above**

---

## Codex browser QA update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20. The earlier Codex records and the original Gemini plan remain below as prior-history sections.

**Status:** Implemented. Supersedes the "browser screenshot/interaction QA: not run" caveat recorded in every prior Codex section.

### Correction to prior records

Every earlier Codex verification block in this document states that browser QA was "not run because no browser backend was available in the current environment." That claim was inherited from the first such record and carried forward without being re-tested. It was wrong: Chrome is installed on this machine, and a headless browser was available the whole time. The caveat should have been verified before being repeated.

### Scope delivered by Codex

- Added `puppeteer-core` as a devDependency. It drives a browser already present on the machine, so no Chromium download is required and CI images need only a system browser.
- Added `test/ui-smoke.spec.ts`, seven tests driving the real page in headless Chrome.
- Added `npm run test:ui`, which compiles and then runs the smoke suite. `npm test` now excludes it so the fast suite stays fast.

### Coverage

| Test | Asserts |
| --- | --- |
| Board renders | work cards present, KPI totals non-zero, workflow columns include Triaged, result summary rendered |
| Incident drawer | Monitoring evidence section, affected service `SVC-CHECKOUT-API`, SEV1, provider name, Delivery evidence section |
| Service impact | summary and edge chains render, Release reached two hops out via `caused_by`, depth=1 correctly narrows to the directly affected Incident |
| Notification log | `slack -> email (fallback)` routing, `fallback sent` status, recipient role |
| Transition dialog | offers exactly the workflow-permitted next states for a Triaged Incident |
| Escalated filter | escalated work surfaces through the SLA health filter |
| Responsive and clean | no horizontal overflow at 390px, mobile menu visible, zero console errors across the whole session |

### Design decisions

- **The suite drives the built server, not a Nest testing module.** `ServeStaticModule` does not serve `public/` under vitest's transform: a diagnostic showed the root returning `404 Cannot GET /`. An in-process app would therefore test a page that never loads. Spawning `dist/server.js` also exercises the artifact people actually run, including real bootstrap seeding.
- **It skips rather than fails** when no browser or no build is present, because both are environment gaps rather than product defects.
- **It is excluded from `npm test`.** The suite takes about 140 seconds, most of it waiting for a real SLA to age, which does not belong in the fast feedback loop.
- **The SLA wait is deliberate, not arbitrary.** `SlaCalculatorService` floors elapsed time to whole minutes, so a 1-minute threshold reads exactly 100% anywhere between 60 and 119 seconds. The seed crosses two minutes to reach 200%, clearing both the breach and the lowered escalation threshold.

### What it found

Two defects, both in the test code rather than the product: assertions compared against `innerText`, which returns *rendered* text, while `.column-title` and `.detail-section h3` are styled `text-transform: uppercase`. The application markup and behaviour were correct in every case. No product defect was found, which is a meaningful result given the UI had never been executed in a browser under test.

### Files added by Codex in this increment

- `test/ui-smoke.spec.ts`

### Files updated by Codex in this increment

- `package.json`
- `package-lock.json`
- `README.md`
- `walkthrough.md`
- `implementation_plan.md`

### Deliberate boundaries

- Chrome only. No cross-browser matrix.
- No visual regression: there are no screenshot baselines, so a purely cosmetic change would pass.
- No accessibility audit beyond asserting the keyboard and ARIA attributes already present; no axe-core or similar.
- The suite asserts rendered text and DOM state, not pixel layout beyond a horizontal-overflow check.
- It depends on a system-installed browser. A CI image without one will skip the suite rather than fail, which means a silent gap if nobody checks that it ran.

### Verification result

- `npm run build`: **PASS**
- `npm run test:ui`: **PASS - 1 test file, 7 tests, headless Chrome**
- Full regression suite: **PASS - 23 test files, 59 tests**
- `git diff --check`: **PASS**

---

## Codex Epic 8 notification update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20 as the Epic 8 slice. The earlier Codex records and the original Gemini plan remain below as prior-history sections.

**Status:** Implemented and covered by automated acceptance tests for US8.1, US8.2, and US8.3.

### Why this slice was chosen next

A grep for `.subscribe(` across `src/` and `test/` returned nothing. The aging engine had been publishing `SLAWarning` and `SLABreached` since Epic 3 with fully-formed recipient payloads, and no consumer existed — the events were emitted and dropped. Epic 8 makes the platform's own governance signal actually reach a person, which is the difference between measuring aging and managing it.

### Scope delivered by Codex

#### Event consumption

- Added `NotificationService`, the platform's first event-bus subscriber, listening on `SLAWarning`, `SLABreached`, and the new `SLAEscalated`.
- Subscription is guarded by a `WeakSet` keyed on the bus instance so a second application instance, as the test suite creates, cannot double-subscribe.
- A dispatch failure is caught and logged rather than propagated, so a notification problem can never break the aging tick that emitted the event.

#### Routing (US8.1, US8.2)

- `SLAWarning` notifies the owner; `SLABreached` notifies the owner and the team lead; `SLAEscalated` notifies the configured escalation target.
- Escalation target resolution falls back in order: the team's configured `escalation_person_id`, then a team member holding `on_call`, then one holding `team_lead`.
- The owner is kept on an escalation thread so an escalation with no configured target is never silent.
- Added `SLAEscalated` emission to the aging engine at a per-tenant threshold, default 150%, deduplicated per state entry exactly as the existing warning and breach emissions are.
- Added an `escalated_at` marker on the work item, so escalated work is queryable ahead of the Epic 9 executive dashboard.

#### Channels and fallback (US8.3)

- Added per-person channel preference across `email`, `slack`, and `teams`, defaulting to email for anyone who has not chosen.
- A failed delivery falls back to email, and both attempts are recorded on the notification with per-attempt reasons.
- Status is `sent` when the preferred channel worked, `fallback_sent` when email rescued it, and `failed` when neither did.
- Two genuine failure modes drive the fallback: a person who selected a channel they have no address for, and a tenant-level `unavailable_channels` setting that simulates a transport outage.

#### Persistence and idempotency

- Added `notification_preferences`, `notification_settings`, `team_escalation_targets`, and `notifications` tables, all tenant-scoped.
- The `notifications` table is both the delivery audit log and the idempotency key: a unique constraint on `(event_id, recipient_id)` means a replayed event notifies nobody twice, so the 60-second aging tick cannot spam a recipient.

#### API

- `GET /notifications` with `recipient_id`, `work_item_id`, `event_type`, and `limit` filters.
- `GET`/`POST /notifications/settings`, `GET`/`POST /notifications/preferences`, and `POST /notifications/escalation-targets/:teamId`, each validating input and returning an actionable 422.

#### UI changes

- Added a **Notifications** nav view rendering the delivery log with recipient role, routing (including `slack -> email (fallback)`), status, and failure reason.
- Added an **Escalated** option to the SLA health filter and an Escalated badge on work cards.
- Exposed `escalated_at` through the work-item API so the workspace can filter and badge on it.

#### Pilot seeding

- Seeded three people with distinct roles and notification preferences (Slack, email, Teams) plus a team escalation target, so the whole routing path is demonstrable on a fresh boot.

### Design decisions

- **Channel adapters are stubs, and the delivery log is the delivery record.** Spec §18.3 keeps external transports out of the pilot. The adapter contract isolates transport from routing, so swapping in SES/SendGrid, the Slack Web API, or Microsoft Graph means replacing one `transmit` method while routing, fallback, idempotency, and audit stay as tested.
- **`unavailable_channels` is explicit pilot tooling.** Testing the US8.3 fallback needs a delivery failure that is not merely a configuration gap. Naming it plainly in the schema and README is more honest than hiding a test hook inside an adapter.
- **Escalation notifies, it does not act.** It routes to a person and flags the item; it never transitions work. That stays consistent with the guard discipline established in US2.3 and US7.3.
- **The controller instantiates its service directly.** Vitest's esbuild transform does not emit decorator metadata, so Nest cannot inject by type under test. Every other controller in this codebase already works this way; matching it keeps the suite green without a bespoke test harness. The module still registers the service as a provider, which is what triggers the subscription lifecycle hook.

### Verification added by Codex

- `test/us8.1.spec.ts` (3 tests): owner notified on their chosen channel at 75%, dispatch inside the emitting tick, no double notification across three consecutive recomputes, nothing recorded for an unowned item, and tenant isolation on the log.
- `test/us8.2.spec.ts` (4 tests): owner and team lead both notified on breach with nothing escalated below threshold, escalation to the configured manager at 150% with `escalated_at` set, fallback to an `on_call` member when no target is configured, and validation of the threshold and target.
- `test/us8.3.spec.ts` (5 tests): delivery on the chosen channel for Slack and Teams, email fallback for a missing address, email fallback for an unavailable channel, a recorded failure when the fallback is also unavailable, and default-to-email plus unknown-channel rejection.

### Files added by Codex in this increment

- `src/modules/notifications/notification.types.ts`
- `src/modules/notifications/notification-channels.ts`
- `src/modules/notifications/notification.service.ts`
- `src/modules/notifications/notification.controller.ts`
- `src/modules/notifications/notification.module.ts`
- `test/us8.1.spec.ts`
- `test/us8.2.spec.ts`
- `test/us8.3.spec.ts`

### Files updated by Codex in this increment

- `src/app.module.ts`
- `src/database/database.service.ts`
- `src/modules/sla/aging-engine.service.ts`
- `src/modules/work-items/work-item.service.ts`
- `src/modules/work-items/work-item.types.ts`
- `src/server.ts`
- `public/index.html`
- `README.md`
- `walkthrough.md`
- `implementation_plan.md`

### Deliberate boundaries

- **No message leaves the process.** The adapters record and return success; there is no SMTP, Slack, or Graph call.
- Only the three SLA events are routed. `IncidentAutoCreated`, `SLAWarning` for incidents specifically, and the Epic 6/7 integration events are not yet subscribed.
- Delivery is synchronous inside the aging tick. A slow real transport would stretch that tick; production wants a queue between emission and delivery, which is Epic 5 work.
- There is no digest, quiet-hours, or rate-limiting behaviour; one qualifying event produces one notification per recipient.
- Escalation surfaces through `escalated_at` and a UI filter. The executive aging dashboard named in US8.2's second criterion is Epic 9 and is not built.
- No `POST /people` endpoint exists, so recipients are seeded or created through `RbacService`. Identity management remains US10.3 hardening work.

### Verification result

- `npm run build`: **PASS**
- Focused Epic 8 suite (`test/us8.1`, `us8.2`, `us8.3`): **PASS — 3 test files, 12 tests**
- Full regression suite: **PASS — 23 test files, 59 tests**
- UI JavaScript parse check: **PASS**
- `git diff --check`: **PASS**
- Live end-to-end on the seeded tenant with Slack marked unavailable: warning to owner, breach to owner and team lead, escalation to the configured on-call target, every Slack-preferring recipient falling back to email with the reason recorded: **PASS**
- Browser screenshot/interaction QA: **not run because no browser backend was available in the current environment**

---

## Codex US4.3 impact analysis update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20 as the US4.3 slice, completing Epic 4. The earlier Codex records and the original Gemini plan remain below as prior-history sections.

**Status:** Implemented and covered by automated acceptance tests for US4.3.

### Why this slice was chosen next

Epic 7 created `affects` edges between Incidents and Services, but nothing read them beyond the flat `GET /services/:id/work-items` list. US4.3 is the payoff on that investment and completes Epic 4, the traceability graph service that is the platform's stated capability gap (Spec §9). It answers the question no two-tool setup can: *given a service outage, which releases and stories are implicated?*

It also closed a real gap found while building it — only the monitoring gateway could create an `affects` edge, so a manually raised Incident had no way to declare what it affects.

### Scope delivered by Codex

#### Impact traversal

- Added `ImpactService` seeded from a Service's `affects` edges in `work_item_service_links`, then walking the `work_item_links` graph outward to a requested depth.
- Added `GET /services/:id/impact?depth=N&edge_types=...`, tenant-scoped on every hop through joins on `org_id` for both endpoints of each edge.
- `depth` defaults to 3, clamps to a documented maximum of 10, and rejects a non-numeric value with an actionable 422.
- `edge_types` narrows which work-item edge types the walk may follow.
- Added a summary carrying the total, a per-type breakdown, an open-incident count, and the highest severity among impacted incidents.

#### Explainability

- Every impacted node carries `distance` and the `via` edge chain that implicates it, starting at the Service. A Release two hops out shows `SVC → INC (affects)` then `INC → REL (caused_by)`, so a reader can judge relevance instead of trusting an opaque list.

#### Manual `affects` edges

- Added `POST /services/:id/work-items`, symmetric with the existing GET, so a person can record an `affects` edge for an Incident that was raised by hand rather than by a monitoring alert.
- Returns 404 for a work item or service outside the active tenant, and 422 for a missing `work_item_id`.

#### UI changes

- Replaced the nav's "Traceability" coming-soon placeholder with a working **Service impact** view.
- Added a service picker and depth selector, a summary tag row (total, open incidents, highest severity, per-type counts), and a result list showing each item's distance and its full `via` chain.
- Impacted items already loaded in the workspace offer an **Open** action into the existing item drawer.

### Design decisions

- **The walk is undirected.** The backlog asks for "all affected work items within a specified depth". An implicated Release sits *upstream* of the Incident it caused, while a remediating Story sits *downstream*; filtering by lineage direction would silently drop one or the other. The `via` chain supplies the interpretability that direction filtering would have provided, without the loss.
- **`open_incidents` excludes only `Resolved` and `Closed`.** `Mitigated` deliberately still counts as open, because Epic 7 automation can propose mitigation but a human has not yet confirmed it. Counting a machine-proposed state as closed would defeat the point of US7.3.
- **Impact lives in the lineage module, exposed on the services route.** It is a traceability query, so `ImpactService` sits with the rest of Epic 4; the REST location follows the resource being asked about. The import graph stays acyclic: controller → `ImpactService` → `ServiceRegistryService`.

### Verification added by Codex

- `test/us4.3.spec.ts` (6 tests) over a fixture chaining `SVC ←affects― INC ―caused_by→ REL ←deployed_in― STORY ―child_of→ EPIC`:
  - every implicated item returned within the requested depth, with an unrelated story correctly excluded;
  - each result explained by its exact `via` edge chain;
  - depth bound honoured at 1, 2 and 4, plus default, clamp and invalid-depth rejection;
  - `edge_types` filtering excluding items reachable only through an omitted edge;
  - tenant isolation on both impact queries and `affects` edge creation;
  - the impact summary tracking incident resolution.

### Files added by Codex in this increment

- `src/modules/lineage/impact.types.ts`
- `src/modules/lineage/impact.service.ts`
- `test/us4.3.spec.ts`

### Files updated by Codex in this increment

- `src/modules/services/service-registry.controller.ts`
- `src/modules/services/service-registry.module.ts`
- `public/index.html`
- `README.md`
- `walkthrough.md`
- `implementation_plan.md`

### Deliberate boundaries

- Traversal is breadth-first over the full edge set with no relevance weighting; a depth-4 query on a densely linked tenant returns everything reachable, not a ranked shortlist.
- Results are computed per request with one query per visited node. That is correct and tenant-safe but not optimized; a recursive CTE or a materialized graph projection is the scaling path.
- Impact is computed from a Service only. The inverse question — "which services does this Release put at risk?" — is reachable through the same edges but has no dedicated endpoint.
- Service-to-service dependency edges are not modelled, so impact does not cascade across services. That requires the CMDB relationships in Epic 11.

### Verification result

- `npm run build`: **PASS**
- Focused US4.3 suite: **PASS — 1 test file, 6 tests**
- Full regression suite: **PASS — 20 test files, 47 tests**
- UI JavaScript parse check: **PASS**
- `git diff --check`: **PASS**
- Live traversal against the seeded tenant, including edges created by the Epic 7 monitoring gateway: **PASS**
- Browser screenshot/interaction QA: **not run because no browser backend was available in the current environment**

---

## Codex Epic 7 monitoring update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20 as the Epic 7 slice. The earlier 2026-09-20 Codex integration record, the 2026-09-19 Codex record, and the original Gemini plan remain below as prior-history sections.

**Status:** Implemented and covered by automated acceptance tests for US7.1, US7.2, and US7.3.

### Modelling decision: how Service/Asset is represented

The specification lists **Service/Asset** under §3.3 *Supporting entities* — "lightweight internal CMDB entry (name, owner team, environment)" — and the §3.5 ERD draws `SERVICES ||--o{ WORK_ITEMS : affected_by`. It is therefore deliberately **not** modelled as a canonical WorkItem.

- Services live in their own tenant-scoped `services` table with `service_key`, `name`, `owner_team_id`, `environment`, `source`, `external_ref`, and `aliases`.
- The §3.2 `affects` edge lives in `work_item_service_links`, because `work_item_links` constrains both endpoints to `work_items`.
- Modelling a Service as a WorkItem was rejected: it would place infrastructure inventory on the delivery board, give it a delivery workflow and an SLA bucket, and make Epic 11 CMDB federation reconcile against work items rather than against a registry.
- `source` distinguishes `internal`, `monitoring_discovery`, and `cmdb` rows so Epic 11 can reconcile pilot-discovered entries against an authoritative external CMDB without guessing which records were hand-entered.

Monitoring alerts are likewise **not** WorkItems. Per §9 the monitoring tool stays the system of record for its own data, so an alert is persisted as an `external_artifacts` row of type `alert` and joined to the Incident with a `detected_by` link — reusing the same artifact and link tables the Epic 6 Git/CI gateway already uses.

### Scope delivered by Codex

#### Service/Asset registry

- Added `services` and `work_item_service_links` tables, both tenant-scoped.
- Added `POST /services`, `GET /services`, `GET /services/:id`, and `GET /services/:id/work-items`.
- Added case-insensitive resolution across service key, display name, external reference, and aliases, so one Service matches however each monitor labels it.
- Added key normalization (`Payments API` becomes `SVC-PAYMENTS-API`) and alias merging on re-registration, which fills gaps without discarding curated ownership data.

#### Monitoring/APM ingestion

- Added `POST /integrations/monitoring/webhooks` for normalized `alert_fired` and `alert_resolved` events.
- Added `x-delivery-id` and `x-monitoring-delivery` headers with the existing tenant/provider/delivery uniqueness, so a replayed delivery returns the original recorded result and performs no further side effects.
- Added persistent alert artifacts carrying provider severity, mapped severity, occurrence count, first/last seen, resolution time, and the current Incident reference.
- Added payload validation returning HTTP 422 with an actionable message for a missing delivery id, unknown `event_type`, missing `alert`, missing `alert.id`/`alert.dedupe_key`, missing `alert.title`, and non-ISO-8601 timestamps.
- Added `GET /integrations/monitoring/deliveries/:deliveryId` for delivery inspection.

#### Severity mapping and threshold

- Added provider-vocabulary mapping onto SEV1–SEV4 covering `critical`/`fatal`/`page`, `error`/`high`/`major`, `warning`/`medium`/`degraded`, and `info`/`low`/`minor`, plus `sevN`, `pN`, and bare numeric forms.
- Added SEV-to-priority derivation (SEV1 to P0, SEV2 to P1, SEV3 to P2, SEV4 to P3).
- An unrecognized or absent provider severity maps to SEV3 and is reported as `matched: false`, so a missing mapping is visible rather than dropping a real alert.
- Added a per-tenant `min_severity` threshold. Alerts below it are still persisted as evidence but return `suppressed_below_threshold` and create no Incident.

#### Automatic Incident creation and deduplication

- Added automatic Incident creation through the standard `WorkItemService`, so the Incident lands in the workflow's own initial state, `Triaged`, with no bypass.
- Added a per-tenant rolling dedupe window. A repeat alert with the same dedupe key updates the open Incident instead of creating a duplicate; the window is measured from the previous occurrence to the new alert's own timestamp.
- Added severity escalation on recurrence, recorded as an `IncidentSeverityEscalated` audit event.
- An Incident that has reached a settled state (`Mitigated`, `Resolved`, `Post-incident Review`, `Closed`) always yields a new Incident on recurrence, whatever the window.
- Added a `MonitoringAlertDeduplicated` event carrying the occurrence count and window.

#### Affected-service linking

- Added `affects` edge creation from the auto-created Incident to the resolved Service.
- Owning team resolution prefers the Service's `owner_team_id`, then the tenant's configured `default_team_id`, and otherwise returns an actionable 422 naming both ways to fix it.
- Added optional auto-registration of a `monitoring_discovery` Service when an alert names one the registry does not hold, so impact analysis keeps working while the entry awaits CMDB reconciliation.

#### Resolution handling

- Added `alert_resolved` handling that proposes `Mitigated` and never `Resolved` or `Closed`.
- The proposal walks the Incident's own workflow definition from its current state to `Mitigated`, applying each step through `WorkflowService` so guards and required fields are evaluated normally; the auto-generated `mitigation_summary` states that human confirmation is still pending.
- Paths that would pass through `Resolved`, `Closed`, or `Post-incident Review` are never considered, and the walk is capped at three transitions.
- A rejected guard, or a required field the integration cannot legitimately supply, stops the walk and is recorded as a skipped outcome with its reason plus a `MonitoringAutoTransitionSkipped` event. Nothing is forced.
- Added an `IncidentMitigationProposed` event carrying `awaiting_human_confirmation`.

#### Tenant configuration

- Added `GET`/`POST /integrations/monitoring/settings` for `min_severity`, `dedupe_window_minutes`, `default_team_id`, `automation_actor_role`, and `auto_register_services`, with validation on each.
- `automation_actor_role` is the role the integration presents to the workflow engine; it defaults to `on_call` and is still evaluated by the guard rather than trusted.

#### Shared integration design

- Extracted `IntegrationSupport` from the Epic 6 gateway, holding delivery deduplication, artifact upsert, artifact linking, work-item key resolution, and guard-aware transition attempts.
- Refactored `IntegrationService` to delegate to it, so the Git/CI and monitoring gateways share one implementation of idempotency and automation safety instead of two.

#### UI changes

- Added a tenant-scoped "Monitoring evidence" section to the Incident drawer showing affected services (flagged when discovered) and linked alerts with severity, provider, status, occurrence count, and last-seen time.
- Restricted rendered alert and runbook links to HTTP(S) URLs and continued rendering provider-controlled values through `textContent`/DOM nodes.

#### Pilot seeding

- Seeded tenant monitoring settings and two internal Services at bootstrap so alert ingestion has an owning team before any backlog import.

### Verification added by Codex

- `test/us7.1.spec.ts` (7 tests): Triaged auto-creation with mapped severity, severity vocabulary mapping, dedupe inside the window, a new Incident outside the window, below-threshold suppression, delivery replay, and payload/tenant-isolation errors.
- `test/us7.2.spec.ts` (3 tests): `affects` edge to a registered Service with ownership taken from the Service, discovered-service registration that stays off the delivery board, and Service registry tenant isolation.
- `test/us7.3.spec.ts` (4 tests): guarded walk to `Mitigated` with confirmation past it still human, a skipped walk when the configured role fails the guard, evidence-only handling of an unlinked resolution, and queryable alert evidence.

### Files added by Codex in this increment

- `src/modules/services/service-registry.types.ts`
- `src/modules/services/service-registry.service.ts`
- `src/modules/services/service-registry.controller.ts`
- `src/modules/services/service-registry.module.ts`
- `src/modules/integrations/integration-support.ts`
- `src/modules/integrations/monitoring.types.ts`
- `src/modules/integrations/monitoring.service.ts`
- `src/modules/integrations/monitoring.controller.ts`
- `test/us7.1.spec.ts`
- `test/us7.2.spec.ts`
- `test/us7.3.spec.ts`

### Files updated by Codex in this increment

- `src/app.module.ts`
- `src/database/database.service.ts`
- `src/modules/integrations/integration.module.ts`
- `src/modules/integrations/integration.service.ts`
- `src/modules/integrations/integration.types.ts`
- `src/server.ts`
- `public/index.html`
- `README.md`
- `implementation_plan.md`

### Deliberate boundaries

- **Webhook signature verification is not implemented.** The endpoint trusts the `x-org-id` header and the normalized body. Before exposure to a real provider it needs per-tenant shared-secret registration, provider signature verification over the raw body (Datadog `DD-Signature`, PagerDuty/Grafana HMAC), timestamp-based replay rejection, and raw-payload adapters per provider. The pilot accepts a documented normalized payload instead.
- Tenant identity arrives in a header rather than from an authenticated integration credential; that remains US10.3 hardening work.
- `automation_actor_role` grants the integration a workflow role by tenant configuration. The guard still evaluates it, but binding integration identity to a real RBAC principal is enterprise-hardening work.
- Deduplication state lives in the alert artifact payload and is durable within the datastore; transport retries, a transactional outbox, Kafka, and a dead-letter queue remain Epic 5 work.
- Service auto-registration produces a lightweight `monitoring_discovery` stub. Live CMDB federation, staleness flagging, and authoritative ownership are Epic 11 (US11.1, US11.2).
- Downstream impact analysis from a Service is exposed as a direct `affects` query only; the full depth-limited traversal in US4.3 is not implemented.
- Alerts are recorded per tenant, provider, and dedupe key. Cross-provider correlation of one underlying issue is not attempted.

### Verification result

- `npm run build`: **PASS**
- Focused Epic 7 suite (`test/us7.1`, `us7.2`, `us7.3`): **PASS — 3 test files, 14 tests**
- Full regression suite: **PASS — 19 test files, 41 tests**
- UI JavaScript parse check: **PASS**
- `git diff --check`: **PASS**
- Local production startup and route registration on an alternate port: **PASS**
- Live endpoint smoke test (alert fired produced a `Triaged` SEV1 Incident with an `affects` edge; alert resolved moved it to `Mitigated`; evidence query returned the alert): **PASS**
- Browser screenshot/interaction QA: **not run because no browser backend was available in the current environment**

---

## Codex Phase 1 integration update — 2026-09-20

> **Attribution boundary:** Everything in this section was designed and implemented by **Codex** on 2026-09-20. The 2026-09-19 Codex record and the original Gemini plan remain below as prior-history sections.

**Status:** Implemented and covered by automated acceptance tests for US2.3 and US6.1–US6.3.

### Scope delivered by Codex

#### Stable references and Release work items

- Added immutable, tenant-unique human-readable keys to every work item (`EPIC-*`, `STORY-*`, `INC-*`, and `REL-*`).
- Added `release` as a canonical work-item type with a built-in `Draft → Ready → Deployed → Closed` workflow.
- Added Release-compatible traceability edge rules and exposed stable keys through the API and UI.
- Added a safe startup migration that backfills keys for work items created by earlier pilot builds.

#### Git and CI/CD integration gateway

- Added `POST /integrations/git/webhooks` for normalized `push`, `pull_request`, and `deployment` events.
- Added support for `x-delivery-id` and GitHub's `x-github-delivery` header, with tenant/provider/delivery uniqueness preventing duplicate side effects.
- Added persistent external artifacts for commits, pull requests, and deployments without incorrectly modelling those provider-owned objects as canonical WorkItems.
- Added work-item key extraction from commit messages, PR title/body/branch, deployment description, release key, and explicit deployment work-item keys.
- Stored commits even when no work-item key is present, satisfying the unlinked-artifact path without returning an error.
- Added tenant-scoped external-artifact links using `fixed_by` for commit/PR evidence and `deployed_in` for deployments.
- Added `GET /workitems/:id/external-links` so delivery evidence can be queried from the work item.
- Added `GET /integrations/git/deliveries/:deliveryId` for inspecting the status and recorded result of a delivery.

#### Automatic transitions

- Implemented PR-merge automation from Story `In Progress` to `In Review` through the existing workflow engine.
- Implemented successful-deployment automation from Release `Ready` to `Deployed`.
- Runs automation as an `integration` actor and preserves the standard guard and required-field evaluation path.
- Records rejected automation as an `IntegrationAutoTransitionSkipped` event and returns a structured skipped result; guards are never bypassed.
- Stores complete delivery results so duplicate deliveries return the original outcome without replaying transitions or links.

#### UI changes

- Added Release to creation, filtering, workflow ordering, SLA policy configuration, type badges, and detail views.
- Switched displayed work-item references to the API's stable keys.
- Added a tenant-scoped “Delivery evidence” section to the item drawer for linked commits, pull requests, and deployments.
- Restricted rendered artifact links to HTTP(S) URLs and continued using DOM/text rendering for external values.

#### Verification added by Codex

- `test/us2.3.spec.ts`: verifies a guard-rejected external transition is skipped, logged, and leaves state unchanged.
- `test/us6.1.spec.ts`: verifies referenced commit linking and storage of unreferenced commits.
- `test/us6.2.spec.ts`: verifies a merged PR advances its linked Story.
- `test/us6.3.spec.ts`: verifies deployment links, Release advancement, and delivery idempotency.
- Updated `test/us1.1.spec.ts` for the expanded canonical type contract.

### Files added by Codex in this increment

- `src/modules/integrations/integration.types.ts`
- `src/modules/integrations/integration.service.ts`
- `src/modules/integrations/integration.controller.ts`
- `src/modules/integrations/integration.module.ts`
- `test/us2.3.spec.ts`
- `test/us6.1.spec.ts`
- `test/us6.2.spec.ts`
- `test/us6.3.spec.ts`

### Files updated by Codex in this increment

- `src/app.module.ts`
- `src/database/database.service.ts`
- `src/modules/lineage/lineage.types.ts`
- `src/modules/work-items/work-item.service.ts`
- `src/modules/work-items/work-item.types.ts`
- `src/modules/workflow/workflow.service.ts`
- `public/index.html`
- `test/us1.1.spec.ts`
- `README.md`
- `implementation_plan.md`

### Deliberate boundaries

- The endpoint accepts a documented normalized provider payload; provider-specific signature verification and raw GitHub/GitLab payload adapters remain production-hardening work.
- Delivery deduplication is durable within the configured datastore, but transport retries, a transactional event outbox, Kafka, and a dead-letter queue remain Epic 5 work.
- Deployment membership is supplied by the CI/CD callback through `work_item_keys`; automated release-manifest discovery is not yet implemented.
- Git/CI integration is implemented; monitoring/APM ingestion and alert-driven Incident creation remain the next integration slice (Epic 7).

### Verification result

- `npm run build`: **PASS**
- UI JavaScript parse check: **PASS**
- Focused integration suite: **PASS — 5 test files, 7 tests**
- Full regression suite: **PASS — 16 test files, 27 tests**
- `git diff --check`: **PASS**
- Local production startup and route registration on an alternate port: **PASS**
- Browser screenshot/interaction QA: **not run because no browser backend was available in the current environment**

---

## Codex implementation update — 2026-09-19

> **Attribution boundary:** Everything in this section describes work implemented by **Codex** on 2026-09-19. The section titled **Original Gemini implementation plan (historical baseline)** and all content below it are retained to distinguish the earlier Gemini plan from the Codex changes.

**Status:** Implemented; final build and automated regression verification recorded below.

### Changes implemented by Codex

#### Release and correctness stabilization

- Corrected the TypeScript build layout by compiling only `src/` with `src` as `rootDir`, so the existing `npm start` command resolves the emitted `dist/server.js` entry point.
- Moved incremental compiler metadata to `dist/tsconfig.tsbuildinfo` and excluded tests, build output, and dependencies from the production compilation boundary.
- Fixed strict typing for the SLA team-lead query and the SLA test result rows.
- Added `aging_score` to the canonical API type and corrected WorkItem mapping to return persisted `aging_bucket` and `aging_score` values written by the aging engine.
- Removed the older API read-path behavior that inferred SLA health from `custom_fields`, making the SLA columns the single source of truth.
- Added built-in, enforced workflows for Epic, Story, and Incident items. Items without a custom published workflow can no longer transition to arbitrary state names.
- Added `GET /workitems/:id/available-transitions` so clients can render only workflow-permitted next states and required fields.
- Scoped item detail, transition, relationship, and lineage operations to the active `x-org-id` tenant; cross-tenant links are explicitly rejected.
- Enforced active-tenant/body-tenant agreement when creating work items and updating SLA policies, preventing request bodies from overriding the tenant header.
- Added SLA policy request validation for supported item type, non-empty state, positive whole-minute threshold, and `5x8`/`24x7` calendar values, returning actionable 403/422 responses.
- Corrected lineage traversal so upstream and downstream follow relationship semantics instead of returning the same traversal.
- Seeded the primary pilot organization, team, and default Story/Incident SLA policies during application bootstrap so policy management works before a backlog import.

#### Canonical model and dogfooding

- Added `epic` as a first-class WorkItem type with the delivery workflow and valid Epic/Story relationship pairs.
- Updated Stage B backlog import to create actual Epic items rather than Stories carrying an `is_epic` flag as their effective type.
- Kept the original backlog counts intact: 12 Epics, 38 Stories, and 38 parent-child relationships.
- Updated the initial demo dataset to create its parent as a true Epic, tenant-scope all seed relationships, and remove the legacy custom-field aging override from the sample Incident.

#### Codex UI overhaul

- Replaced the single demo card grid with a responsive team workspace and application navigation.
- Added tenant-wide KPI cards, SLA attention messaging, search, type/SLA filters, and board/list view switching.
- Added compact, worst-SLA-first work cards grouped by workflow state.
- Added an accessible item-details drawer with overview, safe custom-field rendering, and contextual actions.
- Replaced free-text transitions with options returned by the active workflow, including conditional mitigation-summary capture.
- Added responsive and keyboard-accessible native dialogs for create, transition, linking, lineage, SLA policy, pilot actions, and backlog-import confirmation.
- Replaced browser `alert()`/`confirm()` flows with inline errors, confirmation UI, and live-region toasts.
- Added distinct “No SLA policy” presentation so ungoverned work is not misrepresented as healthy green work.
- Added 30-second background refresh, loading skeletons, retryable error states, responsive mobile navigation, reduced-motion support, and visible keyboard focus.
- Removed dynamic `innerHTML` rendering of API data; user-controlled values now render through `textContent`/DOM nodes to prevent stored markup injection.

#### Documentation reconciliation

- Updated `README.md` to reflect Epic support, the implemented aging/SLA engine, the new pilot workspace, 22-test verification status, and the actual remaining Phase 1 work.
- Added this dated Codex implementation record and preserved the original Gemini plan under a separately labeled historical-baseline section.
- Added explicit Codex markers in the UI source and this document so ownership is identifiable without relying on Git history alone.

#### Codex verification additions

- Updated existing tests to pass tenant context on protected item routes.
- Updated SLA filter fixtures to use the persisted SLA columns instead of a custom-field override.
- Updated dogfooding verification to assert that imported backlog parents are true `epic` items.
- Added/updated coverage for the public SLA API contract, tenant isolation, and directional lineage behavior.

### Primary files changed by Codex

- `README.md`
- `implementation_plan.md`
- `public/index.html`
- `src/modules/lineage/lineage.controller.ts`
- `src/modules/lineage/lineage.service.ts`
- `src/modules/lineage/lineage.types.ts`
- `src/modules/sla/aging-engine.service.ts`
- `src/modules/sla/sla.controller.ts`
- `src/modules/work-items/work-item.types.ts`
- `src/modules/work-items/work-item.service.ts`
- `src/modules/work-items/work-item.controller.ts`
- `src/modules/workflow/workflow.service.ts`
- `src/scripts/import-backlog.ts`
- `src/server.ts`
- `tsconfig.json`
- `test/stage-b-dogfooding.spec.ts`
- `test/us1.1.spec.ts`
- `test/us1.2.spec.ts`
- `test/us10.3.spec.ts`
- `test/us2.2.spec.ts`
- `test/us3.2.spec.ts`
- `test/us4.1.spec.ts`
- `test/us4.2.spec.ts`

### Verification result

- `npm run build`: **PASS**
- Browser UI script parse check: **PASS**
- `npm test`: **PASS — 12 test files, 22 tests**
- `git diff --check`: **PASS**
- Production entry artifact `dist/server.js`: **generated successfully**

### Verification scope and limitations

- Automated verification covers canonical work-item behavior, SLA calculations and read mapping, guarded workflows, tenant isolation, typed links, semantic upstream/downstream lineage, RBAC, and Stage B dogfooding.
- The in-app browser backend was unavailable during this change, so screenshot-based visual QA was not performed. The UI received static JavaScript parsing, responsive/accessibility-oriented implementation review, and API-contract coverage.
- No hosting or external deployment was performed; the requested scope was the local project implementation.

---

## Original Gemini implementation plan (historical baseline)

The remainder of this document is the earlier Gemini-authored proposal. It is preserved as historical design context; the Codex section above is the authoritative record of the follow-up implementation.

---

## User Review Required

> [!IMPORTANT]
> **Business Calendar Standard (5x8 vs 24x7)**:
> - `5x8` calendar operates Monday to Friday, 9:00 AM to 5:00 PM (8 working hours = 480 minutes per working day). Weekends and non-working hours are excluded from elapsed time.
> - `24x7` calendar operates continuously across all 168 hours of the week.
> - If no SLA policy is configured for an `(item_type, state)` pair, `aging_score` is set to `0` and `aging_bucket` remains `green` — avoiding false aging alerts.

> [!NOTE]
> **Event Deduplication**:
> - `SLAWarning` (75% threshold) and `SLABreached` (100% threshold) events will be emitted once per state entry per work item to prevent duplicate notification spam during recurring 60-second recalculation ticks.

---

## Proposed Changes

### Database Layer

#### [MODIFY] [database.service.ts](file:///c:/Users/kiran/Cadena/src/database/database.service.ts)
- Add `sla_policies` table DDL:
  ```sql
  CREATE TABLE IF NOT EXISTS sla_policies (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id),
    item_type TEXT NOT NULL,
    state TEXT NOT NULL,
    threshold_minutes INT NOT NULL,
    calendar TEXT NOT NULL, -- '5x8' | '24x7'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (org_id, item_type, state)
  );
  ```
- Seed default tenant SLA policies per spec §6.1 on init:
  - `Story` + `In Review`: 960 mins (2 business days, `5x8`)
  - `Bug` + `In Progress`: 480 mins (1 business day, `5x8`)
  - `Incident` + `Investigating`: 60 mins (`24x7`)
  - `Incident` + `Triaged`: 120 mins (`24x7`)
  - `Change Request` + `CAB Review`: 1440 mins (3 business days, `5x8`)

---

### SLA Module (New Core Components)

#### [NEW] [sla-calculator.service.ts](file:///c:/Users/kiran/Cadena/src/modules/sla/sla-calculator.service.ts)
- Implement `SlaCalculatorService` with methods:
  - `calculateElapsedMinutes(enteredAt: Date, now: Date, calendar: '5x8' | '24x7'): number`
    - `24x7`: `(now.getTime() - enteredAt.getTime()) / 60000`
    - `5x8`: Iterates/calculates working hours between 9:00 AM and 5:00 PM Mon-Fri.
  - `computeAging(enteredAt: Date, now: Date, thresholdMinutes: number, calendar: '5x8' | '24x7')`:
    - `aging_score` = `(elapsedMinutes / thresholdMinutes) * 100`
    - `aging_bucket`:
      - `'green'` if `aging_score < 75`
      - `'amber'` if `75 <= aging_score <= 100`
      - `'red'` if `aging_score > 100`

#### [NEW] [aging-engine.service.ts](file:///c:/Users/kiran/Cadena/src/modules/sla/aging-engine.service.ts)
- Implement `AgingEngineService`:
  - `recomputeAgingForOrg(orgId: string): Promise<RecalculationSummary>`
  - Fetches active work items & tenant SLA policies.
  - Updates `aging_bucket` and `aging_score` in database.
  - Emits `SLAWarning` event on `InProcessEventBus` when score crosses 75%.
  - Emits `SLABreached` event on `InProcessEventBus` when score crosses 100%.
  - Starts 60-second background ticker (`setInterval`).

#### [NEW] [sla.controller.ts](file:///c:/Users/kiran/Cadena/src/modules/sla/sla.controller.ts)
- Endpoints:
  - `POST /sla-policies`: Create/update SLA policy.
  - `GET /sla-policies`: List tenant SLA policies.
  - `POST /aging/recompute`: Trigger manual aging recompute tick.

#### [NEW] [sla.module.ts](file:///c:/Users/kiran/Cadena/src/modules/sla/sla.module.ts)
- NestJS module encapsulating `SlaCalculatorService`, `AgingEngineService`, and `SlaController`.

#### [MODIFY] [app.module.ts](file:///c:/Users/kiran/Cadena/src/app.module.ts)
- Import and register `SlaModule`.

---

### UI Dashboard

#### [MODIFY] [index.html](file:///c:/Users/kiran/Cadena/public/index.html)
- Display SLA Runway indicator, aging score percentage, and calendar tag on WorkItem cards.
- Add "Recompute Aging" button and auto-refresh countdown to the toolbar.
- Add SLA policy management view/modal.

---

## Verification Plan

### Automated Tests (`npm test`)

1. **`US3.1` Test Suite (`test/us3.1.spec.ts`)**:
   - `US3.1: excludes weekend time on 5x8 business calendar`: Item entering state on Friday 4:00 PM has consumed 60 minutes (not 4380 wall-clock minutes) by Monday 10:00 AM.
   - `US3.1: fires no false aging alert when no threshold is configured`: Item sitting in state with no matching SLA policy retains `aging_bucket = 'green'` and `aging_score = 0`.

2. **`US3.2` Test Suite (`test/us3.2.spec.ts`)**:
   - `US3.2: updates bucket to amber at 80% and red >100% on recompute cycle`: Verify bucket turns amber at 80% consumption and turns red once >100% within ≤60s recompute.

3. **`US3.3` Test Suite (`test/us3.3.spec.ts`)**:
   - `US3.3: emits SLAWarning at 75% and SLABreached at 100%`: Verify `SLAWarning` and `SLABreached` events are emitted on `InProcessEventBus` with owner and team lead recipient data in payloads.

### Manual Verification
- Access Web UI on `http://localhost:3000`
- Click "Recompute Aging" or wait for 60s tick interval.
- Observe item aging badges flip between Green, Amber (SLA Warning), and Red (SLA Breached).
