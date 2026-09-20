# Implementation Plan and Delivery Record

This document records the delivered pilot architecture and subsequent implementation increments. Codex-authored delivery records are kept above the original Gemini Epic 3 plan so ownership and current status are explicit.

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
