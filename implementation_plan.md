# Implementation Plan — Unified SDLC & ITSM Platform (Phase 0 Pilot)

This document outlines the architecture, project setup, database schema, event contracts, and execution plan for the **Phase 0 Pilot Build** of the Unified SDLC & ITSM platform.

## Objective & Thesis

The primary goal of Phase 0 is to validate the core architectural thesis of the platform:
1. **One Canonical Work-Item Model** serving both delivery item types (`Story`) and operational item types (`Incident`).
2. **One State-Machine Engine** enforcing workflow transitions, guards, required fields, and versioned definitions across both item types.
3. **Real, Queryable Traceability** between delivery and operational items via a typed edge table and recursive lineage queries.
4. **Least-Privilege RBAC & Auditability** gating state transitions and logging immutable audit events.

---

## Technical Stack (Spec §17.1)

- **Language & Runtime**: TypeScript throughout (NestJS backend, Next.js + tRPC frontend, shared types package).
- **Database**: PostgreSQL with `pgvector` extension enabled (`CREATE EXTENSION IF NOT EXISTS vector;`).
- **ORM / Query Builder**: Prisma or Drizzle ORM (type-safe database queries and migrations).
- **Workflow / State Machine**: Hand-rolled state machine engine per Spec §4 (no external orchestrator).
- **Event Handling**: In-process Event Emitter matching the contract described in Spec §8 (`event_id`, `event_type`, `timestamp`, `actor`, `work_item_id`, `payload`).
- **Auth**: Minimal role check on user record per US10.3 (headers/tokens identifying actor ID & role).

---

## User Review Required

> [!IMPORTANT]
> **Strict Phase 0 Scope Boundary**: Out of scope for this pilot: aging/SLA engine (Epic 3), Kafka event bus (Epic 5), external integrations (Epics 6, 7, 11, 12), dashboards/reporting (Epic 9), notifications (Epic 8), SSO/SCIM (US10.1, US10.2).

> [!NOTE]
> **Sequential Branch & Story Cadence**: Each user story will be built on its own git branch in the exact order specified. Automated tests trace directly to user story acceptance criteria (e.g. `US1.1: rejects unrecognized type with 422`).

---

## Project Structure & Architecture

```
/
├── apps/
│   ├── backend/                # NestJS API backend
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── work-items/  # US1.1, US1.2, US1.3 (CRUD, custom fields, tenancy)
│   │   │   │   ├── workflow/    # US2.1, US2.2 (Workflow engine, guards, versioning)
│   │   │   │   ├── lineage/     # US4.1, US4.2 (Typed links, recursive CTE lineage)
│   │   │   │   ├── rbac/        # US10.3 (Role checks & permissions)
│   │   │   │   └── events/      # In-process event bus contract (Spec §8)
│   │   │   ├── database/        # Schema, migrations, seed data
│   │   │   └── main.ts
│   │   └── test/                # End-to-end AC verification suite
│   └── frontend/               # Next.js + tRPC UI for pilot verification
├── packages/
│   └── shared/                 # Shared TypeScript interfaces, types, & DTOs
├── package.json
└── README.md
```

---

## Database Schema (Postgres + pgvector)

### Core Tables

1. **`orgs`**
   - `id`: UUID (PK)
   - `name`: String
   - `created_at`: Timestamp

2. **`teams`**
   - `id`: UUID (PK)
   - `org_id`: UUID (FK -> `orgs`)
   - `name`: String
   - `created_at`: Timestamp

3. **`people`**
   - `id`: UUID (PK)
   - `org_id`: UUID (FK -> `orgs`)
   - `team_id`: UUID (FK -> `teams`)
   - `name`: String
   - `email`: String
   - `role`: Enum (`developer`, `on_call`, `incident_commander`, `team_lead`, `cab_approver`, `admin`)

4. **`workflow_definitions`**
   - `id`: UUID (PK)
   - `type`: Enum (`story`, `incident`)
   - `version`: Integer
   - `definition`: JSONB (`states`, `transitions`, `initial_state`, `guards`, `required_fields`)
   - `created_at`: Timestamp

5. **`custom_field_schemas`**
   - `id`: UUID (PK)
   - `type`: Enum (`story`, `incident`)
   - `version`: Integer
   - `schema`: JSONB (JSON Schema for validation)
   - `defaults`: JSONB (Documented defaults for missing fields)
   - `created_at`: Timestamp

6. **`work_items`**
   - `id`: UUID (PK)
   - `type`: Enum (`story`, `incident`)
   - `title`: String
   - `description`: Text
   - `status`: String
   - `workflow_version`: Integer
   - `priority`: Enum (`P0`, `P1`, `P2`, `P3`, `P4`)
   - `severity`: Enum (`SEV1`, `SEV2`, `SEV3`, `SEV4`), Nullable
   - `owner_id`: UUID (FK -> `people`)
   - `team_id`: UUID (FK -> `teams`)
   - `org_id`: UUID (FK -> `orgs`)
   - `entered_state_at`: Timestamp
   - `custom_fields`: JSONB
   - `tags`: String[]
   - `created_at`: Timestamp
   - `updated_at`: Timestamp

7. **`work_item_links`**
   - `id`: UUID (PK)
   - `source_id`: UUID (FK -> `work_items`)
   - `target_id`: UUID (FK -> `work_items`)
   - `link_type`: Enum (`parent_of`, `child_of`, `blocks`, `blocked_by`, `relates_to`, `caused_by`, `fixed_by`, `deployed_in`, `affects`, `duplicate_of`)
   - `created_at`: Timestamp

