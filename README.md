# Unified SDLC & ITSM Platform — Pilot Build

This repository contains the pilot implementation of the Unified SDLC & ITSM platform as specified in the **Technical Specification** and **Backlog**.

The pilot proves the platform's core thesis: **one canonical work-item model** and **one state-machine engine** serving delivery item types (`Epic`, `Story`, `Release`) and operational item types (`Incident`), with real, queryable traceability between them.

> **Current status (Codex update, 2026-09-21):** Phase 0, the complete Epic 3 aging/SLA engine including durable hold-state suspension, the complete Epic 4 traceability graph, the Epic 5 transactional outbox, reliable-consumption paths and HTTP 202 webhook ingestion, the Epic 8 notification and escalation service, the Phase 1 team heatmap and cross-team executive rollup, US9.4 DORA/ITIL metrics, and the integration slices (US2.3, Epic 6 Git/CI, and Epic 7 monitoring/APM) are implemented. The canonical backlog contains **20 epics and 72 stories**, with **29 done / 5 partial / 38 not started**. See `implementation_plan.md` for clearly attributed Codex delivery records and `status.html` for the generated ledger.

---

## Technical Stack & Architecture

- **Runtime & Framework**: TypeScript throughout, NestJS backend API.
- **Datastore**: PostgreSQL with `pgvector` enabled via the `@electric-sql/pglite` in-process WASM engine, persisting to `CADENA_DATA_DIR` and in-memory when that is unset.
- **Workflow Engine**: Hand-rolled state-machine engine implementing Spec §4, supporting versioned definitions, role guards, required fields, and reachability validation.
- **Traceability Graph**: Typed edge table (`work_item_links`) supporting upstream and downstream recursive lineage traversal, plus depth-limited impact analysis from a Service across the `affects` edge.
- **Aging & SLA**: 60-second recalculation, 5×8 and 24×7 calendars, persisted aging score/bucket, warning/breach events, and durable pause/resume semantics for configured hold states.
- **Git/CI Gateway**: Idempotent normalized webhooks, commit/PR/deployment artifacts, work-item key matching, external links, and workflow-safe automation.
- **Monitoring/APM Gateway**: Idempotent alert ingestion, SEV1–SEV4 severity mapping, auto-created `Triaged` Incidents, a configurable dedupe window, and mitigation proposed for human confirmation.
- **Service/Asset Registry**: Tenant-scoped lightweight CMDB entries (Spec §3.3) joined to Incidents by the §3.2 `affects` edge — a supporting entity, not a WorkItem.
- **Transactional Event Backbone**: Canonical work-item creation, transitions and typed links commit their immutable event and outbox marker atomically; inbound webhooks persist before returning HTTP 202 and process from a queryable queue; pending envelopes recover on bootstrap with the same event id, and every consumer runs behind idempotency, retry and a dead-letter queue with operator replay.
- **Event History & Metrics**: Every domain event is persisted to `domain_events`, with DORA/ITIL flow metrics and tenant-scoped executive rollups computed from recorded artefacts rather than hand entry.
- **Notification & Escalation**: Event-bus subscribers routing SLA warnings, breaches and escalations to each person's preferred channel with email fallback and a queryable delivery log.
- **Pilot UI**: Responsive board/list workspace, explicitly verified worst-first SLA heatmap, workflow-driven transitions, hold-state policy configuration, executive overview, item details, linking, lineage exploration, service impact, monitoring evidence, and notification delivery logs.
- **Testing**: Vitest + NestJS Testing + Supertest running 120 automated tests across 33 test files, plus an 11-test headless-Chrome smoke suite (`puppeteer-core`) driving the built server.

---

## How to Run

### 1. Run Automated Test Suite (Single Command)

To run the complete test suite covering Epics 1, 2, 3, 4, 6, 7, 8, 9, and 10 plus Stage B dogfooding:

```bash
npm test
```

Expected output:
```
 ✓ test/us1.1.spec.ts (2 tests)
 ✓ test/us1.2.spec.ts (2 tests)
 ✓ test/us1.3.spec.ts (2 tests)
 ✓ test/us2.1.spec.ts (2 tests)
 ✓ test/us2.2.spec.ts (2 tests)
 ✓ test/us2.3.spec.ts (1 test)
 ✓ test/us3.1.spec.ts (2 tests)
 ✓ test/us3.2.spec.ts (2 tests)
 ✓ test/us3.3.spec.ts (2 tests)
 ✓ test/us3.4.spec.ts (2 tests)
 ✓ test/us4.1.spec.ts (2 tests)
 ✓ test/us4.2.spec.ts (1 test)
 ✓ test/us4.3.spec.ts (6 tests)
 ✓ test/us6.1.spec.ts (2 tests)
 ✓ test/us6.2.spec.ts (1 test)
 ✓ test/us6.3.spec.ts (1 test)
 ✓ test/us7.1.spec.ts (7 tests)
 ✓ test/us7.2.spec.ts (3 tests)
 ✓ test/us7.3.spec.ts (4 tests)
 ✓ test/us8.1.spec.ts (3 tests)
 ✓ test/us8.2.spec.ts (4 tests)
 ✓ test/us8.3.spec.ts (5 tests)
 ✓ test/us9.2.spec.ts (3 tests)
 ✓ test/us9.4.spec.ts (7 tests)
 ✓ test/tracker.spec.ts (6 tests)
 ✓ test/persistence.spec.ts (5 tests)
 ✓ test/us5.1.spec.ts (4 tests)
 ✓ test/us5.spec.ts (10 tests)
 ✓ test/review-regressions.spec.ts (7 tests)
 ✓ test/us10.3.spec.ts (1 test)
 ✓ test/us10.9.spec.ts (13 tests)
 ✓ test/backlog-fixture.spec.ts (1 test)

 Test Files  32 passed (32)
      Tests  116 passed (116)
```

