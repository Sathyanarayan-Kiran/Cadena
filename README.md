# Unified SDLC & ITSM Platform — Pilot Build

This repository contains the pilot implementation of the Unified SDLC & ITSM platform as specified in the **Technical Specification** and **Backlog**.

The pilot proves the platform's core thesis: **one canonical work-item model** and **one state-machine engine** serving delivery item types (`Epic`, `Story`, `Release`) and operational item types (`Incident`), with real, queryable traceability between them.

> **Current status (Codex update, 2026-09-20):** Phase 0, the Epic 3 aging/SLA engine, Stage B backlog dogfooding, and the first Phase 1 integration slice (US2.3 and Epic 6) are implemented. See `implementation_plan.md` for the clearly attributed Codex delivery records.

---

## Technical Stack & Architecture

- **Runtime & Framework**: TypeScript throughout, NestJS backend API.
- **Datastore**: PostgreSQL with `pgvector` extension enabled via `@electric-sql/pglite` WASM in-process engine.
- **Workflow Engine**: Hand-rolled state-machine engine implementing Spec §4, supporting versioned definitions, role guards, required fields, and reachability validation.
- **Traceability Graph**: Typed edge table (`work_item_links`) supporting upstream and downstream recursive lineage traversal.
- **Aging & SLA**: 60-second recalculation, 5×8 and 24×7 calendars, persisted aging score/bucket, and warning/breach events.
- **Git/CI Gateway**: Idempotent normalized webhooks, commit/PR/deployment artifacts, work-item key matching, external links, and workflow-safe automation.
- **Pilot UI**: Responsive board/list workspace, workflow-driven transitions, SLA health, item details, linking, and lineage exploration.
- **Testing**: Vitest + NestJS Testing + Supertest running 27 automated tests across 16 test files.

---

## How to Run

### 1. Run Automated Test Suite (Single Command)

To run the complete test suite covering Epics 1, 2, 3, 4, 6, and 10 plus Stage B dogfooding:

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
 ✓ test/us6.1.spec.ts (2 tests)
 ✓ test/us6.2.spec.ts (1 test)
 ✓ test/us6.3.spec.ts (1 test)
 ✓ test/us10.3.spec.ts (1 test)
 ✓ test/stage-b-dogfooding.spec.ts (1 test)

 Test Files  16 passed (16)
      Tests  27 passed (27)
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

## Remaining Phase 1 Work (Spec §18.5)

The aging engine, team workspace, workflow automation, and Git/CI integration are implemented. The remaining Phase 1 work is:

1. **Monitoring/APM Integration (Epic 7)**:
   - Ingest monitoring alerts and auto-create tenant-scoped Incidents with severity mapping and deduplication windows.
   - Resolve affected services and add `affects` traceability.
   - Propose mitigation when provider alerts resolve, without silently closing Incidents.

2. **Production Event Bus (Epic 5)**:
   - Replace `InProcessEventBus` with Kafka / AWS MSK using a transactional outbox pattern in Postgres to guarantee at-least-once event delivery.

3. **Production Analytics & Executive UI (Epic 9)**:
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
| **US6.1** | Stores commits and links recognized work-item keys while retaining unlinked commits | `test/us6.1.spec.ts` | **PASS** |
| **US6.2** | Auto-transitions a linked Story when its pull request is merged | `test/us6.2.spec.ts` | **PASS** |
| **US6.3** | Links deployments to Stories/Releases, advances the Release, and deduplicates delivery replay | `test/us6.3.spec.ts` | **PASS** |
| **US10.3** | Enforces RBAC role permissions on workflow state transitions | `test/us10.3.spec.ts` | **PASS** |
| **Stage B** | Imports 12 true Epic items, 38 Stories, and their hierarchy | `test/stage-b-dogfooding.spec.ts` | **PASS** |
