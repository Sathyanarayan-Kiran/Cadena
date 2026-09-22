# Walkthrough — Unified SDLC & ITSM Platform (Pilot)

A running record of what is built, how to try it, and what changed when.

**Current state:** Phase 0 pilot plus the Phase 1 operational-visibility slice are implemented and verified: Epic 3 aging/SLA including durable hold-state suspension, Epic 4 traceability, all Epic 5 stories including transactional event delivery and asynchronous HTTP 202 webhook ingestion, Epic 6 Git/CI, Epic 7 monitoring/APM, Epic 8 notification/escalation, US9.1 team heatmap, US9.2 executive rollup, US9.3 interactive traceability, US9.4 flow metrics, US10.4 audit export, US10.7 SHA-256 verification, US10.9 authenticated tenant identity, US13.2 immutable cross-system correlation, US13.3 echo-loop suppression, provider-neutral US13.1 state-translation engine, and the partial US17.1 Jira/ServiceNow connector slice (native discovery, watermarked ingestion into canonical twins, and echo-suppressed state propagation, verified against deterministic API fakes), and the US20.2 connector-led management workspace. The canonical backlog is **20 epics / 73 stories**, with **36 done / 6 partial / 31 not started**.
**Verification:** 162 automated tests across 43 test files, plus 21 browser smoke tests driving the real page in pilot and connector-led modes.

---

## 2026-09-22 — US20.2 Connector-led management workspace (Claude)

The workspace now matches the product decision: Jira and ServiceNow are the systems of record, and Cadena governs their records.

- **Three interaction modes.** `CADENA_INTERACTION_MODE`:
  - **connector-led** is the default in staging and production. Local creation is refused, and the landing view is source health.
  - **pilot** is local only. The demo board stays, and **New work item** moves into **Pilot actions**.
  - **standalone** keeps local work management alongside connectors.
- **Landing view.** Tiles for connected sources, synchronized twins, worst lag and write-back queues, followed by per-source health cards with **Discover** and **Synchronize**, and an onboarding panel when nothing is connected.
- **Twin workspace.** Each twin shows its native key linked to Jira/ServiceNow, source, state, sync state, last successful sync, field authority, counterpart and write-back activity. A drawer explains who owns each field.
- **Governed edits.** Fields are read-only unless an outbound mapping exists. With state write-back enabled on a connector, a state change becomes an audited connector work order. It is executed on the source and translated to linked counterparts, and its echo is suppressed. Blocked edits are explained and audited. Nothing is changed locally.
- **Local sandbox.** `CADENA_CONNECTOR_SANDBOX=enabled` (local runtime only) runs the real adapters against in-process Jira/ServiceNow stand-ins for demos.

**Try it:** set `CADENA_INTERACTION_MODE=connector-led`, `CADENA_CONNECTOR_SANDBOX=enabled` and `SANDBOX_TOKEN=x`, then run `npm run dev`. Choose **Connect source**, use base URL `https://jira.sandbox.cadena.local`, any account email, `env:SANDBOX_TOKEN` and project `CAD`, and tick write-back. Then **Test → Discover → Activate → Synchronize** on the card, and open a twin.

**Still open:** connector twins do not yet feed the work-item SLA, traceability and metrics engines; only state has an outbound mapping; per-twin queues (US16.4/US16.5) come before multi-replica synchronization.

**Verified by** `test/us20.2.spec.ts` (7 tests), the browser suite (21 tests, including 4 connector-led), and 162 non-browser tests across 43 files.

---

## 2026-09-22 — US17.1 corrected: native Jira and ServiceNow connectors (Claude)

Claude reviewed the earlier US17.1 increment, found it fixture-only with state propagation unwired, and rebuilt the connector slice. **US17.1 is now partial rather than done.**

- **Jira Cloud REST v3** and **ServiceNow Table API** adapters. Discovery enumerates projects/tables, standard and custom fields, and state values. Ingestion is watermarked and paginated. State writes go through Jira transitions and ServiceNow state codes.
- **No network by default.** Adapters call providers only through an injected transport, and the live transport refuses requests unless `CADENA_CONNECTOR_LIVE_HTTP=enabled`.
- **Reference-only credentials.** Only `env:NAME` or `secret-ref://path` are accepted, plaintext is refused, and an unresolvable reference fails the operation.
- **Lifecycle with a capability check.** Test → Discover → Activate. Missing projects, tables or required fields block activation with HTTP 422 and a limitation list.
- **Connector-led propagation.** A changed native state passes US13.3 echo suppression and the published US13.1 mapping, then becomes an idempotent work order executed on the counterpart. Retryable failures back off; refusals are dead-lettered for review.
- **Health.** Last success, lag, consecutive failures, errors, twin count, cursors and work-order counts per connector.
- **Source connectors** dialog replaces the earlier native connectors dialog.

**Try it:** open **Source connectors** in the sidebar and connect Jira with an account email, `env:JIRA_API_TOKEN` and a project key. Then choose **Test**. Without `CADENA_CONNECTOR_LIVE_HTTP=enabled`, the card reports that live provider access is not authorised. The full lifecycle runs end to end in `test/us17.1.spec.ts`.

**Still open:** the other five providers, webhook-triggered ingestion, a poll scheduler, a multi-replica sync lease, and validation against a live Jira/ServiceNow tenant.

**Verified by** `test/us17.1.spec.ts` (11 tests), the browser smoke suite (16 tests), and 155 non-browser tests across 42 files.

---

## 2026-09-22 — US17.1 Native connectors, discovery and ingestion

Codex delivered native connector discovery and ingestion for external systems of record:

- Provider-neutral connector architecture (`ConnectorAdapter`) supporting connector registration, credentials reference resolution (`SecretManagerResolver`), connection testing, schema discovery, watermarked ingestion, and outbound state changes.
- Native Jira REST adapter (`JiraConnectorAdapter`) enumerating projects, issue types, standard fields (`summary`, `status`, `description`, `priority`, `assignee`) and custom fields (`customfield_*`), with JQL watermarked ingestion (`updated >= cursor_timestamp`).
- ServiceNow ITSM adapter boundary (`ServiceNowConnectorAdapter`) for Table API entities (`incident`, `change_request`).
- Materialized canonical twins in `integration_canonical_twins` and immutable correlation nodes in `integration_correlation_nodes`.
- Integrated with `StateMappingService` (US13.1) and `SyncGuardService` (US13.3) for echo-suppressed outbound work orders.
- Responsive **Native connectors & ingestion** management UI in `public/index.html`.