8. **`audit_events`**
   - `id`: UUID (PK)
   - `event_type`: String
   - `work_item_id`: UUID (FK -> `work_items`)
   - `actor_id`: UUID (FK -> `people`)
   - `payload`: JSONB
   - `timestamp`: Timestamp

---

## Order of Implementation & User Story Test Mapping

We will execute the 4 in-scope Epics across 8 User Stories in the strict required sequence:

### Phase 1: Epic 1 — Canonical Work Item Model & Core Service

#### 1. `US1.1` — Canonical WorkItem Schema & Creation
- **Branch**: `feature/US1.1-canonical-schema`
- **AC1 Test (`US1.1: creates work item with valid type and default status`)**:
  - `POST /workitems` with type `story` -> Status `Proposed`, UUID generated, persisted in DB.
  - `POST /workitems` with type `incident` -> Status `Triaged`, UUID generated, persisted in DB.
- **AC2 Test (`US1.1: rejects unrecognized type with 422`)**:
  - `POST /workitems` with invalid type `unknown_type` -> HTTP 422 containing list of valid types (`['story', 'incident']`).

#### 2. `US1.2` — Work Item Filtering & Multi-Tenant Isolation
- **Branch**: `feature/US1.2-filtering-tenancy`
- **AC1 Test (`US1.2: filters work items by state and aging bucket`)**:
  - `GET /workitems?state=in_review&aging_bucket=red` returns only items matching both `state=in_review` and `aging_bucket=red`.
- **AC2 Test (`US1.2: scopes work item queries strictly to caller org_id`)**:
  - `GET /workitems` called by tenant Org-A returns only Org-A items, never Org-B items.

#### 3. `US1.3` — Custom Fields JSON Schema Validation & Defaults
- **Branch**: `feature/US1.3-custom-fields`
- **AC1 Test (`US1.3: validates custom fields against registered JSON schema`)**:
  - Register JSON Schema for `story` custom fields (e.g. `story_points`: integer). `POST /workitems` with string `story_points` returns 422 validation error.
- **AC2 Test (`US1.3: resolves missing custom fields to documented default on read`)**:
  - Reading an existing item missing a newly added custom field returns documented default values instead of null/error.

---

### Phase 2: Epic 2 — Workflow & State Machine Engine

#### 4. `US2.1` — Dynamic Workflow Definitions & Versioning
- **Branch**: `feature/US2.1-workflow-definition`
- **AC1 Test (`US2.1: publishes workflow definition and preserves in-flight item versions`)**:
  - Publish Workflow v1 for `story`. Create Item A under v1. Publish Workflow v2. Create Item B under v2. Item A stays on v1 execution rules; Item B uses v2.
- **AC2 Test (`US2.1: rejects invalid workflow definition with specific validation error`)**:
  - Submitting definition with unreachable states or missing terminal state returns 400/422 with structural error breakdown.

#### 5. `US2.2` — State Transitions, Role Guards & Required Fields
- **Branch**: `feature/US2.2-state-transitions-guards`
- **AC1 Test (`US2.2: rejects transition when actor lacks required role with 409 guard_failed`)**:
  - Transitioning Incident from `triaged` to `investigating` by an unauthorized role returns `409 Conflict` with `"error": "guard_failed"` and missing role specified.
- **AC2 Test (`US2.2: rejects transition when required fields are missing`)**:
  - Transitioning Incident from `investigating` to `mitigated` without `mitigation_summary` returns 400/409 validation error until supplied.

---

### Phase 3: Epic 4 — Traceability Graph Service

#### 6. `US4.1` — Typed Links Between Work Items
- **Branch**: `feature/US4.1-typed-links`
- **AC1 Test (`US4.1: creates valid typed link and exposes in both items relationship lists`)**:
  - `POST /workitems/{id}/links` between Story and Incident with edge `caused_by` succeeds; both items reflect the relationship.
- **AC2 Test (`US4.1: rejects invalid edge type for item pair with allowed edge types`)**:
  - Attempting `deployed_in` link between two Incidents is rejected with list of valid allowed edges for `(incident, incident)` pair.

#### 7. `US4.2` — Upstream Lineage Traversal Query
- **Branch**: `feature/US4.2-lineage-queries`
- **AC1 Test (`US4.2: queries full upstream lineage chain in order`)**:
  - Chain: Incident -> `fixed_by` -> Bug/Task -> `child_of` -> Story -> `child_of` -> Epic.
  - `GET /workitems/{incident_id}/lineage?direction=up` returns the ordered lineage path from Incident up to Epic.

---

### Phase 4: Epic 10 — Security, RBAC & Transition Gating

#### 8. `US10.3` — Role-Gated Transitions & Audit Logging
- **Branch**: `feature/US10.3-rbac-transition-gating`
- **AC1 Test (`US10.3: enforces role permissions on state transitions and logs audit events`)**:
  - User with role `incident_commander` can transition Incident to `resolved`. User with role `developer` cannot.
  - Successful transitions generate immutable `audit_events` records containing actor ID, timestamp, and state delta.

---

## Verification Plan & Single Command Test Execution

### Automated Verification
- We will configure a single npm script: `npm test`
- `npm test` will launch Postgres container (or execute against clean test DB) and run the full Jest/Vitest suite covering all 14 Acceptance Criteria across Epics 1, 2, 4, and 10.

---

## Summary of Work Completed upon Approval
Upon approval of this plan, implementation will begin story-by-story with branch creation, automated tests per AC, diff self-reviews, and test execution reports.
