# Unified SDLC & ITSM Platform — Pilot Build

This repository contains the pilot implementation of the Unified SDLC & ITSM platform as specified in the **Technical Specification** and **Backlog**.

The pilot proves the platform's technical foundation: **one canonical work-item twin model** and **one policy/workflow engine** serving delivery item types (`Epic`, `Story`, `Release`) and operational item types (`Incident`), with real, queryable traceability between them. In the target product, those twins are normally materialized from authoritative Jira, ServiceNow and other provider records rather than entered again by users.

> **Current status (Codex and Claude updates, 2026-09-23):** Phase 0, the complete Epic 3 aging/SLA engine including durable hold-state suspension, the complete Epic 4 traceability graph, the Epic 5 transactional outbox, reliable-consumption paths and HTTP 202 webhook ingestion, the Epic 8 notification and escalation service, the Phase 1 operational views, US10.4/US10.7 audit evidence, US13.2 correlation, US13.3 echo suppression, the provider-neutral US13.1 state-translation engine, US16.4/US16.5 durable per-twin queues and failure isolation, and the normalized Git/CI and monitoring integrations are implemented. The cloud staging foundation is implemented in the repository but not activated in a cloud account. The US17.1 Jira/ServiceNow connector slice (native discovery, watermarked durable ingestion into canonical twins, and outbox-driven execution of US13.1 work orders) is implemented and verified against deterministic provider API fakes; it has not yet been run against a live tenant, so US17.1 and US13.1 remain partial. US17.2 governed visual field mappings with a sandboxed scripting escape hatch are done. US17.3 scheduled native-query triggers (JQL and ServiceNow encoded queries run on a per-query watermark, with unbounded scans blocked at publish) are implemented and verified against the provider fakes; WIQL is validate-only because no Azure DevOps adapter exists, and nothing has run against a live tenant, so US17.3 is partial. The US20.2 connector-led management workspace is implemented: connector-led mode is the staging/production default, local creation is refused there, and externally owned fields are read-only except for governed, audited state write-back. A 2026-09-23 increment closed three items the projection work had left open (directory-based owner matching by assignee email, a frozen/stale indicator for a paused projection, and the audit-chain single-writer constraint, which let `deploy/staging` move to 2 replicas) and upgraded the dev/test toolchain (vitest 2→5, vite 5→6), bringing `npm audit` to 0 vulnerabilities across the whole dependency tree; none of this changed any story's status. The canonical backlog contains **20 epics and 73 stories**, with **39 done / 7 partial / 27 not started**. See `implementation_plan.md` for clearly attributed Codex and Claude delivery records and `status.html` for the generated ledger and platform milestone.

## Product Interaction Model

Cadena's production role is a synchronization control plane over the systems where teams already work:

```text
Jira record ←→ Cadena correlation, mapping, policy and audit ←→ ServiceNow record
```

