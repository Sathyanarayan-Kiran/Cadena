# Implementation Plan — Epic 3: Aging & SLA Engine

This document outlines the architecture, technical design, database schema, event model, and execution plan for **Epic 3 — Aging & SLA Engine** (US3.1, US3.2, US3.3).

## Codex implementation update — 2026-09-19

> **Attribution boundary:** Everything in this section describes work implemented by **Codex** on 2026-09-19. The section titled **Original Gemini implementation plan (historical baseline)** and all content below it are retained to distinguish the earlier Gemini plan from the Codex changes.

**Status:** Implemented; final build and automated regression verification recorded below.

### Changes implemented by Codex

#### Release and correctness stabilization

- Corrected the TypeScript build layout by compiling only `src/` with `src` as `rootDir`, so the existing `npm start` command resolves the emitted `dist/server.js` entry point.
- Fixed strict typing for the SLA team-lead query and the SLA test result rows.
- Added `aging_score` to the canonical API type and corrected WorkItem mapping to return persisted `aging_bucket` and `aging_score` values written by the aging engine.
- Removed the older API read-path behavior that inferred SLA health from `custom_fields`, making the SLA columns the single source of truth.
- Added built-in, enforced workflows for Epic, Story, and Incident items. Items without a custom published workflow can no longer transition to arbitrary state names.
- Added `GET /workitems/:id/available-transitions` so clients can render only workflow-permitted next states and required fields.
- Scoped item detail, transition, relationship, and lineage operations to the active `x-org-id` tenant; cross-tenant links are explicitly rejected.
- Corrected lineage traversal so upstream and downstream follow relationship semantics instead of returning the same traversal.

#### Canonical model and dogfooding

- Added `epic` as a first-class WorkItem type with the delivery workflow and valid Epic/Story relationship pairs.
- Updated Stage B backlog import to create actual Epic items rather than Stories carrying an `is_epic` flag as their effective type.
- Kept the original backlog counts intact: 12 Epics, 38 Stories, and 38 parent-child relationships.

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

#### Codex verification additions

- Updated existing tests to pass tenant context on protected item routes.
- Updated SLA filter fixtures to use the persisted SLA columns instead of a custom-field override.
- Updated dogfooding verification to assert that imported backlog parents are true `epic` items.
- Added/updated coverage for the public SLA API contract, tenant isolation, and directional lineage behavior.

### Primary files changed by Codex

- `public/index.html`
- `src/modules/work-items/work-item.types.ts`
- `src/modules/work-items/work-item.service.ts`
- `src/modules/work-items/work-item.controller.ts`
- `src/modules/workflow/workflow.service.ts`
- `src/modules/lineage/lineage.types.ts`
- `src/modules/lineage/lineage.service.ts`
- `src/modules/lineage/lineage.controller.ts`
- `src/modules/sla/aging-engine.service.ts`
- `src/scripts/import-backlog.ts`
- `src/server.ts`
- `tsconfig.json`
- Acceptance and regression tests under `test/`

### Verification result

- `npm run build`: **PASS**
- Browser UI script parse check: **PASS**
- `npm test`: **PASS — 12 test files, 22 tests**

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
