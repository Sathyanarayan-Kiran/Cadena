# Walkthrough — Unified SDLC & ITSM Platform (Pilot)

A running record of what is built, how to try it, and what changed when.

**Current state:** Phase 0 pilot, Stage B backlog dogfooding, Epic 3 (aging/SLA), Epic 4 (traceability graph, now complete), Epic 6 (Git/CI), and Epic 7 (monitoring/APM) are implemented and verified.
**Verification:** 47 automated tests across 20 test files passing.

---

## What the platform does

One canonical `WorkItem` model and one state-machine engine serve both halves of the lifecycle — `Epic`, `Story`, `Release` on the delivery side and `Incident` on the operational side — with typed, queryable traceability across the seam between them.

The capability gap it closes (Spec §9): git, CI/CD and monitoring stay authoritative for their own data; this platform becomes authoritative for **work-item state and traceability**.

---

## Change log

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
npm test        # 47 tests across 20 files
npm run dev     # http://localhost:3000
```

The datastore is in-memory PGlite, so **restarting resets to the seed** — convenient for re-running the flows below.

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

Refresh the UI: a new `INC-*` card appears in **Triaged**, tagged SEV1/P0. Open it → **Monitoring evidence** shows the `Affects SVC-CHECKOUT-API` tag and the alert row. Re-send with a new `x-delivery-id` and the same `dedupe_key` — still one card, now reading `2 occurrences`.

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

**Pilot actions → Import 12-epic backlog** creates 12 epics, 38 stories and 38 parent-child relationships. Filter by **Epics**, open any story, and **Trace lineage → Upstream** walks the `child_of` edge to its parent epic.

### 5. Watch SLA aging bite

SLA badges read green on a fresh boot because nothing has aged. Open **SLA policies**, set `incident` / `Triaged` to a 1-minute threshold, save (it auto-recomputes), wait a minute, then **Pilot actions → Recompute SLA aging**. Cards flip amber then red, and the KPI and attention bar follow.

---

## Verification status

```
 Test Files  20 passed (20)
      Tests  47 passed (47)
```

| Area | Tests |
| --- | --- |
| Canonical model, custom fields, tenant isolation | `us1.1`, `us1.2`, `us1.3` |
| Versioned workflows, guards, external automation | `us2.1`, `us2.2`, `us2.3` |
| Aging & SLA across both calendars | `us3.1`, `us3.2`, `us3.3` |
| Typed links, lineage, **service impact** | `us4.1`, `us4.2`, **`us4.3`** |
| Git/CI integration | `us6.1`, `us6.2`, `us6.3` |
| Monitoring/APM integration | `us7.1`, `us7.2`, `us7.3` |
| RBAC, backlog dogfooding | `us10.3`, `stage-b-dogfooding` |

**Known QA limitation:** no browser backend has been available in this environment, so UI work is verified by static JavaScript parse checking and API-contract coverage, not by screenshot or interaction testing.

---

## What is not built

Named plainly so nobody mistakes the pilot for a product:

- **Epic 5** — no durable event bus. `InProcessEventBus` has the right envelope but no outbox, no Kafka, no dead-letter queue.
- **Epic 8** — events are emitted and dropped. Nothing routes `SLAWarning`, `SLABreached` or `IncidentAutoCreated` to email, Slack or Teams.
- **US10.3 hardening** — no real authentication. Tenant and actor role arrive in headers.
- **Epic 11** — no CMDB federation. Alert-discovered Services are lightweight stubs flagged `monitoring_discovery`.
- **Webhook signature verification** — both gateways trust the normalized body. See README *Production Boundaries*.
- **Epic 9** — no analytics materialized views or executive dashboards.