### 2. Run the Server

```bash
npm run dev            # persists to ./data, survives a restart
npm run dev:ephemeral  # in-memory, discarded on exit
npm run db:reset       # delete the data directory and start clean
```

The datastore is selected by `CADENA_DATA_DIR`. **In-memory is the default when that variable is unset, and that is deliberate**: a test run or a throwaway script must never inherit a durable database by accident, so persistence is opted into rather than assumed. `npm run dev` and `npm start` set it to `./data`, which is gitignored.

The server states its mode at boot:

```
💾 Datastore persisting to ./data
⚠️  Datastore is in-memory; all data is discarded on exit. Set CADENA_DATA_DIR to persist.
```

Schema creation is additive — `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — so reopening an existing directory with a newer build migrates it rather than resetting it. Demo seeding is guarded on an empty tenant and every supporting insert is an upsert, so a restart never duplicates the seed.

**Boundary:** this is a single-process embedded datastore. It is durable across restarts but is not a managed Postgres: no replication, no point-in-time recovery, and no concurrent access from a second process. Backing up means copying the directory while the server is stopped.

### 3. Run Browser Smoke Tests

Drives the real page in headless Chrome against the built server. Uses a browser already installed on the machine, so there is no Chromium download; the suite skips if none is found.

```bash
npm run test:ui
```

It covers board rendering, the Incident monitoring-evidence drawer, Service impact edge chains, the notification delivery log including Slack-to-email fallback, workflow-permitted transitions, the escalated filter, console errors, and phone-width layout.


---

## What Was Deliberately Stubbed

Per Spec §18.3, the following components were deliberately stubbed for the Phase 0 pilot:

1. **Event Bus (Spec §8)**:
   - **Stub**: Implemented as `InProcessEventBus` (`src/modules/events/event-bus.ts`).
   - **Envelope Contract**: Strictly conforms to Spec §8.2 (`event_id`, `event_type`, `schema_version`, `timestamp`, `actor`, `work_item_id`, `payload`).
   - **Extension Path**: Can be swapped for Apache Kafka or AWS EventBridge/MSK in Phase 1 without modifying domain logic or calling contracts.

2. **Single Sign-On (US10.1) and SCIM provisioning (US10.2)**:
   - **Not implemented.** US10.9 supplies verified credential-based identity that SSO will build on, but there is no OIDC or SAML flow and the pilot UI has no login screen.
   - **Extension Path**: hosted SSO/SCIM providers (WorkOS / Okta / SAML / OIDC) plug in behind the same `AuthGuard` that already resolves a principal.

---

## Git/CI Webhook Contract

The integration gateway accepts a normalized provider payload. Every request requires `x-org-id` plus a stable delivery identifier in `x-delivery-id`, `x-github-delivery`, or `delivery_id`. A valid request is persisted and returns HTTP 202 with `delivery_id`, current `status` and `status_url`; artifact linking and workflow mutations run asynchronously.

```http
POST /integrations/git/webhooks
x-org-id: 00000000-0000-0000-0000-000000000099
x-delivery-id: github-delivery-123
Content-Type: application/json

{
  "provider": "github",
  "event_type": "pull_request",
  "repository": "cadena/platform",
  "action": "merged",
  "pull_request": {
    "id": 482,
    "title": "Ship STORY-1A2B3C4D",
    "merged": true,
    "state": "closed"
  }
}
```

Supported event types are `push`, `pull_request`, and `deployment`. Linked evidence is available at `GET /workitems/:id/external-links`; poll `GET /integrations/git/deliveries/:deliveryId?provider=github` until `status` is `completed` or `failed`. Completed deliveries expose the former synchronous response under `result`.

---

## Monitoring/APM Webhook Contract

The monitoring gateway accepts a normalized provider payload. Every request requires `x-org-id` plus a stable delivery identifier in `x-delivery-id`, `x-monitoring-delivery`, or `delivery_id`. A valid request is persisted and returns HTTP 202 before alert evidence or Incident state is mutated.

```http
POST /integrations/monitoring/webhooks
x-org-id: 00000000-0000-0000-0000-000000000099
x-delivery-id: datadog-delivery-4821
Content-Type: application/json