**Status (superseded):** recorded as complete at the time; the correction above returned US17.1 to partial.

---

## 2026-09-22 — Cloud staging foundation

Codex added the repository-side staging boundary without pretending that a cloud account is already running:

- `DATABASE_URL` selects pooled managed PostgreSQL while local development and tests retain embedded PGlite.
- Staging and production fail closed unless database TLS is verified, header impersonation is disabled and a strong bootstrap credential is supplied.
- Demo seeding is off by default outside local mode, and database credentials are never included in startup or request logs.
- `/health/live` and `/health/ready` are public probe endpoints; readiness proves schema initialization and a live database query.
- Requests emit structured JSON telemetry with a request id and latency, and shutdown drains HTTP before closing the datastore.
- The container runs as a non-root user. Kubernetes uses a read-only root filesystem, external secrets, TLS ingress and separate startup/liveness/readiness probes.
- CI verifies the application and container; the protected manual staging workflow publishes an immutable commit-SHA image and waits for rollout readiness.
- The runtime moved to NestJS 12 / Express 5 and CI rejects known high-severity production dependency advisories; the current production-only audit reports zero vulnerabilities.
- `deploy/staging/README.md` records provider prerequisites, secret binding, immutable rollback and the required database restore drill.
- `status.html` now shows infrastructure work as a separate platform milestone, so it does not distort product-story completion.

**Status:** implemented and locally validated, but not cloud-activated. No AWS/Azure/GCP account, managed PostgreSQL instance, cluster, DNS record, certificate or backup was created. kubectl v1.36.1 / Kustomize v5.8.1 successfully rendered the staging bundle. Docker Desktop 4.91.0 / engine 29.8.0 built the production image, which ran healthy as the non-root `node` user with a read-only root filesystem; both health endpoints returned HTTP 200 and graceful SIGTERM shutdown was observed. The product ledger remains **35 done / 5 partial / 33 not started** across **20 epics / 73 stories**.

**Next:** select the staging provider and region, activate this foundation, prove HTTPS/restore/rollback, then build the minimal US17.1 Jira/ServiceNow connector.

---

## 2026-09-22 — Versioned lifecycle state translation (US13.1)

Codex implemented the guarded mapping layer between correlated Jira/ServiceNow-style records:

- Mappings are tenant scoped and versioned as draft, published or superseded; a replacement publish preserves the earlier definition as history.
- Separate source-to-target and target-to-source rules map native lifecycle names without forcing either provider to adopt Cadena's terminology.
- Rules can require nested target fields and constrain the target's current state, so incomplete closure data or invalid jumps are held rather than guessed.
- Translation resolves both records through their immutable US13.2 counterpart identities and supports non-destructive dry runs.
- Committed evaluations persist an auditable `ready` connector work order or a `held` decision explaining a missing mapping, unmapped state, missing field or invalid transition.
- The workspace now has a **State mappings** dialog for drafting, reviewing and publishing matrices.
- `test/us13.1.spec.ts` covers both directions, versioning, preview, guards, durable decisions, audit events and tenant boundaries; the browser suite proves draft creation and publication through the built UI.

US13.1 moves from not started to **partial**, taking the canonical ledger to **35 done / 5 partial / 33 not started**.

**Boundary:** a ready work order has not yet called a native Jira or ServiceNow API. The story becomes complete when the US17.1 connector consumes it and verifies the remote counterpart transition. The next implementation step is the cloud staging foundation, followed by that connector slice.

---

## 2026-09-22 — Connector-led product direction

Codex reconciled the original local-work-management pilot with the newer integration-platform scope:

- Jira, ServiceNow and other connected tools remain authoritative by default for the fields they own.
- Cadena's `WorkItem` is the canonical internal twin used for correlation, transformation, policy, audit and analytics; connector ingestion normally creates or updates it.
- The target production journey is connect source → discover → map → synchronize → operate, not duplicate manual entry.
- US17.1 now includes ingestion that materializes an externally identified twin, not discovery alone.
- New US20.2 defines the management-console change: source and sync health are visible, externally owned edits use audited mappings, and local creation is available only in an explicitly enabled pilot, administrator or standalone mode.
- The recommended sequence is US13.1, cloud staging, the minimal Jira/ServiceNow US17.1 slice, US20.2, then US13.4 and US13.5.

**Implementation boundary:** this entry changes product scope and delivery order only. The current pilot UI still shows **New work item**, and no live Jira or ServiceNow connector is being claimed.

---

## 2026-09-22 — Bidirectional echo-loop suppression (US13.3)

Codex added the guard that prevents a connector from synchronizing its own write back to the origin:

- Outbound writes record a volatile `(tenant, node, service account, canonical payload hash)` marker and a durable normalized content snapshot.
- Returning webhooks with the exact service-account identity and SHA-256 payload hash receive `self_originated_hash` / `ignore`.
- The same actor with changed content receives `external_change` / `process`, so actor identity alone never hides a real change.
- After every volatile marker is cleared, identical normalized content still receives `content_noop` / `ignore` from the durable snapshot.
- All write records and decisions use the transactional outbox and verifiable tenant audit chain.
- `test/us13.3.spec.ts` proves canonical key-order independence, changed-content pass-through, restart/cache fallback, tenant isolation, validation and audit evidence.

US13.3 moves from not started to **done**, taking the canonical ledger to **35 done / 4 partial / 33 not started**.

**Boundary:** connectors must pass their normalized mapped fields and verified provider actor. Vendor-specific transformations, signature checks and actual outbound execution remain later connector work.

---

## 2026-09-22 — Immutable cross-system correlation (US13.2)

Codex added the identity graph that later bidirectional connectors will use:

