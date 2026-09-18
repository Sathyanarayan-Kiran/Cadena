# Unified SDLC & ITSM Platform — Pilot Build (Phase 0)

This repository contains the pilot implementation of the Unified SDLC & ITSM platform as specified in the **Technical Specification** and **Backlog**.

The pilot proves the platform's core thesis: **one canonical work-item model** and **one state-machine engine** serving both delivery item types (`Story`) and operational item types (`Incident`), with real, queryable traceability between them.

---

## Technical Stack & Architecture

- **Runtime & Framework**: TypeScript throughout, NestJS backend API.
- **Datastore**: PostgreSQL with `pgvector` extension enabled via `@electric-sql/pglite` WASM in-process engine.
- **Workflow Engine**: Hand-rolled state-machine engine implementing Spec §4, supporting versioned definitions, role guards, required fields, and reachability validation.
- **Traceability Graph**: Typed edge table (`work_item_links`) supporting upstream and downstream recursive lineage traversal.
- **Testing**: Vitest + NestJS Testing + Supertest running 14 automated tests mapping 1-to-1 to backlog Acceptance Criteria.

---

## How to Run

### 1. Run Automated Test Suite (Single Command)

To run the complete test suite verifying every acceptance criterion across Epics 1, 2, 4, and 10:

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
 ✓ test/us4.1.spec.ts (2 tests)
 ✓ test/us4.2.spec.ts (1 test)
 ✓ test/us10.3.spec.ts (1 test)

 Test Files  8 passed (8)
      Tests  14 passed (14)
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

## Note on Extending to Phase 1 (Spec §18.5)

To transition from Phase 0 (Pilot) to Phase 1 (Signal & Aging) of the roadmap:

1. **Aging & SLA Engine (Epic 3)**:
   - Add a scheduled background recalculation loop (e.g. BullMQ / Redis or Temporal) running every 60 seconds.
   - Implement business calendar logic (5x8 vs 24x7) to adjust `entered_state_at` clocks and dynamically compute green/amber/red heatmap buckets.
   - Emit `SLAWarning` and `SLABreached` domain events when SLA thresholds are crossed.

2. **First Integrations (Epics 6 & 7)**:
   - Build the Integration Gateway service to ingest inbound webhooks from Git hosts (GitHub/GitLab) and CI/CD pipelines.
   - Automatically link PRs/commits to WorkItems via key references (`STORY-123`).
   - Implement auto-transitions (e.g., PR merge auto-transitions Story to `InReview` subject to guard evaluation).
   - Ingest APM/Datadog monitoring alerts to auto-create `Incident` work items in `Triaged` state with severity mapping and deduplication windows.

3. **Production Event Bus (Epic 5)**:
   - Replace `InProcessEventBus` with Kafka / AWS MSK using a transactional outbox pattern in Postgres to guarantee at-least-once event delivery.

4. **Dashboards & Visualization UI (Epic 9)**:
   - Connect Next.js + tRPC frontend to render team aging heatmaps and an interactive visual graph representation of the lineage traversal API (`GET /workitems/{id}/lineage`).

---

## Verified Backlog Acceptance Criteria Summary

| Story | Acceptance Criteria Description | Test File | Status |
| --- | --- | --- | --- |
| **US1.1** | Creates work item with valid type (`story`/`incident`) & default status (`Proposed`/`Triaged`) | `test/us1.1.spec.ts` | **PASS** |
| **US1.1** | Rejects unrecognized type with HTTP 422 and valid types list | `test/us1.1.spec.ts` | **PASS** |
| **US1.2** | Filters work items by state and aging bucket | `test/us1.2.spec.ts` | **PASS** |
| **US1.2** | Scopes work item queries strictly to caller's `org_id` (multi-tenant isolation) | `test/us1.2.spec.ts` | **PASS** |
| **US1.3** | Validates custom fields against registered JSON schema | `test/us1.3.spec.ts` | **PASS** |
| **US1.3** | Resolves missing custom fields to documented default on read | `test/us1.3.spec.ts` | **PASS** |
| **US2.1** | Publishes workflow definition & preserves in-flight item versions | `test/us2.1.spec.ts` | **PASS** |
| **US2.1** | Rejects invalid workflow definition with specific validation error | `test/us2.1.spec.ts` | **PASS** |
| **US2.2** | Rejects transition when actor lacks required role with 409 `guard_failed` | `test/us2.2.spec.ts` | **PASS** |
| **US2.2** | Rejects transition when required fields are missing | `test/us2.2.spec.ts` | **PASS** |
| **US4.1** | Creates valid typed link & exposes in both items' relationship lists | `test/us4.1.spec.ts` | **PASS** |
| **US4.1** | Rejects invalid edge type for item pair with allowed edge types | `test/us4.1.spec.ts` | **PASS** |
| **US4.2** | Queries full upstream lineage chain in topological order | `test/us4.2.spec.ts` | **PASS** |
| **US10.3** | Enforces RBAC role permissions on workflow state transitions | `test/us10.3.spec.ts` | **PASS** |