{
  "provider": "datadog",
  "event_type": "alert_fired",
  "alert": {
    "id": "monitor-4821-evt-9",
    "dedupe_key": "checkout-api-latency",
    "title": "Checkout API p99 latency above 2s",
    "description": "p99 latency breached the 2s objective for 5 consecutive minutes.",
    "severity": "critical",
    "monitor_name": "checkout-api-latency-slo",
    "url": "https://app.datadoghq.example/monitors/4821",
    "runbook_url": "https://runbooks.example/checkout-latency",
    "service": "checkout-api",
    "host": "ip-10-0-3-22",
    "environment": "production",
    "triggered_at": "2026-09-20T09:00:00.000Z"
  }
}
```

Supported event types are `alert_fired` and `alert_resolved`. `dedupe_key` groups repeat firings of the same underlying issue and falls back to `alert.id`. Either `service`, `service_key`, or `host` is matched against the Service registry.

### What the gateway does

| Event | Behaviour |
| --- | --- |
| `alert_fired`, at or above the tenant threshold, no open Incident | Creates an Incident in `Triaged` with severity mapped from the alert, links the alert artifact `detected_by`, and adds an `affects` edge to the matching Service |
| `alert_fired`, same `dedupe_key` inside the dedupe window | Updates the open Incident: records the occurrence, escalates severity if the recurrence is worse, and creates no duplicate |
| `alert_fired`, same `dedupe_key` outside the window or after the Incident settled | Creates a new Incident |
| `alert_fired`, below the tenant `min_severity` | Records the alert as evidence and returns `suppressed_below_threshold`; no Incident is created |
| `alert_resolved` | Proposes `Mitigated` for human confirmation. Never `Resolved` and never `Closed` |
| Replayed delivery id | Returns HTTP 202 with `duplicate: true` and the existing delivery status; polling returns the original result and no side effect is repeated |

### Severity mapping

| SEV | Priority | Provider values recognized |
| --- | --- | --- |
| SEV1 | P0 | `critical`, `crit`, `fatal`, `emergency`, `disaster`, `page`, `sev1`, `p1`, `1` |
| SEV2 | P1 | `error`, `high`, `major`, `severe`, `alert`, `sev2`, `p2`, `2` |
| SEV3 | P2 | `warning`, `warn`, `medium`, `moderate`, `degraded`, `sev3`, `p3`, `3` |
| SEV4 | P3 | `info`, `informational`, `low`, `minor`, `notice`, `ok`, `sev4`, `p4`, `4` |

An unrecognized or absent provider severity maps to **SEV3** and is returned with `severity.matched: false`, so a missing mapping is visible rather than silently dropping a real alert.

### Tenant configuration

```http
POST /integrations/monitoring/settings
x-org-id: 00000000-0000-0000-0000-000000000099