- `integration_correlation_nodes` stores exact provider identities separately from mutable display keys and URLs.
- `integration_correlation_links` stores typed pair and dependency edges with tenant-qualified restrictive foreign keys, so a branch cannot reference a missing or cross-tenant node.
- `POST /integrations/correlations` creates or idempotently resolves a pair and returns the dedicated `cadena_counterpart_id` value for both systems.
- `GET /integrations/correlations/resolve` starts from an immutable identity and expands one-to-many or many-to-one dependencies to a requested depth without title matching.
- Re-posting a pair after a record rename or project move refreshes display metadata while preserving node and link identity; the metadata-only PATCH route refuses changes to immutable fields.
- Every correlation transaction is recorded through the transactional outbox and existing SHA-256 audit chain.
- `test/us13.2.spec.ts` proves reverse-pair deduplication, rename/move survival, tenant isolation, immutable-field rejection, branched traversal and orphan prevention.

US13.2 moves from not started to **done**, taking the canonical ledger to **34 done / 4 partial / 34 not started**.

**Boundary:** the contract returns the provider-field write-back values but does not claim live ServiceNow/Jira transport. Native credentials, discovery and outbound field writes remain US17.1.

---

## 2026-09-22 — Cryptographically verifiable audit export (US10.7)

Codex extended the US10.4 audit surface with tamper-evident evidence:

- `audit_integrity_entries` maintains an independent tenant-wide SHA-256 chain over canonical event envelopes, with stable JSON key ordering, sequence, previous hash, proof version and chain head.
- Canonical outbox writes append their proof in the business transaction; event-bus records append in the event-store transaction; workflow and severity audit rows append beside their mutation.
- Integration transactions are covered through the same durable domain-event route, not a special export-only calculation.
- Existing databases backfill missing proof rows deterministically on initialization without rewriting source history.
- `GET /audit/export` and the item-history route verify each current source event against its recorded proof and verify the stored tenant chain's continuity. A changed or deleted source row fails the overall export result.
- Item details show **SHA-256 chain verified** or a visible failure, with per-event proof metadata beside before/after evidence.
- `test/us10.7.spec.ts` proves field/transition/integration coverage, chain metadata, tenant isolation, source-tamper detection and upgrade backfill.

US10.7 moves from not started to **done**, taking the canonical ledger to **33 done / 4 partial / 35 not started**.

**Boundary:** the chain is not externally signed. It detects partial source or chain modification, but a database administrator capable of rewriting the entire chain and head remains outside the pilot trust boundary; external notarization or WORM anchoring is the production hardening step.

---

## 2026-09-21 — Full work-item audit export and history UI (US10.4)

Codex completed the compliance export promised by the technical specification rather than exposing transition rows alone:

- `GET /audit/workitems/:id` supplies the item-details timeline; `GET /audit/export?work_item_id=…` downloads the `cadena.audit-trail.v1` JSON document.
- The tenant-qualified projection combines canonical domain events and workflow audit rows, removes duplicate transition records, and includes links where the selected item is either endpoint.
- Creation, field edits, typed links, transitions and severity escalation expose actor, timestamp and normalized before/after values.
- `PATCH /workitems/:id` updates only mutable fields and atomically records `WorkItemFieldsChanged`; status edits are rejected so workflow guards cannot be bypassed.
- Item details now show a compact timeline with expandable evidence and an **Export JSON** action.
- `test/us10.4.spec.ts` proves event coverage, incoming links, actor/value evidence, the attachment contract, tenant isolation and edit boundaries; the browser suite drives the visible history and download.

US10.4 moves from partial to **done**, taking the canonical ledger to **32 done / 4 partial / 36 not started**. Cryptographic integrity metadata remains explicitly in US10.7.

---

## What the platform does

One canonical `WorkItem` model and one state-machine engine serve both halves of the lifecycle — `Epic`, `Story`, `Release` on the delivery side and `Incident` on the operational side — with typed, queryable traceability across the seam between them.

The capability gap it closes (Spec §9): git, CI/CD and monitoring stay authoritative for their own data; this platform becomes authoritative for **work-item state and traceability**.

---

## Change log

### 2026-09-21 — HTTP 202 webhook ingestion: accept first, process safely (US5.4)

Git and monitoring webhooks no longer hold the provider request open while artifacts, transitions and Incidents are mutated. A valid request writes its delivery plus an `InboundWebhookAccepted` outbox envelope in one transaction, then returns HTTP 202 with a delivery id and status URL.

**What changed**

- A serial worker processes accepted deliveries, so a burst creates visible `queued` depth rather than rejected requests or unbounded concurrent work.
- Delivery status exposes `queued`, `processing`, `completed` or `failed`, attempt count, the final result and any error.
- Duplicate delivery ids return the existing status without enqueuing a second job or repeating side effects.
- Processing failures retry three times and enter the existing per-consumer DLQ. An operator can correct the webhook body and replay the original event into the same delivery record.
- Startup requeues work left in `processing` and recovers committed outbox envelopes that were not dispatched before shutdown.
- `test/us5.4.spec.ts` proves acknowledgement-before-mutation, burst backpressure, duplicate delivery handling, retry/dead-letter and corrected replay.

US5.4 moves from not started to **done**, taking the canonical ledger to **29 done / 5 partial / 38 not started**. The complete non-browser regression passes **120 tests across 33 files**, and all **11 browser smoke tests** pass against the built server.

**Boundary:** acceptance is durable, but dispatch and processing still run in one application process. Horizontal worker leasing, long-duration retry scheduling and Kafka/MSK remain production-scale extensions.

### 2026-09-21 — Transactional outbox: a committed work-item change cannot lose its event

Durable event history existed, but it was written immediately after the business mutation. A process stop between those two statements left a changed work item with no event, exactly the failure US5.1 exists to prevent.

**What changed**

