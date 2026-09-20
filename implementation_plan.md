# Implementation Plan and Delivery Record

This document records the delivered pilot architecture and subsequent implementation increments. Codex-authored delivery records are kept above the original Gemini Epic 3 plan so ownership and current status are explicit.

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
