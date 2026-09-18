# Walkthrough — Unified SDLC & ITSM Platform (Phase 0, Stage B Dogfooding & Epic 3)

The **Phase 0 Pilot Build**, **Stage B Dogfooding Backlog Ingestion**, and **Epic 3 — Aging & SLA Engine** are fully implemented, verified, and running live!

---

## 1. Epic 3 — Aging & SLA Engine Implementation

We implemented all 3 user stories of **Epic 3**:

1. **US3.1 — Configurable SLA Thresholds & Business Calendar**:
   - `SlaCalculatorService` (`src/modules/sla/sla-calculator.service.ts`): Computes elapsed working time using UTC dates.
   - **`5x8` Calendar**: Evaluates Monday to Friday, 9:00 AM to 5:00 PM (480 mins/day), excluding weekends and off-hours. An item entering Friday 4:00 PM consumes only 60 minutes by Monday 10:00 AM.
   - **`24x7` Calendar**: Evaluates continuous wall-clock minutes.
   - **No Policy Fallback**: If no SLA threshold is configured for an `(item_type, state)` pair, no false aging alert fires (`aging_score = 0`, `aging_bucket = 'green'`).

2. **US3.2 — Continuous Aging Score & Heatmap Buckets**:
   - `AgingEngineService` (`src/modules/sla/aging-engine.service.ts`): Periodically (60s tick interval) and on demand (`POST /aging/recompute`) updates item `aging_score` (% of SLA consumed) and `aging_bucket` (`green` <75%, `amber` 75-100%, `red` >100%).

3. **US3.3 — Automatic Warning & Breach Notifications + Event Emission**:
   - Emits `SLAWarning` event on `InProcessEventBus` at 75% threshold with owner notification payload.
   - Emits `SLABreached` event on `InProcessEventBus` at 100% threshold with owner + team lead notification payload.

---

## 2. Live Interactive Web Dashboard & SLA Visualizer

The NestJS backend server serves the live interactive web application dashboard directly at **`http://localhost:3000`**.

### UI Features:
1. **SLA Runway Progress Bar**: Every card displays a color-coded SLA Runway bar (Green / Amber / Red) with precise SLA consumption percentage (e.g. `AMBER (80.0%)`).
2. **`⚙️ SLA Policies` Button**: Opens the interactive SLA Policy Management Modal to configure custom thresholds and business calendars per item type and state.
3. **`⏱️ Recompute Aging` Button**: Instantly triggers an aging recompute cycle on demand (`POST /aging/recompute`).
4. **Browser Tab Icon**: Suppressed browser tab favicon cleanly via empty data URI (`<link rel="icon" href="data:,">`).

---

## 3. Verified Automated Test Suites (`npm test`)

All 21 unit/integration tests across 12 test files are passing cleanly:

```
 RUN  v2.1.9 C:/Users/kiran/Cadena

 ✓ test/us1.1.spec.ts (2 tests)
 ✓ test/us1.2.spec.ts (2 tests)
 ✓ test/us1.3.spec.ts (2 tests)
 ✓ test/us2.1.spec.ts (2 tests)
 ✓ test/us2.2.spec.ts (2 tests)
 ✓ test/us3.1.spec.ts (2 tests)
 ✓ test/us3.2.spec.ts (2 tests)
 ✓ test/us3.3.spec.ts (2 tests)
 ✓ test/us4.1.spec.ts (2 tests)
 ✓ test/us4.2.spec.ts (1 test)
 ✓ test/us10.3.spec.ts (1 test)
 ✓ test/stage-b-dogfooding.spec.ts (1 test)

 Test Files  12 passed (12)
      Tests  21 passed (21)
   Duration  93.28s
```