- Work-item creation, workflow transitions and typed-link creation now insert the business write, immutable `domain_events` envelope and pending `event_outbox` marker in one PGlite transaction.
- Publication happens only after commit and uses the already-committed `event_id`; it never invents a second logical event.
- Application bootstrap drains pending rows. A stop after commit but before publication therefore becomes an at-least-once redelivery, which the existing per-consumer idempotency layer safely deduplicates.
- A transition update now includes its expected source state. If another caller changes the item between validation and commit, the stale transition is rejected instead of overwriting the newer state.
- `test/us5.1.spec.ts` proves atomic create/transition/link events, full rollback when enqueue fails, and recovery of an undispatched envelope with the original identity.

US5.1 moves from partial to **done**, taking the canonical ledger to **28 done / 5 partial / 39 not started**. The complete non-browser regression passes **116 tests across 32 files**.

**Boundary at this increment:** the dispatcher remained in-process and bootstrap-driven, and US5.4 was still open. The US5.4 update above later added asynchronous HTTP ingestion; continuous multi-worker dispatch and Kafka/MSK remain open.

### 2026-09-21 — Phase 1 operational visibility: fair clocks, ordered attention, executive evidence

The team board already displayed SLA colours, but it did not prove worst-first ordering; leadership had no cross-team view; and work waiting on a customer or third party kept aging as if the team were actively working it. This increment closes those three connected gaps.

**US3.4 — durable SLA hold-state suspension**

- SLA policies can mark a state as `suspend_sla` through the API and policy editor.
- Entering a hold snapshots business-calendar minutes already consumed. Time does not advance while held, and leaving resumes from that retained total without back-filling the paused interval.
- Persisted elapsed, clock-start and suspension fields make the behaviour survive recomputation and process restart. Cards and item details explicitly say when the clock is paused.

**US9.1 — verified team aging heatmap**

- Cards remain ordered red → amber → green → ungoverned, then by descending score inside each bucket.
- The browser suite now creates red and fresh-green work in the same column and inspects the rendered card order across every column. The story is done on observed UI behaviour, not colour rendering alone.

**US9.2 — cross-team executive rollup**

- `GET /metrics/executive` returns tenant-scoped overall, business-unit and team metrics: current SLA compliance, average cycle time and aging distribution.
- Cycle time ends at the first completion transition in the audit trail, so background SLA recomputation cannot rewrite history. The response and UI state their evidence coverage.
- The responsive **Executive overview** presents portfolio KPIs and business-unit/team tables with compact aging bars.

This moves the canonical ledger to **27 done / 6 partial / 39 not started**. The full non-browser suite passes **112 tests across 31 files** and the browser suite passes **11 scenarios**.

### 2026-09-21 — Authentication: the tenant becomes something you prove

Every tenant boundary here was enforced against `x-org-id`, a header the caller supplies. Two rounds of review had already hardened the isolation logic around it — and that logic was correct — but it rested on a false premise: anyone could set that header to anything. The code looked rigorously tenant-safe and held only against a caller who wasn't trying.

**Added**

- `api_credentials`, storing bearer tokens **only as a SHA-256 hash**. Lookup is by that hash, so verification is an indexed equality test on a digest and no plaintext secret exists in the database.
- A global `AuthGuard` resolving a principal from a bearer token, with `CADENA_BOOTSTRAP_TOKEN` available to mint the first credential for a tenant.
- `GET /auth/me`, `POST|GET /auth/credentials`, `POST /auth/credentials/:id/revoke`.
- `test/us10.9.spec.ts` — 13 tests that run with header identity **disabled**, exercising the posture production actually uses.
- US10.9 added to the backlog, so completed work appears on the tracker rather than drifting off it.

**Two decisions worth recording**

*The migration is shallow on purpose.* Forty-nine call sites read the tenant from a header. Instead of rewriting them, the guard resolves the principal and then overwrites that header with the authenticated value — so those controllers keep working unchanged while what they read becomes something proven. A request whose header contradicts its credential is refused outright rather than silently corrected.

*Header identity is off by default,* the same discipline the data directory follows: the unsafe mode is never inherited by accident. The suite opts in once in `vitest.config.ts` rather than in twenty-three spec files, and `npm run dev` opts in so the pilot UI still works. `npm start` does not.

**A mistake worth recording.** The first attempt made dev mode inject a default `x-org-id`, which then collided with the work-item controller's own body-versus-header check and failed three tests. Dev mode must be behaviourally invisible; it now rewrites nothing.

**Verified live**, not only by test: with header mode off, `/workitems` returned 401 both bare and with an `x-org-id`; the static UI stayed reachable; the bootstrap token minted a credential; that token resolved its own tenant and roles; and a contradicting header produced 403.

**What this does not do.** It is not SSO. US10.1 and US10.2 remain unimplemented, and the pilot UI still has no login — it works only in dev mode. This is the verified-identity foundation those will build on.

**Tracker contract generalised.** Recording US10.9 exposed a limitation: `latest_delta` was a single object whose `current_*` counts had to equal the canonical backlog, so no story could ever be added outside that one delta. It is now an ordered `deltas` list; each entry must balance its own arithmetic and start where the previous finished, and only the newest describes the backlog as it stands.

### 2026-09-21 — Review remediation and master-backlog consolidation

An external review of `ebc53c2` found four functional risks and two documentation gaps. All are closed; the entry is recorded here because this document skipped the increment, which is exactly the drift a dated log exists to prevent.

**Functional fixes**

| Finding | Fix |
| --- | --- |
| DLQ operations were not tenant-isolated | `get`, `replay` and `discard` are scoped by tenant, and another tenant's entry reports **not found** rather than forbidden, so existence cannot be probed |
| Restart overwrote persisted configuration | Pilot seeding moved to `src/bootstrap/pilot-configuration.ts` and is now insert-only, so an operator's preferences, thresholds and escalation target survive a restart |
| Consumer idempotency raced under concurrent delivery | The check-then-act became a single atomic claim; exactly one of two simultaneous deliveries runs the side effect |
| SLA suppression was in-memory only | Emissions are recorded in `sla_emissions`, so a restart no longer re-notifies owners about work that already warned |

A defect the review did not raise was also closed: a process that died mid-handler left its claim in `processing` forever. Abandoned claims are now returned to `failed` at startup.

