# Unified SDLC & ITSM Platform — Pilot Build

This repository contains the pilot implementation of the Unified SDLC & ITSM platform as specified in the **Technical Specification** and **Backlog**.

The pilot proves the platform's core thesis: **one canonical work-item model** and **one state-machine engine** serving delivery item types (`Epic`, `Story`, `Release`) and operational item types (`Incident`), with real, queryable traceability between them.

> **Current status (Codex update, 2026-09-20):** Phase 0, the Epic 3 aging/SLA engine, Stage B backlog dogfooding, the complete Epic 4 traceability graph including US4.3 service impact analysis, the Epic 8 notification and escalation service, and the Phase 1 integration slices (US2.3, Epic 6 Git/CI, and Epic 7 monitoring/APM) are implemented. See `implementation_plan.md` for the clearly attributed Codex delivery records.

---

## Technical Stack & Architecture

- **Runtime & Framework**: TypeScript throughout, NestJS backend API.
- **Datastore**: PostgreSQL with `pgvector` extension enabled via `@electric-sql/pglite` WASM in-process engine.
- **Workflow Engine**: Hand-rolled state-machine engine implementing Spec §4, supporting versioned definitions, role guards, required fields, and reachability validation.
- **Traceability Graph**: Typed edge table (`work_item_links`) supporting upstream and downstream recursive lineage traversal, plus depth-limited impact analysis from a Service across the `affects` edge.
- **Aging & SLA**: 60-second recalculation, 5×8 and 24×7 calendars, persisted aging score/bucket, and warning/breach events.
- **Git/CI Gateway**: Idempotent normalized webhooks, commit/PR/deployment artifacts, work-item key matching, external links, and workflow-safe automation.
- **Monitoring/APM Gateway**: Idempotent alert ingestion, SEV1–SEV4 severity mapping, auto-created `Triaged` Incidents, a configurable dedupe window, and mitigation proposed for human confirmation.
- **Service/Asset Registry**: Tenant-scoped lightweight CMDB entries (Spec §3.3) joined to Incidents by the §3.2 `affects` edge — a supporting entity, not a WorkItem.
- **Notification & Escalation**: Event-bus subscribers routing SLA warnings, breaches and escalations to each person's preferred channel with email fallback and a queryable delivery log.
- **Pilot UI**: Responsive board/list workspace, workflow-driven transitions, SLA health, item details, linking, lineage exploration, service impact, monitoring evidence on Incidents, and the notification delivery log.
- **Testing**: Vitest + NestJS Testing + Supertest running 59 automated tests across 23 test files.

---

## How to Run

### 1. Run Automated Test Suite (Single Command)

To run the complete test suite covering Epics 1, 2, 3, 4, 6, 7, 8, and 10 plus Stage B dogfooding:

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
 ✓ test/us10.3.spec.ts (1 test)
 ✓ test/stage-b-dogfooding.spec.ts (1 test)

 Test Files  23 passed (23)
      Tests  59 passed (59)