- Jira, ServiceNow and other providers remain authoritative by default for the fields assigned to them.
- Cadena owns the immutable correlation, mapping versions, synchronization decisions, derived policy state, audit evidence and cross-system traceability.
- Connector ingestion creates or updates the internal canonical twin; users are not expected to maintain a duplicate backlog.
- A permitted edit to an externally owned field is written back through the audited connector. An edit with no permitted outbound mapping is rejected rather than stored as silent divergence.
- Local creation remains available only where it is intentionally enabled: the local `pilot` demonstration and `standalone` deployments. In `connector-led` mode (the staging/production default) it is refused, and connect, discover and synchronize are the primary actions. Automated incident generation from monitoring is unaffected. See [Connector-led Workspace (US20.2)](#connector-led-workspace-us202).

---

## Technical Stack & Architecture

- **Runtime & Framework**: TypeScript throughout, NestJS backend API.
- **Datastore**: One query/transaction contract over embedded `@electric-sql/pglite` for local/test use and pooled native PostgreSQL via `DATABASE_URL` for staging. Non-local mode requires certificate-verified TLS.
- **Staging Runtime**: Non-root multi-stage container, fail-closed environment validation, public liveness/readiness probes, graceful shutdown, JSON request telemetry, Kubernetes TLS/secret manifests and immutable-image CI/deploy workflows.
- **Workflow Engine**: Hand-rolled state-machine engine implementing Spec §4, supporting versioned definitions, role guards, required fields, and reachability validation.
- **Traceability Graph**: Typed edge table (`work_item_links`) supporting semantic upstream/downstream traversal, an interactive depth-bounded explorer, Service impact analysis, and immutable point-in-time JSON lineage reports.
- **Aging & SLA**: 60-second recalculation, 5×8 and 24×7 calendars, persisted aging score/bucket, warning/breach events, and durable pause/resume semantics for configured hold states.
- **Git/CI Gateway**: Idempotent normalized webhooks, commit/PR/deployment artifacts, work-item key matching, external links, and workflow-safe automation.
- **Monitoring/APM Gateway**: Idempotent alert ingestion, SEV1–SEV4 severity mapping, auto-created `Triaged` Incidents, a configurable dedupe window, and mitigation proposed for human confirmation.
- **Cross-system Synchronization Safety**: Tenant-scoped immutable provider identities, typed one-to-many/many-to-one dependency links, exact-id graph resolution, versioned bidirectional state matrices with guarded target fields/transitions, transactional-outbox propagation, per-twin durable FIFO intake/write queues, twin-scoped DLQ correction/re-injection, expiring database sync leases, metadata-only rename/move updates, a dedicated counterpart write-back contract, and actor-plus-hash echo suppression with durable content fallback after restart.
- **Service/Asset Registry**: Tenant-scoped lightweight CMDB entries (Spec §3.3) joined to Incidents by the §3.2 `affects` edge — a supporting entity, not a WorkItem.
- **Transactional Event Backbone**: Canonical work-item creation, transitions and typed links commit their immutable event and outbox marker atomically; inbound webhooks persist before returning HTTP 202 and process from a queryable queue; pending envelopes recover on bootstrap with the same event id, and every consumer runs behind idempotency, retry and a dead-letter queue with operator replay.
- **Event History & Metrics**: Every domain event is persisted to `domain_events`, with DORA/ITIL flow metrics and tenant-scoped executive rollups computed from recorded artefacts rather than hand entry.
- **Compliance Audit**: Creation, field edits, typed links, state transitions and integration-driven changes append to a tenant-wide SHA-256 chain and project into an audit trail with actor, timestamp, normalized before/after values and verification metadata; JSON export is available at the specification's `GET /audit/export` route.
- **Notification & Escalation**: Event-bus subscribers routing SLA warnings, breaches and escalations to each person's preferred channel with email fallback and a queryable delivery log.
- **Pilot UI**: Responsive board/list workspace, explicitly verified worst-first SLA heatmap, workflow-driven transitions, hold-state policy configuration, state-mapping administration, source-connector onboarding and health, a connector-led landing view and synchronized-twin workspace with governed write-back, executive overview, item details with audit history/export, linking, lineage exploration and export, service impact, monitoring evidence, and notification delivery logs. Local creation appears only in pilot (under Pilot actions) and standalone modes.
- **Testing**: Vitest + NestJS Testing + Supertest running 179 automated tests across 46 test files, plus a 21-test headless-Chrome smoke suite (`puppeteer-core`) driving the built server.

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
 ✓ test/us4.4.spec.ts (1 test)
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
 ✓ test/us9.3.spec.ts (5 tests)
 ✓ test/us9.4.spec.ts (7 tests)
 ✓ test/tracker.spec.ts (7 tests)
 ✓ test/persistence.spec.ts (5 tests)
 ✓ test/us5.1.spec.ts (4 tests)
 ✓ test/us5.4.spec.ts (4 tests)
 ✓ test/us5.spec.ts (10 tests)
 ✓ test/review-regressions.spec.ts (7 tests)
 ✓ test/us10.3.spec.ts (1 test)
 ✓ test/us10.4.spec.ts (2 tests)
 ✓ test/us10.7.spec.ts (2 tests)
 ✓ test/us13.2.spec.ts (2 tests)
 ✓ test/us13.3.spec.ts (2 tests)
 ✓ test/us10.9.spec.ts (13 tests)
 ✓ test/backlog-fixture.spec.ts (1 test)
 ✓ test/us13.1.spec.ts (3 tests)
 ✓ test/cloud-staging.spec.ts (6 tests)
 ✓ test/us17.1.spec.ts (11 tests)
 ✓ test/us20.2.spec.ts (7 tests)
 ✓ test/us16.4-16.5.spec.ts (4 tests)

 Test Files  44 passed (44)
      Tests  166 passed (166)
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

**Local boundary:** `CADENA_DATA_DIR` remains a single-process embedded datastore. It is durable across restarts but has no replication or point-in-time recovery. Staging instead uses the native PostgreSQL adapter described below.

### 3. Validate and Activate Staging

Copy `.env.staging.example` into your secret-management workflow, supply an external PostgreSQL URL and CA certificate, then validate the non-secret environment contract:

```bash
npm run staging:validate
```

`CADENA_RUNTIME_MODE=staging` fails startup unless `DATABASE_URL` is present, `CADENA_DATABASE_SSL=verify-full`, header-based identity is disabled and `CADENA_BOOTSTRAP_TOKEN` contains at least 32 characters. Demo seeding defaults off.

The container and Kubernetes resources live in `Dockerfile` and `deploy/staging/`. The deployment exposes:

```http
GET /health/live   # process is alive; no database dependency
GET /health/ready  # schema initialized and database answered
```

The complete provider prerequisites, secret fields, rollout and restore checklist are in `deploy/staging/README.md`. The GitHub **Publish and deploy staging** workflow is manual and targets a protected `staging` environment.

**Activation boundary:** no cloud account has been selected or modified. Provisioning managed PostgreSQL, Kubernetes, DNS/TLS, secret binding and backups is still required, followed by an actual restore and immutable-image rollback drill.

### 4. Run Browser Smoke Tests

Drives the real page in headless Chrome against the built server. Uses a browser already installed on the machine, so there is no Chromium download; the suite skips if none is found.

```bash
npm run test:ui
```

It covers board rendering, the Incident monitoring-evidence drawer, item audit history/export, the interactive traceability graph and report export, Service impact edge chains, the notification delivery log including Slack-to-email fallback, workflow-permitted transitions, the escalated filter, console errors, and phone-width layout.


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

## Lifecycle State Translation (US13.1)

The provider-neutral translation engine versions mappings independently for each tenant and source/target entity pair. Operators can create drafts in the **State mappings** dialog or through the API, then explicitly publish the version that synchronization should use.

```http
POST /integrations/state-mappings
x-org-id: 00000000-0000-0000-0000-000000000099
x-actor-id: mapping-admin
Content-Type: application/json

{
  "name": "Incident delivery lifecycle",
  "source": { "system": "servicenow", "entity_type": "incident" },
  "target": { "system": "jira", "entity_type": "issue" },
  "rules": [
    {
      "direction": "source_to_target",
      "from_state": "Resolved",
      "to_state": "Done",
      "required_target_fields": ["resolution.code", "resolution.notes"],
      "allowed_target_from_states": ["In Progress"]
    }
  ]
}
```

Publish the draft with `POST /integrations/state-mappings/:id/publish`. Publishing a newer version for the same pair supersedes the old published version without rewriting its history.

Evaluate a correlated change from either direction:

```http
POST /integrations/state-mappings/translate
x-org-id: 00000000-0000-0000-0000-000000000099
Content-Type: application/json

{
  "source_identity": {
    "system": "servicenow",
    "entity_type": "incident",
    "immutable_id": "8b31-sys-id"
  },
  "target_identity": {
    "system": "jira",
    "entity_type": "issue",
    "immutable_id": "1004821"
  },
  "source_state": "Resolved",
  "current_target_state": "In Progress",
  "target_fields": {
    "resolution": { "code": "Solved", "notes": "Verified in production" }
  },
  "dry_run": false
}
```

Dry-run is the default and writes no transaction. With `dry_run: false`, a safe decision is recorded as `ready` / `enqueue_connector_write`; missing fields, an invalid jump, an unmapped state or no published matrix is recorded as `held` / `hold_for_review`. `GET /integrations/state-mappings/transactions` exposes those decisions for connector and operator use. Both identities must already be joined by an immutable US13.2 counterpart link.

**Boundary:** a ready decision from this API is a durable decision record. When the change arrives through a US17.1 connector, Cadena itself makes the translation and executes the ready decision as a connector work order (see below). US13.1 stays partial until that path is validated against live Jira and ServiceNow tenants and target-specific required fields are prompted for in the UI.

---

## Native Connectors (US17.1)

Jira and ServiceNow remain the systems of record. A connector discovers a source's schema, ingests its records as **canonical twins**, and writes translated state changes back to the counterpart system.

**Current scope:** Jira Cloud (REST v3) and ServiceNow (Table API). Both are verified against deterministic API fakes in `test/us17.1.spec.ts`. No live tenant has been contacted yet.

### Safety defaults

- **No network by default.** The live transport refuses every request unless `CADENA_CONNECTOR_LIVE_HTTP=enabled`, and it requires `https://`. Enable it only after access to the tenant is authorised.
- **Reference-only credentials.** `credentials` values must be `env:NAME` or `secret-ref://path`, and plaintext is refused with HTTP 400. `secret-ref://jira/prod-token` resolves from `SECRET_JIRA_PROD_TOKEN`, which is how the staging external-secret contract projects secret-manager entries. An unresolvable reference fails the operation; there is no fallback value.
- **Time zones.** JQL and ServiceNow encoded queries interpret literal datetimes in the integration account's profile time zone. Set `options.queryTimeZone` to match (default `UTC`).

### Lifecycle

```http
POST /integrations/connectors
x-org-id: 00000000-0000-0000-0000-000000000099
Content-Type: application/json

{
  "name": "Production Jira",
  "provider": "jira",
  "baseUrl": "https://acme.atlassian.net",
  "authType": "basic",
  "credentials": { "apiToken": "env:JIRA_API_TOKEN" },
  "options": { "accountEmail": "sync@acme.com", "queryTimeZone": "UTC", "customFieldIds": ["customfield_10014"] },
  "projectKeys": ["CAD"],
  "requiredFields": { "issue": ["customfield_10014"] }
}
```

ServiceNow uses `tableNames` (for example `["incident", "change_request"]`), `options.username` and `credentials.password`. Either provider accepts `authType: "bearer"` with `credentials.accessToken`.

| Step | Endpoint | Result |
| --- | --- | --- |
| Providers | `GET /integrations/connectors/providers` | Registered adapters and their capabilities |
| Test | `POST /integrations/connectors/:id/test` | `connected`, or `error` with the reason |
| Discover | `POST /integrations/connectors/:id/discover` | Scopes, fields, custom fields, state values and a capability report |
| Activate | `POST /integrations/connectors/:id/activate` | `active`; HTTP 422 with `limitations` while any blocking limitation exists |
| Sync | `POST /integrations/connectors/:id/sync` | Poll result: fetched, created, updated, unchanged, echoes suppressed, work orders, record errors, lag |
| Pause | `POST /integrations/connectors/:id/pause` | `paused`; activate again to resume |
| Health | `GET /integrations/connectors/:id/health` | Last success, seconds since success, lag, consecutive failures, twin count, cursors, work-order counts |
| Twins | `GET /integrations/connectors/:id/twins`, `GET /integrations/connectors/twins` | Canonical twins with native key/URL, state, field authority and correlation node |
| Work orders | `GET /integrations/connectors/:id/work-orders` | Outbound state writes and their status |
| Twin DLQ | `GET /integrations/connectors/:id/twin-dlq`, `GET /integrations/connectors/:id/twin-dlq/:entryId` | Failed twin partition with payload, error and complete attempt history |
| Re-inject | `POST /integrations/connectors/:id/twin-dlq/:entryId/reinject` | Correct an optional `payload` and resume it at its original FIFO position |

These block activation: a missing project or table, a missing required field, or no incremental-query capability. Unknown state values are a warning.

### Ingestion and state propagation

Each entity type has its own watermark. A fetched page and its per-record durable intake entries commit in the same transaction, so the cursor advances only after every record is recoverably accepted. Processing then happens from a FIFO partition keyed by immutable provider/entity/id: a malformed record can retry or pause without pinning the source watermark or blocking unrelated twins. Unchanged records are detected by content hash and are not rewritten.

When a twin's native state changes, the twin mutation and its event commit together. Outbox recovery then does the following:

1. Screens the change through US13.3 echo suppression.
2. Finds counterpart twins through US13.2 `counterpart` links.
3. Translates the change through the published US13.1 mapping.
4. Executes a ready decision as a work order on the counterpart's connector. This is a Jira transition or a ServiceNow state-code update, carrying only the rule's required fields.

Work orders have a durable global queue position but execute FIFO within the target twin. Unrelated twin heads can execute concurrently. Held decisions pause only their target twin. Retryable failures (429, 5xx, timeouts) back off from 30 seconds to one hour over five attempts. Permanent refusals, or exhausted ingestion/transformation failures, enter the twin DLQ. Re-injection preserves the original position, keeps the attempt history, and unblocks later changes only after the corrected head succeeds.

### Current limits

- Sync is triggered by an operator or the API. There is no scheduler or webhook trigger yet.
- Overlapping syncs of one connector are prevented by an expiring, heartbeated database lease. The staging manifest now runs 2 replicas with a rolling update: a 2026-09-23 constraint on `audit_integrity_entries` (`UNIQUE (org_id, previous_hash)`, one genesis per tenant) removed the audit-chain's remaining single-writer assumption, with retry-on-conflict in `appendAuditIntegrityEntry` when two replicas race to extend the same tenant's chain.
- Two same-provider connectors in one tenant cannot own the same external record.
- Azure DevOps, Zendesk, Salesforce, GitHub and Asana are not implemented.

---

## Connector-led Workspace (US20.2)

The workspace follows `CADENA_INTERACTION_MODE`:

| Mode | Default for | Landing view | Local work-item creation |
| --- | --- | --- | --- |
| `connector-led` | staging, production | Source health and synchronized twins | Refused by the API (HTTP 403) and hidden |
| `pilot` | local | Source health above the demo board | Under **Pilot actions** only; refused outside local runtime |
| `standalone` | opt-in | Source health and the local board | Primary action |

`GET /workspace/config` reports the active mode. The landing view reads from these endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /workspace/overview` | Per-source health plus totals: sources, healthy, needing attention, twins, worst lag, queued and failed write-backs |
| `GET /workspace/twins` | Twins with source, native key/URL, native state, sync state, last successful sync, field authority, counterparts and write-back counts |
| `GET /workspace/twins/:id` | The same, plus a policy for each field and the write-back history |
| `POST /workspace/twins/:id/edits` | A governed edit, for example `{ "field": "state", "value": "Done" }` |

### Editing externally owned fields

Every externally owned field is read-only unless a permitted outbound mapping exists:

- **No outbound mapping** (every field except state; field write-back needs US17.2): HTTP 422, `reason: "no_outbound_mapping"`, with an ownership explanation.
- **State**, when any of these holds: write-back is disabled for the connector (the default), the connector is not active, or no state values were discovered. The response is HTTP 422 with `write_back_disabled`, `connector_unavailable` or `state_values_unknown`.
- **Permitted state change:** the value must be a discovered state. It becomes an audited `operator_edit` connector work order, which the owning connector executes. The change is then translated to linked counterparts through the published US13.1 mapping, and its echo is suppressed on the next poll.

Blocked and routed edits both write audit events (`TwinEditBlocked`, `TwinEditRouted`). The twin itself is never changed locally; it reflects the source after the next synchronization, so no local edit can create silent divergence.

Enable state write-back at registration with `"writeBack": { "state": true }`, or later with `POST /integrations/connectors/:id/write-back`.

### Local demonstration sandbox

`CADENA_CONNECTOR_SANDBOX=enabled` routes the real Jira and ServiceNow adapters to in-process provider stand-ins at `https://jira.sandbox.cadena.local` (project `CAD`) and `https://servicenow.sandbox.cadena.local` (table `incident`). Any secret reference that resolves is accepted there. Runtime configuration refuses the sandbox outside the local runtime.

### Scheduled native queries (US17.3)

A scheduled query runs a JQL (Jira) or encoded (ServiceNow) query on an interval and enqueues the records that changed since the query's own saved watermark, through the same durable, de-duplicating ingestion queue that ordinary polling uses. The connector's own polling cursor is never touched.

| Action | Endpoint | Notes |
| --- | --- | --- |
| Create draft | `POST /integrations/native-queries` | `{ name, connector_id, entity_type, query, interval_seconds?, start_from? }`. The language comes from the connector (Jira → JQL, ServiceNow → encoded). The draft records its validation result. |
| Check | `POST /integrations/native-queries/validate` | Stateless: `{ language: "jql" \| "encoded" \| "wiql", query }` returns `errors` and `warnings`, each with a `hint`. |
| Edit | `PATCH /integrations/native-queries/:id` | Drafts and disabled queries only; disable a published query first. |
| Publish | `POST /integrations/native-queries/:id/publish` | Re-validates. HTTP 422 with the actionable error while the query could scan without bound. Fixes the starting watermark. |
| Run now | `POST /integrations/native-queries/:id/run` | Runs a published query immediately: `succeeded`, `failed` or `skipped`, with fetched/enqueued counts. |
| Disable | `POST /integrations/native-queries/:id/disable` | A run in flight is abandoned, records included. |

- **Bounded by construction.** Cadena appends its own watermark predicate and ordering, so a query may not contain its own `ORDER BY`/`ORDERBY` or filter on `updated`/`sys_updated_on`. The Jira adapter also ANDs the connector's own project scope, so a query can narrow that scope but never widen it; the ServiceNow adapter applies the watermark to every `^NQ` part. The first run starts at `start_from` (default: publication time, at most 366 days back), so a trigger cannot replay older history.
- **Unbounded-scan check.** Publishing is refused when any `OR` branch (JQL, WIQL) or `^NQ` part (encoded) lacks a selective scope: for JQL a positive `project`, key, filter, parent, sprint, component, version, label, assignee or reporter condition; for encoded queries an equality, `IN`, `STARTSWITH`, `BETWEEN` or `SAMEAS` condition (a boolean flag such as `active=true` does not count). Negations, ranges, `LIKE`/`CONTAINS` and text search never count. This is a static heuristic: it cannot see which fields your instance has indexed.
- **WIQL** is validated (syntax, a `WHERE` with a `[System.TeamProject]`/`[System.AreaPath]`-style scope, no `ORDER BY`) but cannot be scheduled, because no Azure DevOps adapter ships with Cadena. Its check always carries a `no_runner` warning.
- **Scheduling.** An in-process timer (in the style of the SLA aging engine) runs due queries every 30 seconds. Each run takes a database lease first, so extra instances or a manual run can never run the same query at once. A run that leaves more pages behind is due again immediately; a provider failure keeps the watermark, records the error and backs off exponentially up to six hours. Every run re-validates the stored query. `CADENA_NATIVE_QUERY_SCHEDULER=disabled` turns the timer off and `CADENA_NATIVE_QUERY_TICK_MS` (minimum 1000) changes its period. Live provider traffic remains gated by `CADENA_CONNECTOR_LIVE_HTTP`.
- **Audit.** `NativeQueryDraftCreated`, `NativeQueryPublished`, `NativeQueryDisabled`, `NativeQueryRunCompleted` (runs that enqueued something, and every manual run) and `NativeQueryRunFailed` are recorded. The studio's **Scheduled queries** dialog covers check, save, publish, run and disable.

Verified against the deterministic provider fakes only; see `implementation_plan.md` for what remains before this story can be called done.

### Twin-backed WorkItems

Every synchronized twin is projected to one work item with `origin: "connector"`, its native key as `key`, and a `source` block (system, twin, connector, native URL, source timestamp). The SLA, escalation, traceability, notification and metrics engines therefore govern connector records directly:

- Native state changes become `WorkItemStateChanged` history at the source's timestamp, and SLA clocks follow them.
- Records keep their source creation time, which restore-time metrics use.
- US13.2 counterparts become `relates_to` traceability links.
- Git/CI references resolve native keys such as `CAD-42`.

Source authority is enforced in the services, not only the UI:

- `PATCH /workitems/:id` on a projected item returns **HTTP 409 `externally_owned`** for any source-owned field. Only Cadena `tags` may change.
- `POST /workitems/:id/transitions` is routed through the governed twin edit: it is either executed at the source or refused with the ownership reason.
- The workflow engine refuses to transition projected items. Monitoring and Git/CI automation skip them.

Configure projection per connector — this merges onto the connector's existing projection config, so `{ "enabled": false }` alone pauses it without dropping a previously set `teamId`/`typeMap`/`ownerMap`:

```http
POST /integrations/connectors/:id/projection
{ "teamId": "<team id>", "typeMap": { "issue:Bug": "incident" }, "ownerMap": { "<native assignee>": "<person id>" } }
```

Defaults: Jira Epic → epic and other issues → story; ServiceNow incident/problem → incident and change_request → release. Native priority maps to P0–P4. Without a configured or unambiguous team, projection is held, and the twin shows the reason.

**Owner matching.** An explicit `ownerMap` entry (keyed by account id, display name or email) always wins. Without one, the assignee's email — Jira's `assignee.emailAddress` where Atlassian's privacy settings expose it, or ServiceNow's dot-walked `assigned_to.email` — is matched case-insensitively against `people.email` in the tenant, so most connectors need no map at all. An assignee that matches no one is left unowned rather than guessed.

**A paused projection says so.** Disabling projection (`enabled: false`) intentionally leaves existing projected items in place — their history must not disappear — but they stop receiving updates. Every read of a projected item reports this as `source.frozen`, and `GET /workitems/:id/available-transitions` reports it as `stale` with a note in its message. State write-back is unaffected either way, since it always targets the twin directly rather than the (possibly stale) projected item.

---

## Immutable Correlation References (US13.2)

Cross-system pairs resolve only by provider-owned immutable identifiers. `display_key` and `url` are retained for people and may change after a rename, re-index or project move without creating a new node.

```http
POST /integrations/correlations
x-org-id: 00000000-0000-0000-0000-000000000099
x-actor-id: integration:jira-sync
Content-Type: application/json

{
  "source": {
    "system": "servicenow",
    "entity_type": "incident",
    "immutable_id": "8b31-sys-id",
    "display_key": "INC0010042"
  },
  "target": {
    "system": "jira",
    "entity_type": "issue",
    "immutable_id": "1004821",
    "display_key": "ENG-4821"
  },
  "relationship": "counterpart"
}
```

The response includes the stable node/link ids and two write-back instructions: each side receives `field: "cadena_counterpart_id"` with the other side's immutable id. Replaying the same counterpart in either direction returns the existing link. Replaying it with a new display key or URL updates only that metadata.

Resolve a pair or dependency tree from either immutable side:

```http
GET /integrations/correlations/resolve?system=jira&entity_type=issue&immutable_id=1004821&depth=3
x-org-id: 00000000-0000-0000-0000-000000000099
```

The 1–10 hop response includes every reachable node, typed link, distance and a summary. `PATCH /integrations/correlations/nodes/:id` accepts only `display_key` and `url`; immutable identity changes return HTTP 422. Tenant-qualified foreign keys and restrictive deletion prevent cross-tenant and orphan links.

**Boundary:** this is the provider-neutral persistence and connector write-back contract. US17.1 connectors create and update these nodes during ingestion; pairing two records as counterparts is still an explicit call to this API.

### Echo-loop suppression (US13.3)

Before a connector writes normalized fields to a correlated target, it records the intended content and the provider service account:

```http
POST /integrations/sync-guard/writes
x-org-id: 00000000-0000-0000-0000-000000000099
Content-Type: application/json

{
  "identity": {
    "system": "jira",
    "entity_type": "issue",
    "immutable_id": "1004821"
  },
  "service_account_id": "svc-cadena-jira",
  "payload": {
    "status": "In Progress",
    "priority": "High"
  }
}
```

The subsequent normalized webhook is checked before synchronization:

```http
POST /integrations/sync-guard/evaluate
x-org-id: 00000000-0000-0000-0000-000000000099
Content-Type: application/json

{
  "identity": {
    "system": "jira",
    "entity_type": "issue",
    "immutable_id": "1004821"
  },
  "actor_id": "svc-cadena-jira",
  "payload": {
    "priority": "High",
    "status": "In Progress"
  }
}
```

Object-key order does not affect the canonical SHA-256 hash. An exact service-account and hash match returns `self_originated_hash` with `action: "ignore"`. If the process-local marker has expired or disappeared after restart, the durable snapshot performs a full canonical-content comparison and returns `content_noop`. Changed content always returns `external_change` with `action: "process"`, even when the actor is the integration service account.

Payloads must contain the normalized mapped fields, not volatile webhook envelope fields such as delivery ids or receipt timestamps. Provider signature verification and binding `actor_id` to a configured installation remain connector hardening; this API does not treat an unverified caller-supplied name as authentication.

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

## Lineage Report Export (US4.4)

Create a tenant-scoped, point-in-time JSON snapshot of the entire connected work-item graph:

```http
POST /workitems/:id/lineage-exports
x-org-id: 00000000-0000-0000-0000-000000000099
x-actor-id: compliance-reviewer
```

The `cadena.lineage-report.v1` response contains the generation actor/time, root item, node/edge counts, every connected node with creation/update timestamps, and every typed edge with its creation timestamp. Its `download_url` retrieves the same stored document with an attachment filename:

```http
GET /workitems/:id/lineage-exports/:exportId
```

Downloads never recalculate the graph. Links and states added later therefore do not rewrite evidence already captured. Cross-tenant retrieval returns 404. The same action is available as **Trace lineage → Export full report** in the pilot UI.

---

## Verifiable Work-item Audit Trail (US10.4, US10.7)

Read the live, tenant-scoped history or download the same `cadena.audit-trail.v1` document:

```http
GET /audit/workitems/:id
GET /audit/export?work_item_id=:id
x-org-id: 00000000-0000-0000-0000-000000000099
x-actor-id: compliance-reviewer
```

The export combines canonical domain events with workflow audit rows without duplicating state transitions. Work-item creation, editable field changes, incoming or outgoing typed links, transitions and integration transactions carry actor, timestamp, and normalized `before`/`after` values. Cross-tenant requests return 404, and the download is marked `private, no-store`.

Fields are edited through `PATCH /workitems/:id`; lifecycle status is deliberately rejected there and remains guarded by `POST /workitems/:id/transitions`. In the UI, **Audit history** appears directly in item details with expandable before/after evidence and **Export JSON**.

Every new domain or workflow audit event is canonicalized with stable key ordering and appended transactionally to its tenant's SHA-256 chain. Existing durable stores are backfilled in timestamp/id order on upgrade. Each exported event includes its sequence, previous hash, hash, algorithm, proof version and verification result; the document also reports the tenant chain head, length, chain continuity and overall verification result. The item-details UI displays the verification state and includes the same proof beside expandable before/after evidence.

Changing or deleting a source event after it was recorded makes the overall export fail verification. The persisted chain itself is checked for missing source rows, broken previous-hash links and altered canonical snapshots. The chain is tenant-scoped, so no proof value crosses an organization boundary.

**Security boundary:** this is a SHA-256 hash chain, not a signature anchored outside the database. It makes accidental or partial unauthorized changes detectable. Defending against an administrator rewriting the entire chain and its head requires an externally signed/notarized checkpoint or WORM storage.

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

The next delivery sequence follows the connector-led product decision:

1. **Activate cloud staging**:
   - Select AWS/Azure/GCP and region, provision the managed services, bind secrets, then prove HTTPS, database restore and immutable-image rollback using `deploy/staging/README.md`.

2. **US17.1 and US17.3 live validation and completion**:
   - With credentials and explicit authorisation, enable `CADENA_CONNECTOR_LIVE_HTTP` against a Jira Cloud and ServiceNow sandbox and run both ordinary polling and a scheduled native query there. Then add webhook-triggered ingestion, the remaining provider adapters and an Azure DevOps adapter, which is what lets WIQL queries be scheduled and US17.3 be completed.

3. **US17.4 — governed bulk backfill**:
   - Resumable chunked historical backfill with adaptive rate limits, progress counts and a CSV audit report. A scheduled query deliberately cannot reach further back than 366 days.

4. **US13.4 and US13.5 — safe content and closure sync**:
   - Keep private work notes out of public streams and write complete resolution metadata back to the ITSM record.

Multi-worker dispatch, a managed broker, real notification transports, CMDB federation and analytics materialized views remain production-hardening tracks, but they no longer obscure the immediate product path.

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
| **US4.4** | Exports the complete connected lineage graph with node/edge timestamps | `test/us4.4.spec.ts` | **PASS** |
| **US4.4** | Preserves the original snapshot after live graph changes and rejects cross-tenant retrieval | `test/us4.4.spec.ts` | **PASS** |
| **US9.3** | Renders semantic upstream and downstream lineage together and expands to configured depth | `test/us9.3.spec.ts`, `test/ui-smoke.spec.ts` | **PASS** |
| **US9.3** | Supports typed edges, node inspection, graph re-rooting and report export | `test/ui-smoke.spec.ts` | **PASS** |
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
| **US10.4** | Exports creation, field changes, links and transitions with actor, timestamp and before/after values | `test/us10.4.spec.ts` | **PASS** |
| **US10.4** | Keeps audit history tenant-scoped and exposes it from item details as a JSON download | `test/us10.4.spec.ts`, `test/ui-smoke.spec.ts` | **PASS** |
| **US10.7** | Appends field changes, transitions and integration transactions to a tenant-wide SHA-256 chain | `test/us10.7.spec.ts` | **PASS** |
| **US10.7** | Detects source tampering, backfills existing event stores and exposes verification metadata in export/UI | `test/us10.7.spec.ts`, `test/ui-smoke.spec.ts` | **PASS** |
| **US13.1** | Versions and publishes bidirectional mappings and previews translated states without writing | `test/us13.1.spec.ts`, `test/ui-smoke.spec.ts` | **PASS (provider-neutral)** |
| **US13.1** | Holds missing fields, invalid target jumps and unmapped states while persisting valid ready work orders | `test/us13.1.spec.ts` | **PASS** |
| **US13.1** | Executes ready translations as native Jira transitions and ServiceNow state updates through connectors | `test/us17.1.spec.ts` | **PASS (API fakes; live tenant pending)** |
| **US13.2** | Persists dedicated immutable references on both sides and survives key/URL changes without re-pairing | `test/us13.2.spec.ts` | **PASS** |
| **US13.2** | Resolves one-to-many and many-to-one dependency trees without cross-tenant or orphan links | `test/us13.2.spec.ts` | **PASS** |
| **US13.3** | Suppresses an exact returning write by service-account identity plus canonical SHA-256 payload hash | `test/us13.3.spec.ts` | **PASS** |
| **US13.3** | Detects the unchanged no-op from durable content after volatile suppression state is lost | `test/us13.3.spec.ts` | **PASS** |
| **US16.4** | Executes changes in durable FIFO order per twin while unrelated twins proceed and expired connector leases recover | `test/us16.4-16.5.spec.ts` | **PASS** |
| **US16.4** | Recovers a committed twin change through the transactional outbox without loss or duplicate work-order execution | `test/us16.4-16.5.spec.ts` | **PASS** |
| **US16.5** | Pauses only the failed twin and keeps unrelated writes and ingested records moving | `test/us16.4-16.5.spec.ts` | **PASS** |
| **US16.5** | Exposes payload, error and attempt history and re-injects a corrected payload at its original FIFO position | `test/us16.4-16.5.spec.ts` | **PASS** |
| **US17.1** | Discovers Jira and ServiceNow scopes, fields, custom fields and states through their native APIs | `test/us17.1.spec.ts` | **PASS (API fakes)** |
| **US17.1** | Materializes and updates canonical twins without duplicates under a paginated watermark | `test/us17.1.spec.ts` | **PASS (API fakes)** |
| **US17.1** | Reports missing scopes and required fields before activation | `test/us17.1.spec.ts` | **PASS** |
| **US17.1** | Accepts only secret references and makes no network call without explicit live-HTTP authorisation | `test/us17.1.spec.ts`, `test/ui-smoke.spec.ts` | **PASS** |
| **US20.2** | Connector-led mode opens on source health with connect/discover/synchronize and refuses local creation and import | `test/us20.2.spec.ts`, `test/ui-smoke.spec.ts` | **PASS** |
| **US20.2** | Shows source, native link, sync state, last successful sync, field authority and counterpart for each twin | `test/us20.2.spec.ts`, `test/ui-smoke.spec.ts` | **PASS** |
| **US20.2** | Blocks edits without an outbound mapping and routes permitted state changes through an audited connector work order | `test/us20.2.spec.ts`, `test/ui-smoke.spec.ts` | **PASS** |
| **Projection** | Projects twins as governed work items with native state history, SLA breach notifications, restore metrics and correlation links | `test/twin-projection.spec.ts` | **PASS** |
| **Projection** | Refuses local edits to source-owned fields and routes projected transitions through governed write-back | `test/twin-projection.spec.ts` | **PASS** |
| **Projection** | Matches an owner by assignee email with no `ownerMap` configured, and lets an explicit map override it | `test/twin-projection.spec.ts` | **PASS** |
| **Projection** | Marks a projected item frozen/stale when its connector's projection is disabled, without affecting write-back | `test/twin-projection.spec.ts` | **PASS** |
| **Platform** | Makes a forked audit-integrity chain physically impossible and recovers when two writers race for the same tenant's head | `test/audit-chain-concurrency.spec.ts` | **PASS** |
| **Backlog fixture** | Imports every epic and story from the backlog with its parent-child hierarchy | `test/backlog-fixture.spec.ts` | **PASS** |