**A design decision that went the other way.** An earlier draft exposed an `untenanted_total` on `/dlq/depth`. It was removed, because a global failure count handed to every tenant leaks cross-tenant operational signal. The consequence is that an event with no resolvable tenant appears in no tenant view at all, so it is now logged when it happens: still invisible to the API, no longer silent. A platform-operator surface under its own authorization model is the real fix and is deliberately not built.

**Hardening from the follow-up review.** `DeadLetterService.list()` and `depth()` took an optional tenant and fell back to global scope when it was omitted — the same shape as the defect just fixed, reachable the moment a second caller appeared. The tenant is now a required argument, so the compiler rejects an unscoped query.

**Backlog consolidation.** `cadena-master-epics-and-user-stories.md` was reviewed against the canonical backlog rather than appended, since it carries its own Epic 1–10 numbering that would have collided with the existing Epic 1–16. Nine existing stories gained missing acceptance criteria and fifteen genuinely new stories were added across four new epics and six existing ones: **16 epics / 56 stories → 20 epics / 71 stories**, with every original id and delivery status preserved.

### 2026-09-20 — Reliable event consumption: idempotency, retry, dead letters (Epic 5)

Before this, `NotificationService` caught its own errors and logged them. A persistent fault produced a log line nobody reads and a notification nobody received. There was no retry, no record, and no way to recover the event.

**Added**

- `EventConsumerRegistry` — wraps every registered consumer with idempotency, retry and dead-lettering. Consumers stay ordinary async functions; they no longer carry that logic or swallow their own failures.
- `event_consumptions` keyed on (consumer, event_id): a redelivery is a no-op **per consumer**, which is what US5.2 actually asks for.
- `dead_letter_events` plus `DeadLetterService`: exhausted events are stored with payload, attempt count and error, and a `DeadLetterQueueAlert` fires carrying the current depth.
- `GET /dlq`, `GET /dlq/depth`, `POST /dlq/:id/replay`, `POST /dlq/:id/discard`.
- UI: a **Dead letters** view with the payload in an editable box, so an operator can correct a malformed event and re-inject it without asking the source system to resend.
- `test/us5.spec.ts` — 8 tests.

**The notification consumer was migrated onto the framework**, which is the point: the contract is proven on a production consumer, not only on test doubles. All 12 notification tests still pass, and a persistent notification fault now lands in the queue instead of a log line.

**Replay preserves identity.** A replay re-dispatches the *same* `event_id` to only the consumer that failed, so the audit trail stays continuous and other consumers are not re-triggered. A replay that fails again stays queued rather than vanishing.

| Story | State |
| --- | --- |
| US5.2 idempotent processing | **Done** |
| US5.3 DLQ with alerting | **Done** |
| US5.5 replay console | **Done** |
| US5.1 outbox | Partial at this 2026-09-20 increment — completed by the 2026-09-21 update above |
| US5.4 HTTP 202 ingestion | Deferred in this 2026-09-20 increment — completed by the 2026-09-21 update above |

**Historical note:** US5.4 was deliberately deferred in this increment because it changed the Epic 6 and 7 response contract. The dedicated 2026-09-21 slice above completed that migration and its regression coverage.

### 2026-09-20 — The datastore survives a restart

PGlite was running in-memory, so every `npm run dev` started from the seed. That collided directly with the flow metrics shipped an hour earlier: a 30-day DORA window is meaningless on a database that dies with the process. Deployment frequency, lead time and change failure rate could never show a trend because there was never more than one session of history.

**Added**

- `CADENA_DATA_DIR` selects the PGlite directory. `npm run dev` and `npm start` set it to `./data`; `npm run dev:ephemeral` keeps the old throwaway behaviour.
- `DatabaseService.createIsolated(dir)` for opening a directory outside the process singleton, plus `close()` and `isPersistent()`.
- The server now prints which mode it is in at boot, so it is never ambiguous.
- `npm run db:reset` removes the directory; `data/` is gitignored.
- `test/persistence.spec.ts` — 5 tests covering write/close/reopen, additive re-initialisation, retained event history, and isolation between directories.

**In-memory stays the default, deliberately.** Persistence is opt-in through the environment rather than a code default, so a test run or a throwaway script can never inherit a durable database by accident. The browser smoke suite goes further and forces `CADENA_DATA_DIR=''` on the server it spawns, because it seeds its own scenario and must start clean every run.

**Verified by actually restarting the server**, not just by unit test:

```
boot 1  💾 Datastore persisting to ./data
        created STORY-7893449E, 5 items total
        <process killed>
boot 2  💾 Datastore persisting to ./data
        5 items - STORY-7893449E still present
        services still 2, no re-seed, no duplication
```

The suite was then run with the directory deleted, confirming it creates none: 26 files, 76 tests, no `./data`.

**What this unblocks.** Metrics can now accumulate across sessions. Demos survive a restart. And real dogfooding — running this project's own work through the tool rather than importing a markdown file — stops being blocked on the database forgetting everything overnight.

### 2026-09-20 — Durable event history and flow metrics (US9.4)

The change failure rate is the number that justifies the traceability graph. In a two-tool world it is a manual tagging exercise nobody keeps accurate; here it falls out of the `Incident caused_by Release` edge that Epic 4 already stores.

**Added**

- `domain_events` table plus `EventStoreService`, subscribing to every published event through a new `subscribeAll` on the bus. The in-memory `emittedEvents` array is no longer the only record.
- `GET /events` — the durable history, filterable by type, work item and time range.
- `MetricsService` and `GET /metrics/flow?from=&to=` computing all four DORA metrics plus ITIL operational counts, entirely from recorded artefacts.
- `test/us9.4.spec.ts` — 7 acceptance tests over a real delivery history.
- UI: the nav's "Reports" placeholder is now a working **Flow metrics** view.

**Where each number comes from**

| Metric | Derived from |
| --- | --- |
| Deployment frequency | Epic 6 deployment artefacts, successful only |
| Lead time for changes | earliest commit linked to what a deployment shipped |
| Change failure rate | `Incident caused_by Release`, the Epic 4 edge |
| Time to restore | the incident's own transition history in `audit_events` |
| ITIL counts | incident severity, auto-created tags, `SLABreached` events, reopen transitions |