```

### 2. Run Development Server

```bash
npm run dev
```

---

## What Was Deliberately Stubbed

Per Spec §18.3, the following components were deliberately stubbed for the Phase 0 pilot:

1. **Event Bus (Spec §8)**:
   - **Stub**: Implemented as `InProcessEventBus` (`src/modules/events/event-bus.ts`).
   - **Envelope Contract**: Strictly conforms to Spec §8.2 (`event_id`, `event_type`, `schema_version`, `timestamp`, `actor`, `work_item_id`, `payload`).
   - **Extension Path**: Can be swapped for Apache Kafka or AWS EventBridge/MSK in Phase 1 without modifying domain logic or calling contracts.

2. **Authentication & Identity (US10.3)**:
   - **Stub**: Implemented via minimal RBAC role resolution in `RbacService` (`src/modules/rbac/rbac.service.ts`) checking `x-actor-id` / `x-actor-role` headers against the database `people` table.
   - **Extension Path**: SSO/SCIM hosted providers (WorkOS / Okta / SAML / OIDC) can be plugged in during enterprise hardening phases.

---

## Git/CI Webhook Contract

The integration gateway accepts a normalized provider payload. Every request requires `x-org-id` plus a stable delivery identifier in `x-delivery-id`, `x-github-delivery`, or `delivery_id`.

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

Supported event types are `push`, `pull_request`, and `deployment`. Linked evidence is available at `GET /workitems/:id/external-links`; delivery processing status is available at `GET /integrations/git/deliveries/:deliveryId`.

---

## Monitoring/APM Webhook Contract

The monitoring gateway accepts a normalized provider payload. Every request requires `x-org-id` plus a stable delivery identifier in `x-delivery-id`, `x-monitoring-delivery`, or `delivery_id`.

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
| Replayed delivery id | Returns the original recorded result with `duplicate: true` and repeats no side effects |

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

Alert evidence is available at `GET /workitems/:id/monitoring-alerts` (and through the shared `GET /workitems/:id/external-links`); delivery processing status is available at `GET /integrations/monitoring/deliveries/:deliveryId`.

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

## Production Boundaries

The pilot is deliberately explicit about what is not production-ready:

1. **Webhook signature verification is not implemented.** Both the Git/CI and monitoring endpoints trust the `x-org-id` header and the normalized request body. Before either is exposed to a real provider it needs:
   - per-tenant shared-secret registration for each configured integration;
   - provider signature verification computed over the **raw** request body (Datadog `DD-Signature`, GitHub `X-Hub-Signature-256`, PagerDuty/Grafana HMAC), with constant-time comparison;
   - timestamp-based replay rejection in addition to the existing delivery-id deduplication;
   - per-provider adapters translating raw provider payloads into the normalized contract above.
2. **Integration identity is not authenticated.** Tenant identity arrives in a header rather than from an authenticated integration credential, and `automation_actor_role` grants a workflow role by configuration rather than by binding to a real RBAC principal. Guards still evaluate that role — it is not a bypass — but the binding is US10.3 hardening work.
3. **Delivery durability stops at the datastore.** Deduplication and recorded results are durable, but transport retries, a transactional outbox, Kafka, and a dead-letter queue remain Epic 5 work.
4. **No notification actually leaves the process.** Channel adapters are stubs; the `notifications` table is the delivery record. Routing, fallback and idempotency are real and tested, but SES/SendGrid, the Slack Web API and Microsoft Graph are not wired in.
5. **The Service registry is not a CMDB.** Auto-registered entries are lightweight stubs flagged `monitoring_discovery`. Live federation, staleness flagging, and authoritative ownership are Epic 11 (US11.1, US11.2).

---

## Remaining Phase 1 Work (Spec §18.5)

The aging engine, team workspace, workflow automation, traceability graph, Git/CI integration, monitoring/APM integration, and notification routing are implemented. The remaining Phase 1 work is:

1. **Production Event Bus (Epic 5)**:
   - Replace `InProcessEventBus` with Kafka / AWS MSK using a transactional outbox pattern in Postgres to guarantee at-least-once event delivery.

2. **Real Notification Transports (Epic 8 hardening)**:
   - Replace the pilot channel adapters with SES/SendGrid, the Slack Web API, and Microsoft Graph. Routing, fallback, and the delivery log already work and are transport-independent.

3. **CMDB Federation (Epic 11)**:
   - Replace pilot-discovered Service stubs with a federated read from the authoritative CMDB, including staleness flagging and owning-team resolution.

4. **Production Analytics & Executive UI (Epic 9)**:
   - Back team and executive dashboards with analytics materialized views.
   - Promote the pilot lineage chain into a full interactive graph and add cross-team reporting.

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
| **US4.1** | Creates valid typed link & exposes in both items' relationship lists | `test/us4.1.spec.ts` | **PASS** |
| **US4.1** | Rejects invalid edge type for item pair with allowed edge types | `test/us4.1.spec.ts` | **PASS** |
| **US4.2** | Queries semantic upstream and downstream lineage chains in order | `test/us4.2.spec.ts` | **PASS** |
| **US4.3** | Returns every work item implicated by a Service within the requested depth | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Explains each result through the edge chain that implicates it | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Honours the depth bound, default, clamp, and invalid-depth rejection | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Filters the traversal to named edge types | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Scopes impact analysis and `affects` edge creation to the owning tenant | `test/us4.3.spec.ts` | **PASS** |
| **US4.3** | Reflects incident resolution in the impact summary | `test/us4.3.spec.ts` | **PASS** |
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
| **US10.3** | Enforces RBAC role permissions on workflow state transitions | `test/us10.3.spec.ts` | **PASS** |
| **Stage B** | Imports 12 true Epic items, 38 Stories, and their hierarchy | `test/stage-b-dogfooding.spec.ts` | **PASS** |