{
  "min_severity": "SEV3",
  "dedupe_window_minutes": 60,
  "default_team_id": "00000000-0000-0000-0000-000000000001",
  "automation_actor_role": "on_call",
  "auto_register_services": true
}
```

`automation_actor_role` is the role the integration presents to the workflow engine when it proposes mitigation. It is evaluated by the transition guard like any other actor role, not trusted: if the configured role fails the guard, the transition is recorded as skipped with its reason and the Incident is left where it was.

Alert evidence is available at `GET /workitems/:id/monitoring-alerts` (and through the shared `GET /workitems/:id/external-links`); poll `GET /integrations/monitoring/deliveries/:deliveryId?provider=:provider` for `queued`, `processing`, `completed` or `failed` state and the eventual `result`.

---

## Service/Asset Registry

Spec §3.3 lists **Service/Asset** as a *supporting entity* — "lightweight internal CMDB entry (name, owner team, environment)" — and §3.5 draws `SERVICES ||--o{ WORK_ITEMS : affected_by`. The pilot follows that: Services live in their own tenant-scoped `services` table and join to WorkItems through `work_item_service_links`, carrying the §3.2 `affects` edge. **A Service is not a WorkItem**, so infrastructure inventory never lands on the delivery board or acquires a delivery workflow and SLA bucket.

```http
POST /services
x-org-id: 00000000-0000-0000-0000-000000000099

{
  "name": "Payments API",
  "service_key": "payments-api",
  "owner_team_id": "00000000-0000-0000-0000-000000000001",
  "environment": "production",
  "aliases": ["payments-api", "ip-10-0-3-22"]
}
```

Alert identifiers are matched case-insensitively against the service key, display name, external reference, and aliases. When no entry matches and `auto_register_services` is on, a `monitoring_discovery` stub is registered so the `affects` edge and impact analysis keep working while the entry awaits Epic 11 CMDB reconciliation. `GET /services/:id/work-items` returns everything currently affecting that Service.

Incident ownership comes from the Service's `owner_team_id` first, then the tenant's `default_team_id`. If neither is available the webhook returns HTTP 422 naming both ways to fix it.

---

## Service Impact Analysis (US4.3)

Once Incidents carry `affects` edges, a Service answers the question the platform exists to close: *which releases and stories are implicated by this outage?*

```http
GET /services/:id/impact?depth=3
x-org-id: 00000000-0000-0000-0000-000000000099
```

```json
{
  "service": { "service_key": "SVC-CHECKOUT-API", "name": "Checkout API" },
  "depth": 3,
  "summary": {
    "total": 3,
    "by_type": { "incident": 1, "release": 1, "story": 1 },
    "open_incidents": 1,
    "highest_severity": "SEV1"
  },
  "impacted": [
    {
      "work_item": { "key": "REL-2D2344CD", "type": "release", "status": "Deployed" },
      "distance": 2,
      "via": [
        { "link_type": "affects",   "from_key": "SVC-CHECKOUT-API", "to_key": "INC-C34B393A" },
        { "link_type": "caused_by", "from_key": "INC-C34B393A",     "to_key": "REL-2D2344CD" }
      ]
    }
  ]
}
```

`depth` defaults to 3 and clamps to 10; a non-numeric value returns 422. `edge_types` narrows which work-item edges the walk may follow.

**The walk is undirected by design.** The backlog asks for "all affected work items within a specified depth", and an implicated Release sits upstream of the Incident it caused while a remediating Story sits downstream — filtering by direction would drop one or the other. Every node therefore carries the `via` edge chain that implicates it, so a reader can judge relevance rather than trust an opaque list.

`open_incidents` counts incidents not in `Resolved`/`Closed`. `Mitigated` still counts as open, because Epic 7 automation can propose mitigation but a human has not yet confirmed it.

`affects` edges are created by the monitoring gateway automatically, or by hand:

```http
POST /services/:id/work-items
{ "work_item_id": "<incident id>" }
```

---

## Notification & Escalation (Epic 8)

The aging engine has always published `SLAWarning` and `SLABreached`. Until Epic 8 nothing subscribed to them, so they went nowhere. The notification service is the platform's first event-bus consumer.

### Routing

| Event | Fires at | Recipients |
| --- | --- | --- |
| `SLAWarning` | 75% of threshold | owner |
| `SLABreached` | over 100% | owner + team lead |
| `SLAEscalated` | tenant threshold, default 150% | configured escalation target, plus the owner |

The escalation target resolves in order: the team's configured `escalation_person_id`, then a team member with the `on_call` role, then one with `team_lead`. The owner stays on an escalation thread so it is never silent.

### Channels and fallback (US8.3)

Each person picks a channel; delivery that fails falls back to email, and both attempts are recorded.

```http
POST /notifications/preferences
x-org-id: 00000000-0000-0000-0000-000000000099

{ "person_id": "...", "channel": "slack", "address": "@ada" }
```

```json
{
  "event_type": "SLABreached",
  "recipient_role": "owner",
  "requested_channel": "slack",
  "channel": "email",
  "status": "fallback_sent",
  "attempts": [
    { "channel": "slack", "delivered": false, "error": "no slack address is configured for this recipient" },
    { "channel": "email", "delivered": true }
  ]
}
```

Status is `sent` on the preferred channel, `fallback_sent` when email rescued it, and `failed` when neither worked.

### Tenant configuration

```http
POST /notifications/settings
{ "escalation_threshold_percent": 150, "unavailable_channels": [] }
```

`escalation_threshold_percent` must exceed 100, because escalation happens after a breach. `unavailable_channels` is **pilot-only**: it simulates a transport outage so the fallback path can be demonstrated without a real provider.

### Delivery log

`GET /notifications` returns the tenant's delivery log, filterable by `recipient_id`, `work_item_id` and `event_type`. It doubles as the idempotency record — a unique constraint on `(event_id, recipient_id)` means a replayed event notifies nobody twice, so the 60-second aging tick cannot spam.

Work items past the escalation threshold carry `escalated_at`, surfaced in the UI as an **Escalated** badge and filter.

### Production boundary

The channel adapters are stubs: **nothing actually leaves the process**, and the `notifications` table is the delivery record. Spec §18.3 keeps external transports out of the pilot. Swapping in SES/SendGrid, the Slack Web API and Microsoft Graph means replacing one `transmit` method per adapter — routing, fallback, idempotency and audit are transport-independent and already tested.

---

## Phase 1 Operational Visibility (US3.4, US9.1, US9.2)

An SLA policy can mark its state as clock-suspending:

```http
POST /sla-policies
{
  "item_type": "story",
  "state": "Blocked",
  "threshold_minutes": 960,
  "calendar": "5x8",
  "suspend_sla": true
}
```

Entering that state snapshots accrued business minutes. Recompute ticks and process restarts retain the same score while held; leaving the state resumes from the retained value without restarting or charging the paused interval. The team board labels paused clocks and is browser-tested to order every column red → amber → green → ungoverned, then by descending score.

```http
GET /metrics/executive
x-org-id: 00000000-0000-0000-0000-000000000099
```

The executive response provides current SLA compliance, average cycle time and aging distribution for the overall portfolio, each business unit and each team. Compliance uses only items whose current state has a policy. Cycle time uses creation through the first recorded completion transition rather than `updated_at`, so an aging refresh cannot rewrite history. The response and UI state that evidence boundary explicitly.

---

## Flow Metrics (US9.4)

DORA and ITIL figures computed from recorded history, never hand-entered.

```http
GET /metrics/flow?from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z
x-org-id: 00000000-0000-0000-0000-000000000099
```

| Metric | Derived from |
| --- | --- |
| Deployment frequency | successful deployment artefacts from the Git/CI gateway |
| Lead time for changes | earliest commit linked to what a deployment shipped, through to deploy time |
| **Change failure rate** | `Incident caused_by Release` — the Epic 4 traceability edge |
| Time to restore service | the incident's own transition history in `audit_events` |
| ITIL counts | incidents opened/resolved, severity mix, auto-created share, SLA breaches, reopens |

Change failure rate is the figure that pays for the traceability graph. In a two-tool setup it depends on someone tagging deployments by hand; here the edge already exists, so the rate needs no separate discipline. It is returned with the deployment/incident pairs behind it:

```json
"change_failure_rate": {
  "deployments": 2, "failed_deployments": 1, "rate": 0.5,
  "failures": [
    { "deployment": "deploy-5.0.0", "release_key": "REL-5E5DFF18",
      "incident_key": "INC-D3220784", "severity": "SEV1" }
  ]
}
```

The response also reports coverage, because a metric computed over partial evidence should say so: lead time counts only deployments whose work items also carry a linked commit, and time to restore counts only incidents with a recorded resolution.

### Transactional outbox and durable event history

`GET /events` exposes the `domain_events` table, which records every event the platform publishes, filterable by type, work item and time range. It is what makes the metrics computable from history rather than from current state.

For the canonical work-item mutation paths, `WorkItemCreated`, `WorkItemStateChanged` and `LinkCreated` are inserted into `domain_events` together with a pending `event_outbox` marker in the same database transaction as the business write. Publication happens after commit. If the process stops in that gap, application bootstrap drains the pending row with its original `event_id`; consumer idempotency makes an at-least-once redelivery safe.

Inbound Git and monitoring requests now use the same durable boundary: the delivery and `InboundWebhookAccepted` outbox envelope commit before HTTP 202, then a serial worker performs the downstream mutations. **Boundary:** dispatch and processing still run in this application process. Kafka/MSK, continuous background polling and leasing across multiple workers remain later event-backbone work.

---

## Authentication (US10.9)

Every tenant boundary in this codebase was previously enforced against `x-org-id`, a header the caller supplies. The isolation logic was correct, but it rested on a premise that was false: anyone could claim any tenant. Authentication turns the tenant into something the caller has to prove.

```http
POST /auth/credentials          # bootstrap token or a platform_admin credential
Authorization: Bearer <token>
{ "name": "ci-pipeline", "roles": ["on_call"] }

→ { "id": "...", "token": "cdn_…", "roles": ["on_call"] }   # shown once, never again
```

| Endpoint | Purpose |
| --- | --- |
| `GET /auth/me` | The principal behind the current request |
| `POST /auth/credentials` | Issue a credential (admin or bootstrap only) |
| `GET /auth/credentials` | List credentials, never their secrets |
| `POST /auth/credentials/:id/revoke` | Revoke immediately |

**Tokens are stored only as a SHA-256 hash**, and lookup is *by* that hash, so verification is an indexed equality test on a digest — there is no plaintext secret in the database to leak. A credential is shown exactly once, at issue.

**A request whose `x-org-id` contradicts its credential is refused**, not silently corrected. That mismatch is either a bug worth surfacing or an attempt worth refusing, and neither deserves to succeed quietly.

### Identity modes

| Mode | When | Behaviour |
| --- | --- | --- |
| Bearer token | default, including `npm start` | A credential is required; the tenant and actor roles come from it |
| Bootstrap token | `CADENA_BOOTSTRAP_TOKEN` set | Acts as `platform_admin` for the tenant named in `x-org-id`, so the first credential can be minted |
| Dev headers | `CADENA_ALLOW_HEADER_AUTH=true` | `x-org-id` / `x-actor-role` are trusted as-is |

**Header identity is off by default and must be opted into**, the same discipline the data directory follows: the unsafe mode is never inherited by accident. `npm run dev` enables it so the pilot UI works without a login; `npm start` does not. The server states its mode at boot.

**Boundaries:**

- **The migration is deliberately shallow.** Forty-nine call sites read the tenant from `x-org-id`. Rather than rewrite them all at once, the guard resolves the principal and overwrites that header with the authenticated value, so those controllers keep working while what they read becomes something proven rather than asserted. Reading the principal directly is the eventual tidier shape.
- **Dev mode rewrites nothing**, deliberately. It must be behaviourally invisible, so enabling it cannot change how downstream controllers resolve their own fallbacks.
- **The pilot UI has no login.** It sends `x-org-id` and therefore only works in dev mode. A browser flow arrives with US10.1.
- Only the credential's first role reaches the workflow engine, which evaluates a single role; the full set stays on the principal.
- There is no token expiry or rotation policy — revocation is manual.

---

## Reliable Event Consumption (Epic 5)

Every registered consumer runs behind `EventConsumerRegistry`, which supplies three things the consumers used to lack:

| Guarantee | Story | Behaviour |
| --- | --- | --- |
| Idempotency | US5.2 | Consumption is keyed on (consumer, event_id). A redelivery is a no-op for that consumer, and other consumers are unaffected. |
| Retry | US5.3 | A throwing handler is retried to its configured limit with linear backoff. |
| Dead-lettering | US5.3 | On exhaustion the event is stored with payload, attempts and error, and a `DeadLetterQueueAlert` fires carrying the current depth. |

Consumers stay ordinary async functions. Before this, each either reinvented that logic or quietly swallowed its own failures — `NotificationService` did the latter, so a persistent fault produced a log line and a notification nobody received. It is now registered through the framework, so the contract is exercised by a production consumer rather than only by tests.

### Operator surface

```http
GET  /dlq?consumer=notifications&status=dead
GET  /dlq/depth
POST /dlq/:id/replay     { "payload": { ...corrected... } }
POST /dlq/:id/discard    { "reason": "superseded" }
```

`GET /dlq/depth` returns the total, a per-consumer breakdown, and an `alerting` flag that is true whenever depth exceeds zero. The **Dead letters** view in the workspace shows each entry with its payload in an editable box, so a malformed event can be corrected and re-injected without asking the source system to resend it.

**Replay preserves identity.** The corrected event keeps its original `event_id` and is re-dispatched only to the consumer that failed, so the audit trail stays continuous and no other consumer is re-triggered. A replay that fails again stays queued rather than vanishing.

Every dead-letter read, depth calculation and mutation takes the tenant as a required argument rather than an optional filter, so an unscoped query cannot be expressed and the compiler rejects an attempt to omit it. Each is scoped to the calling tenant, and an entry belonging to another tenant reports as **not found** rather than forbidden, so a caller cannot probe for the existence of other tenants' failures. Events whose tenant cannot be resolved are deliberately absent from tenant APIs, and are logged when they occur so the failure is invisible to the API without being silent to an operator reading the logs; a future platform-operator surface can expose them under a different authorization model.

**Boundaries:**

- Retries are in-process and immediate, so a consumer whose dependency is down for minutes will exhaust its attempts and dead-letter rather than waiting it out. Scheduled redelivery with longer backoff belongs with the durable queue that replaces the in-process bus.
- A consumer claim is taken before the handler runs. Because the embedded datastore has one writer process, startup safely returns any abandoned `processing` claims to `failed`, allowing the source or an operator to redeliver them.
- Replay requires the consumer to be registered in the running process; an entry for a consumer since removed or renamed cannot be replayed, and the API says so rather than failing quietly.

---

## Production Boundaries

The pilot is deliberately explicit about what is not production-ready:

1. **Webhook signature verification is not implemented.** In production mode the global auth guard supplies a tenant from a valid bearer credential, but the Git/CI and monitoring endpoints still trust the normalized request body. Before either is exposed to a real provider it needs:
   - per-tenant shared-secret registration for each configured integration;
   - provider signature verification computed over the **raw** request body (Datadog `DD-Signature`, GitHub `X-Hub-Signature-256`, PagerDuty/Grafana HMAC), with constant-time comparison;
   - timestamp-based replay rejection in addition to the existing delivery-id deduplication;
   - per-provider adapters translating raw provider payloads into the normalized contract above.
2. **Integration-specific identity is not authenticated.** The API bearer credential proves a tenant and principal, but it is not yet bound to one configured provider installation. `automation_actor_role` also grants a workflow role by configuration rather than by binding the external actor to a first-class RBAC principal. Guards still evaluate that role — it is not a bypass — but provider-scoped credentials and actor mapping remain hardening work.
3. **Delivery durability stops short of a broker.** Canonical work-item mutations use a transactional outbox; inbound webhooks persist before HTTP 202; and consumption is idempotent, retried and dead-lettered with operator replay. Still outstanding: continuous multi-worker leasing/dispatch and a real broker such as Kafka or AWS MSK in place of the in-process bus.
4. **Retries are in-process and immediate.** A consumer whose dependency is down for minutes exhausts its attempts and dead-letters rather than waiting it out. Scheduled redelivery with longer backoff belongs with that broker.
5. **No notification actually leaves the process.** Channel adapters are stubs; the `notifications` table is the delivery record. Routing, fallback and idempotency are real and tested, but SES/SendGrid, the Slack Web API and Microsoft Graph are not wired in.
6. **The Service registry is not a CMDB.** Auto-registered entries are lightweight stubs flagged `monitoring_discovery`. Live federation, staleness flagging, and authoritative ownership are Epic 11 (US11.1, US11.2).

---

## Next Extension Work

The specification's Phase 1 operational-visibility scope is now complete: SLA clocks can pause on hold, the team heatmap is browser-verified, and the executive rollup reports SLA compliance, cycle time and aging distribution per team and business unit. The next extension work is:

1. **Remaining Event Backbone (Epic 5)**:
   - Mutation-to-event delivery, HTTP 202 webhook acceptance and consumption are reliable: transactional, idempotent, retried, dead-lettered and replayable. Still open beyond the completed Epic 5 stories: a continuously polling multi-worker dispatcher and replacing the in-process bus with Kafka / AWS MSK.

2. **Real Notification Transports (Epic 8 hardening)**:
   - Replace the pilot channel adapters with SES/SendGrid, the Slack Web API, and Microsoft Graph. Routing, fallback, and the delivery log already work and are transport-independent.

3. **CMDB Federation (Epic 11)**:
   - Replace pilot-discovered Service stubs with a federated read from the authoritative CMDB, including staleness flagging and owning-team resolution.

4. **Remaining Analytics UI and Scale Boundary (Epic 9)**:
   - US9.2 executive rollup and US9.4 flow metrics are implemented. Still open: the interactive graph explorer (US9.3) and analytics materialized views so reporting load never contends with the workflow engine at production volume.

---

## Verified Backlog Acceptance Criteria Summary

| Story | Acceptance Criteria Description | Test File | Status |
| --- | --- | --- | --- |
| **US1.1** | Creates work items with valid types (`epic`/`story`/`incident`/`release`), stable keys, and default status | `test/us1.1.spec.ts` | **PASS** |
| **US1.1** | Rejects unrecognized type with HTTP 422 and valid types list | `test/us1.1.spec.ts` | **PASS** |
| **US1.2** | Filters work items by state and aging bucket | `test/us1.2.spec.ts` | **PASS** |
| **US1.2** | Scopes work item queries strictly to caller's `org_id` (multi-tenant isolation) | `test/us1.2.spec.ts` | **PASS** |
| **US1.2** | Denies cross-tenant item reads and relationship creation by id | `test/us1.2.spec.ts` | **PASS** |
| **US1.3** | Validates custom fields against registered JSON schema | `test/us1.3.spec.ts` | **PASS** |
| **US1.3** | Resolves missing custom fields to documented default on read | `test/us1.3.spec.ts` | **PASS** |
| **US2.1** | Publishes workflow definition & preserves in-flight item versions | `test/us2.1.spec.ts` | **PASS** |
| **US2.1** | Rejects invalid workflow definition with specific validation error | `test/us2.1.spec.ts` | **PASS** |
| **US2.2** | Rejects transition when actor lacks required role with 409 `guard_failed` | `test/us2.2.spec.ts` | **PASS** |
| **US2.2** | Rejects transition when required fields are missing | `test/us2.2.spec.ts` | **PASS** |
| **US2.3** | Skips and logs an external-event transition when a workflow guard rejects it | `test/us2.3.spec.ts` | **PASS** |
| **US3.1–3.3** | Computes calendar-aware aging and emits warning/breach events | `test/us3.*.spec.ts` | **PASS** |
| **US3.4** | Preserves accrued minutes on hold and resumes without back-filling paused time | `test/us3.4.spec.ts` | **PASS** |
| **US4.1** | Creates valid typed link & exposes in both items' relationship lists | `test/us4.1.spec.ts` | **PASS** |
| **US4.1** | Rejects invalid edge type for item pair with allowed edge types | `test/us4.1.spec.ts` | **PASS** |
| **US4.2** | Queries semantic upstream and downstream lineage chains in order | `test/us4.2.spec.ts` | **PASS** |
| **US4.3** | Returns every work item implicated by a Service within the requested depth | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Explains each result through the edge chain that implicates it | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Honours the depth bound, default, clamp, and invalid-depth rejection | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Filters the traversal to named edge types | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Scopes impact analysis and `affects` edge creation to the owning tenant | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Reflects incident resolution in the impact summary | `test/us4.3.spec.ts` | **PASS** |
| **US5.1** | Commits work-item creation, state transitions and typed links with their immutable outbox event | `test/us5.1.spec.ts` | **PASS** |
| **US5.1** | Rolls back state and audit writes on outbox failure and recovers pending envelopes with the original event id | `test/us5.1.spec.ts` | **PASS** |
| **US5.4** | Persists valid webhooks and returns HTTP 202 before downstream work-item mutation | `test/us5.4.spec.ts` | **PASS** |
| **US5.4** | Queues bursts with queryable state and deduplicates provider redelivery | `test/us5.4.spec.ts` | **PASS** |
| **US5.4** | Retries poison payloads, dead-letters them and completes corrected replay | `test/us5.4.spec.ts` | **PASS** |
| **US6.1** | Stores commits and links recognized work-item keys while retaining unlinked commits | `test/us6.1.spec.ts` | **PASS** |
| **US6.2** | Auto-transitions a linked Story when its pull request is merged | `test/us6.2.spec.ts` | **PASS** |
| **US6.3** | Links deployments to Stories/Releases, advances the Release, and deduplicates delivery replay | `test/us6.3.spec.ts` | **PASS** |
| **US7.1** | Auto-creates a `Triaged` Incident with severity mapped from the alert | `test/us7.1.spec.ts` | **PASS** |
| **US7.1** | Maps provider severity vocabularies onto SEV1–SEV4 and derives priority | `test/us7.1.spec.ts` | **PASS** |
| **US7.1** | Updates the existing Incident when the alert refires inside the dedupe window | `test/us7.1.spec.ts` | **PASS** |
| **US7.1** | Opens a new Incident when the same alert returns outside the window | `test/us7.1.spec.ts` | **PASS** |
| **US7.1** | Records but suppresses alerts below the configured severity threshold | `test/us7.1.spec.ts` | **PASS** |
| **US7.1** | Replays a duplicate delivery without repeating side effects | `test/us7.1.spec.ts` | **PASS** |
| **US7.1** | Rejects invalid payloads with actionable 422s and keeps tenants isolated | `test/us7.1.spec.ts` | **PASS** |
| **US7.2** | Creates an `affects` edge to the registered Service and takes ownership from it | `test/us7.2.spec.ts` | **PASS** |
| **US7.2** | Registers a discovered Service without placing it on the delivery board | `test/us7.2.spec.ts` | **PASS** |
| **US7.2** | Scopes the Service registry and its `affects` edges to the owning tenant | `test/us7.2.spec.ts` | **PASS** |
| **US7.3** | Moves a resolved alert's Incident to `Mitigated`, never to `Resolved`/`Closed` | `test/us7.3.spec.ts` | **PASS** |
| **US7.3** | Records the proposal as skipped when the automation role fails the guard | `test/us7.3.spec.ts` | **PASS** |
| **US7.3** | Records a resolution with no linked Incident as evidence only | `test/us7.3.spec.ts` | **PASS** |
| **US7.3** | Exposes queryable alert evidence from the Incident | `test/us7.3.spec.ts` | **PASS** |
| **US8.1** | Notifies the owner on their preferred channel when an item crosses 75% | `test/us8.1.spec.ts` | **PASS** |
| **US8.1** | Never notifies the same recipient twice for one event | `test/us8.1.spec.ts` | **PASS** |
| **US8.1** | Records nothing for an unowned item and keeps the log tenant-scoped | `test/us8.1.spec.ts` | **PASS** |
| **US8.2** | Notifies both the owner and the team lead on breach | `test/us8.2.spec.ts` | **PASS** |
| **US8.2** | Escalates to the configured manager at 150% and flags the item escalated | `test/us8.2.spec.ts` | **PASS** |
| **US8.2** | Falls back to an on-call team member when no escalation target is set | `test/us8.2.spec.ts` | **PASS** |
| **US8.2** | Validates the escalation threshold and rejects an unknown target | `test/us8.2.spec.ts` | **PASS** |
| **US8.3** | Delivers on the channel the user chose | `test/us8.3.spec.ts` | **PASS** |
| **US8.3** | Falls back to email when the preferred channel has no address | `test/us8.3.spec.ts` | **PASS** |
| **US8.3** | Falls back to email when the preferred channel is unavailable | `test/us8.3.spec.ts` | **PASS** |
| **US8.3** | Records a failure when the fallback channel is also unavailable | `test/us8.3.spec.ts` | **PASS** |
| **US8.3** | Defaults to email and rejects an unknown channel | `test/us8.3.spec.ts` | **PASS** |
| **US9.1** | Colours the team heatmap by aging bucket and orders each column worst-first | `test/ui-smoke.spec.ts` | **PASS** |
| **US9.2** | Reports SLA compliance, cycle time and aging distribution per team and business unit | `test/us9.2.spec.ts` | **PASS** |
| **US9.2** | Renders the executive overview on the built responsive UI | `test/ui-smoke.spec.ts` | **PASS** |
| **US9.4** | Derives deployment frequency and lead time from delivery artefacts | `test/us9.4.spec.ts` | **PASS** |
| **US9.4** | Computes change failure rate from the `Incident caused_by Release` edge | `test/us9.4.spec.ts` | **PASS** |
| **US9.4** | Computes time to restore from incident state history | `test/us9.4.spec.ts` | **PASS** |
| **US9.4** | Reports ITIL operational counts and honours the requested window | `test/us9.4.spec.ts` | **PASS** |
| **US9.4** | Keeps a durable, queryable domain-event history | `test/us9.4.spec.ts` | **PASS** |
| **US10.3** | Enforces RBAC role permissions on workflow state transitions | `test/us10.3.spec.ts` | **PASS** |
| **Backlog fixture** | Imports every epic and story from the backlog with its parent-child hierarchy | `test/backlog-fixture.spec.ts` | **PASS** |