The change failure rate ships with the deployment/incident pairs behind it, so the figure can be audited rather than trusted. Coverage is reported too: lead time only counts deployments whose work items also carry a commit, and restore time only counts incidents with a recorded resolution.

**A contract gap this turned up.** `WorkItemStateChanged` carried no tenant, so a consumer could not tell which org a transition belonged to and the events fell out of every tenant-scoped query. `org_id` and `item_type` were added to the payload — additive, exactly as US5.1 requires — and the event store also resolves a tenant from the work item as a fallback, so no event is ever orphaned.

**Verified live** on the seeded tenant:

```
 deployment frequency: 1 in 30d, 0.23/week, {production: 1}
 change failure rate : 1 / 1 = 1.0
     evidence: INC-D3220784 caused_by REL-5E5DFF18 via live-deploy-6.0.0 SEV1
 events stored       : WorkItemCreated 2, IntegrationDeliveryProcessed 2,
                       WorkItemStateChanged 2, LinkCreated 1
```

### 2026-09-20 — Backlog import renamed from dogfooding to a fixture

The Stage B import was described as dogfooding, but the imported items never transition, never age, carry no owners, and no commit ever links to them. It is a realistic data fixture, not the team running its work through the tool. The code now says so: `importBacklogFixture`, `test/backlog-fixture.spec.ts`, and a UI label that states what it is for.

Real dogfooding stays blocked on persistence — PGlite runs in-memory, so the backlog would evaporate on every restart. Historical records in `implementation_plan.md` keep the original wording.

### 2026-09-20 — Browser smoke tests (QA limitation removed)

Every prior record in this file carried the caveat "no browser backend was available, so UI work is verified by static parse checking only." That caveat was inherited and never re-tested. Chrome is installed on this machine, so it was never true.

**Added**

- `puppeteer-core` as a devDependency. It uses a browser already on the machine, so there is no Chromium download.
- `test/ui-smoke.spec.ts` — 7 tests driving the real page in headless Chrome.
- `npm run test:ui`, which builds and then runs the smoke suite. `npm test` excludes it, so the fast suite stays fast.

**What it covers**

| Test | Asserts |
| --- | --- |
| Board renders | work cards, KPI totals, workflow columns, result summary |
| Incident drawer | Monitoring evidence section, affected service, SEV1, provider, Delivery evidence |
| Service impact | edge chains rendered, release reached two hops out, depth=1 narrows correctly |
| Notification log | `slack → email (fallback)` routing and status visible |
| Transition dialog | offers only workflow-permitted next states |
| Escalated filter | escalated work surfaces through the SLA health filter |
| Responsive | no horizontal overflow at 390px, mobile menu visible, **zero console errors** |

**Notes**

- It drives the **built server** (`dist/server.js`), not a Nest testing module. `ServeStaticModule` does not serve `public/` under vitest's transform — the root 404s — so an in-process app would test a page that never loads. Driving the real artifact is also more faithful.
- The suite skips rather than fails when no browser or no build is present, since both are environment gaps rather than product defects.
- It takes ~140 seconds, most of it waiting for a real SLA to age. `SlaCalculatorService` floors elapsed time to whole minutes, so a 1-minute threshold reads exactly 100% anywhere from 60 to 119 seconds; the seed waits past two minutes to cross the breach and escalation thresholds.

**Two bugs it caught — both in the tests, not the product.** Assertions compared against `innerText`, which returns *rendered* text, and `.column-title` and `.detail-section h3` are styled `text-transform: uppercase`. The UI was correct throughout; no product defect was found.

### 2026-09-20 — Epic 8: Notification & escalation service

Until now the aging engine emitted `SLAWarning` and `SLABreached` and **nothing listened** — there were no event-bus subscribers anywhere in the codebase. Epic 8 makes those events reach people.

**Added**

- `src/modules/notifications/` — `NotificationService` subscribes to `SLAWarning`, `SLABreached` and the new `SLAEscalated`, resolving recipients and dispatching per person.
- `notification_preferences`, `notification_settings`, `team_escalation_targets`, `notifications` tables. The last is both the delivery audit log and the idempotency key: a unique constraint on `(event_id, recipient_id)` means a replayed event notifies nobody twice.
- `SLAEscalated` emission in the aging engine at a configurable threshold (default 150%), plus an `escalated_at` marker on the work item.
- `GET /notifications`, `GET|POST /notifications/settings`, `GET|POST /notifications/preferences`, `POST /notifications/escalation-targets/:teamId`.
- `test/us8.1.spec.ts`, `test/us8.2.spec.ts`, `test/us8.3.spec.ts` — 12 acceptance tests.
- UI: a **Notifications** nav view showing the delivery log with routing and failure reasons, an **Escalated** option in the SLA health filter, and an Escalated badge on cards.
- Pilot seed now creates three people with notification preferences, so the flow is demonstrable out of the box.

**Routing rules**

| Event | Recipients |
| --- | --- |
| `SLAWarning` (75%) | owner |
| `SLABreached` (>100%) | owner + team lead |
| `SLAEscalated` (>=150%) | configured escalation target, falling back to an `on_call` then `team_lead` member of the team; owner stays on the thread so an escalation is never silent |

**Design notes**

- Channel adapters are pilot stubs — Spec §18.3 keeps external transports out of the pilot, so nothing is actually sent and the `notifications` table *is* the delivery record. Swapping in SES/Slack/Graph means replacing one `transmit` method; routing, fallback and audit are transport-independent.
- Two real failure modes drive the US8.3 email fallback: a person who chose a channel they have no address for, and a tenant-level `unavailable_channels` setting that simulates a transport outage.
- A notification failure can never break the aging tick that emitted it — the subscriber catches and logs.

**Verified live** on the seeded tenant, with Slack marked unavailable:

```
SLAWarning     owner              slack  -> email  [fallback_sent]
SLABreached    owner              slack  -> email  [fallback_sent]
SLABreached    team_lead          email  -> email  [sent]
SLAEscalated   escalation_target  teams  -> teams  [sent]
SLAEscalated   owner              slack  -> email  [fallback_sent]
```

### 2026-09-20 — US4.3: Service impact analysis (Epic 4 complete)

Epic 7 created `affects` edges between Incidents and Services, but nothing read them beyond a flat list. US4.3 turns them into the answer to the question the whole platform exists for: *given a service outage, which releases and stories are implicated?*

**Added**

- `src/modules/lineage/impact.types.ts`, `src/modules/lineage/impact.service.ts` — depth-limited traversal seeded from a Service's `affects` edges, then walking the work-item graph outward.
- `GET /services/:id/impact?depth=N&edge_types=...` — depth defaults to 3, clamps to 10, rejects a non-numeric depth with 422.
- `POST /services/:id/work-items` — records an `affects` edge by hand. Until now only the monitoring gateway could create one, so a manually raised Incident had no way to declare what it affects.
- `test/us4.3.spec.ts` — 6 acceptance tests.
- UI: the nav's "Traceability" placeholder is now a working **Service impact** view with a service picker and depth selector.

**Design notes**

- The walk is **undirected**. The backlog asks for "all affected work items within a specified depth"; an implicated Release sits *upstream* of the Incident it caused while a remediating Story sits *downstream*, so filtering by direction would drop one or the other.
- Every result carries the `via` edge chain that implicates it, so a reader can judge relevance rather than trust an opaque list.
- `open_incidents` counts incidents not in `Resolved`/`Closed`. `Mitigated` deliberately still counts as open, because Epic 7 automation can propose mitigation but a human has not yet confirmed it.

**Verified live** against the seeded tenant:

```
service: SVC-CHECKOUT-API | summary: {total: 5, by_type: {incident: 2, release: 1, story: 2},
                                      open_incidents: 2, highest_severity: 'SEV1'}
  1  INC-C34B393A  incident  Checkout API 5xx spike
       via: SVC-CHECKOUT-API ~affects~ INC-C34B393A
  2  REL-2D2344CD  release   Release 4.2.0
       via: ... -> INC-C34B393A ~caused_by~ REL-2D2344CD
  3  STORY-C1D04C6C story    Bug Fix: UUID Schema Parser Sanitization
       via: ... -> STORY-C1D04C6C ~deployed_in~ REL-2D2344CD
  4  INC-2FD0F78A  incident  Incident: DB Connection Timeout in EU-West-1
       via: ... -> INC-2FD0F78A ~fixed_by~ STORY-C1D04C6C
```

### 2026-09-20 — Epic 7: Monitoring/APM integration

- `POST /integrations/monitoring/webhooks` for normalized `alert_fired` / `alert_resolved` events, idempotent on tenant + provider + delivery id.
- SEV1–SEV4 severity mapping from provider vocabularies; unknown values map to SEV3 and report `matched: false`.
- Automatic Incident creation in `Triaged` via the standard workflow path, with a per-tenant rolling dedupe window and severity escalation on recurrence.
- Service/Asset registry (`services`, `work_item_service_links`) as a Spec §3.3 *supporting entity*, deliberately not a WorkItem.
- Resolution proposes `Mitigated` for human confirmation and never `Resolved`/`Closed`, walking the real workflow one guarded step at a time.
- `IntegrationSupport` extracted so the Git/CI and monitoring gateways share one implementation of idempotency and automation safety.
- UI: "Monitoring evidence" section on the Incident drawer.

Full detail in `implementation_plan.md` under *Codex Epic 7 monitoring update*.

### 2026-09-20 — Epic 6 + US2.3: Git/CI integration

- Normalized `push` / `pull_request` / `deployment` webhooks with commit, PR and deployment artifacts.
- Guard-aware PR-merge and deployment automation; rejected transitions are skipped and logged, never forced.
- Stable tenant-unique keys (`EPIC-*`, `STORY-*`, `INC-*`, `REL-*`) and the `Release` work-item type.
- UI: "Delivery evidence" on the item drawer, board/list workspace overhaul.

### 2026-09-19 — Stabilization and workspace overhaul

- Built-in enforced workflows for Epic, Story, Incident; `GET /workitems/:id/available-transitions`.
- Tenant scoping on detail, transition, relationship and lineage operations.
- Responsive team workspace replacing the demo card grid; SLA policy management; safe DOM rendering.

### 2026-09-18 — Epic 3: Aging & SLA engine

- **US3.1** `SlaCalculatorService`: `5x8` (Mon–Fri 09:00–17:00 UTC, 480 min/day) and `24x7` calendars. An item entering Friday 16:00 has consumed 60 minutes by Monday 10:00. No policy configured means no false alert (`aging_score = 0`, `green`).
- **US3.2** `AgingEngineService`: 60-second tick plus `POST /aging/recompute`; buckets at green <75%, amber 75–100%, red >100%.
- **US3.3** `SLAWarning` at 75% and `SLABreached` at 100% on the event bus, with owner and team-lead notification payloads.

---

## Try it

```bash
npm install
npm test        # 116 tests across 32 files
npm run test:ui # 11 browser smoke tests in headless Chrome
npm run dev     # http://localhost:3000
```

`npm run dev` persists to `./data`, so work survives a restart. Use `npm run db:reset` to start clean, or `npm run dev:ephemeral` for a throwaway in-memory run.

### 1. A monitoring alert becomes an Incident

Epic 7 has no UI trigger (a real provider posts the webhook), so fire it with curl and watch the UI react:

```bash
curl -X POST http://localhost:3000/integrations/monitoring/webhooks \
  -H "x-org-id: 00000000-0000-0000-0000-000000000099" \
  -H "x-delivery-id: demo-1" -H "Content-Type: application/json" \
  -d '{"provider":"datadog","event_type":"alert_fired","alert":{
        "id":"evt-1","dedupe_key":"checkout-latency",
        "title":"Checkout API p99 latency above 2s","severity":"critical",
        "service":"checkout","environment":"production"}}'
```

The request returns HTTP 202 with a `status_url`. Poll that URL with the same `x-org-id` until it reports `completed`, then refresh the UI: a new `INC-*` card appears in **Triaged**, tagged SEV1/P0. Open it → **Monitoring evidence** shows the `Affects SVC-CHECKOUT-API` tag and the alert row. Re-send with a new `x-delivery-id` and the same `dedupe_key` — still one card, now reading `2 occurrences` after that delivery completes.

### 2. Automation proposes, a human confirms

```bash
curl -X POST http://localhost:3000/integrations/monitoring/webhooks \
  -H "x-org-id: 00000000-0000-0000-0000-000000000099" \
  -H "x-delivery-id: demo-3" -H "Content-Type: application/json" \
  -d '{"provider":"datadog","event_type":"alert_resolved","alert":{
        "id":"evt-3","dedupe_key":"checkout-latency",
        "title":"Checkout API p99 latency above 2s","severity":"critical"}}'
```

The card moves to **Mitigated** — not Resolved, not Closed. Then set the sidebar role to **Developer** and try **Move → Resolved**: rejected with *actor lacks role 'incident_commander'*. Switch to **Incident commander** and it succeeds.

### 3. Trace impact from a service

Link the incident to what caused it, then open **Service impact** in the sidebar:

```bash
# create a Release, then from the Incident: caused_by -> Release
curl -X POST http://localhost:3000/workitems/<INCIDENT_ID>/links \
  -H "x-org-id: 00000000-0000-0000-0000-000000000099" -H "Content-Type: application/json" \
  -d '{"target_id":"<RELEASE_ID>","link_type":"caused_by"}'
```

Pick `SVC-CHECKOUT-API`, set depth to 3–4, and the view lists every implicated item with the edge chain that implicates it. Drop depth to 1 to see only what directly touches the service.

### 4. Import the real backlog and trace lineage

**Pilot actions → Import 12-epic backlog** creates 12 epics, 38 stories and 38 parent-child relationships. Filter by **Stories**, open one and choose **Trace lineage**. The explorer renders upstream and downstream branches together with typed arrows; select 1–10 hops, use **Expand one level**, select a node to inspect its relationships, or make that node the new graph root. **Export full report** downloads a timestamped JSON snapshot of the complete connected graph; that stored report remains unchanged if the live graph is edited later.

### 5. Watch SLA aging bite, and see who gets told

Open **SLA policies**, set `story` / `In Review` to a 1-minute threshold and save. Create a story owned by Ada Owner, move it to In Review, then wait and use **Pilot actions → Recompute SLA aging**. Cards flip amber then red then pick up an Escalated badge past 150%.

Open **Notifications** to see the resulting delivery log. To watch the US8.3 fallback, mark Slack unavailable first — Ada prefers Slack, so her notifications will route `slack -> email` and say why:

```bash
curl -X POST http://localhost:3000/notifications/settings \
  -H "x-org-id: 00000000-0000-0000-0000-000000000099" \
  -H "Content-Type: application/json" \
  -d '{"unavailable_channels":["slack"]}'
```

Note that SLA badges read green on a fresh boot because nothing has aged yet, so the tight threshold is what makes this visible quickly.

---

## Verification status

```
 Test Files  35 passed (35)
      Tests  126 passed (126)
```

Plus the browser smoke suite, run separately because it builds and takes ~140 seconds:

```
npm run test:ui
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

| Area | Tests |
| --- | --- |
| Canonical model, custom fields, tenant isolation | `us1.1`, `us1.2`, `us1.3` |
| Versioned workflows, guards, external automation | `us2.1`, `us2.2`, `us2.3` |
| Aging & SLA across both calendars, including durable hold-state suspension | `us3.1`, `us3.2`, `us3.3`, **`us3.4`** |
| Typed links, lineage, **interactive explorer, service impact and immutable report export** | `us4.1`, `us4.2`, **`us4.3`, `us4.4`, `us9.3`** |
| Git/CI integration | `us6.1`, `us6.2`, `us6.3` |
| **Executive rollup, DORA & ITIL flow metrics** | **`us9.2`, `us9.4`** |
| **Datastore persistence** | **`persistence`** |
| **Transactional outbox, recovery, idempotency, retry and dead letters** | **`us5.1`, `us5`** |
| **Notification & escalation routing** | **`us8.1`, `us8.2`, `us8.3`** |
| Monitoring/APM integration | `us7.1`, `us7.2`, `us7.3` |
| Authenticated tenant identity, RBAC, backlog fixture | **`us10.9`**, `us10.3`, `backlog-fixture` |
| **Rendered heatmap ordering, interactive lineage, report export and executive overview** | **`ui-smoke`** |

**QA coverage:** UI work is now verified in headless Chrome against the built server, including console-error and responsive checks. Not covered: visual regression (no screenshot baselines), cross-browser behaviour (Chrome only), and accessibility auditing beyond the keyboard and ARIA attributes already in the markup.

---

## What is not built

Named plainly so nobody mistakes the pilot for a product:

- **Epic 5 production boundary** — work-item mutations and HTTP 202 webhook acceptance use a transactional outbox, and consumption is idempotent, retried and dead-lettered, but dispatch and processing are still in-process. There is no Kafka/MSK, continuous multi-worker leasing or long-duration retry scheduler.
- **Epic 8 transports** — routing, fallback and the delivery log are real, but no message actually leaves the process. The channel adapters are stubs awaiting SES/SendGrid, the Slack Web API and Microsoft Graph. `IncidentAutoCreated` is also not yet routed; only the three SLA events are.
- **Identity hardening** — bearer credentials now prove tenant and principal in production mode, but SSO/OIDC/SAML, SCIM, a login UI and provider-specific integration credentials are not built. Dev mode still permits explicit header identity for the pilot UI.
- **Epic 11** — no CMDB federation. Alert-discovered Services are lightweight stubs flagged `monitoring_discovery`.
- **Webhook signature verification** — both gateways trust the normalized body even though production requests now require an authenticated API principal. See README *Production Boundaries*.
- **Epic 9 scale boundary** — US9.1–US9.4 are built, including the interactive graph explorer, but there are no analytics materialized views. Metrics are computed per request and should move to reporting projections before production-scale load.
