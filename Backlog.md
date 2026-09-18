# Backlog: epics, user stories & acceptance criteria

Epics below map directly to the services and phases defined in the main specification tab. Each user story follows Given/When/Then acceptance criteria.

## Epic 1 — Canonical work item model & core service

**US1.1** As a platform engineer, I want one WorkItem schema shared across all item types, so that every type gets create/read/update/list for free.

- Given a valid `type` and its required fields, when `POST /workitems` is called, then a WorkItem is persisted with a generated id and the type's default status.
- Given an unrecognized `type`, when `POST /workitems` is called, then the API returns 422 with the list of valid types.

**US1.2** As a user, I want to filter work items by type, status, owner, team, and aging bucket, so that I can build focused views.

- Given items across multiple types and states, when `GET /workitems?state=in_review&aging_bucket=red` is called, then only items matching both filters are returned.
- Given no filters, when listing work items, then results are scoped to the caller's `org_id` only (never cross-tenant).

**US1.3** As a team admin, I want per-type custom fields, so that teams can capture domain-specific data without a schema migration.

- Given a JSON-schema is registered for a type's `custom_fields`, when a work item of that type is created with those fields, then they are validated against the schema and rejected if invalid.
- Given a custom field is added to a type's schema, when existing items of that type are read, then missing fields resolve to a documented default rather than an error.

## Epic 2 — Workflow & state machine engine

**US2.1** As a team lead, I want to configure my team's workflow (states, transitions, guards) without a code deploy, so that operations and product teams can each tune their own lifecycle.

- Given a valid `WorkflowDefinition` for a type, when it is published, then new items of that type follow it immediately and in-flight items keep the version they started under.
- Given an invalid definition (unreachable state, missing terminal state), when it is submitted, then it is rejected with the specific validation error.

**US2.2** As a user, I want transitions to enforce role and required-field guards, so that only qualified actors can move an item and no required data is skipped.

- Given an actor lacking the required role, when they attempt a guarded transition, then the API returns 409 `guard_failed` with the missing role named.
- Given a transition requires fields (e.g. `mitigation_summary`), when those fields are absent, then the transition is rejected until they are supplied.

**US2.3** As an integration, I want to trigger automatic transitions from external events, so that manual status updates aren't needed for routine handoffs.

- Given a pull request linked to a Story is merged, when the merge event is received, then the Story auto-transitions from `In Progress` to `In Review`.
- Given an auto-transition would violate a guard, when the triggering event arrives, then the transition is skipped and logged, not silently forced.

## Epic 3 — Aging & SLA engine

**US3.1** As an operations manager, I want to configure SLA thresholds per item type and state against a business calendar, so that aging reflects real working time, not wall-clock time.

- Given a threshold of 2 business days on a 5x8 calendar, when an item enters that state on a Friday afternoon, then the SLA clock excludes the weekend.
- Given no threshold is configured for a (type, state) pair, when the item sits in that state, then no false aging alert fires.

**US3.2** As a team member, I want each item's aging score continuously visible, so that I know how much SLA runway remains without checking a report.

- Given an item has consumed 80% of its SLA threshold, when I view it, then its aging bucket shows amber.
- Given an item exceeds 100% of its threshold, when the next recompute cycle runs (≤60s), then its bucket flips to red within that window.

**US3.3** As a team lead, I want automatic warning and breach notifications, so that aging items surface before they become late deliveries or missed incident SLAs.

- Given an item crosses 75% of its SLA, when the aging engine detects it, then an `SLAWarning` event is emitted and the owner is notified.
- Given an item crosses 100%, when detected, then an `SLABreached` event is emitted and both owner and team lead are notified.

## Epic 4 — Traceability graph service

**US4.1** As a user, I want to create typed links between work items, so that relationships (blocks, caused\_by, fixed\_by, deployed\_in) are queryable, not just described in a comment.

- Given two existing work items, when I create a link with a valid edge type, then it appears in both items' relationship lists.
- Given an edge type that doesn't apply to the item types involved (e.g. `deployed_in` on two Incidents), when I attempt it, then the API rejects it with the allowed edge types for that pair.

**US4.2** As an engineering lead, I want to query the full upstream lineage of an incident, so that I can find which idea and epic produced the root-cause code.

- Given an incident linked transitively to an epic through fix → PR → story → epic, when I call `GET /workitems/{id}/lineage?direction=up`, then the full chain is returned in order.

**US4.3** As an incident commander, I want downstream impact analysis from a service outage, so that I know which releases and stories are implicated.

- Given a Service linked to multiple Incidents and Releases, when I query impact for that Service, then all affected work items within a specified depth are returned.

**US4.4** As a compliance reviewer, I want an exportable lineage report, so that audits and postmortems don't require manual reconstruction.

- Given a completed incident, when I request its lineage report, then a document listing every node and edge in its chain, with timestamps, is produced.

## Epic 5 — Event bus & event model

**US5.1** As a service owner, I want every WorkItem mutation to publish a schema-registered domain event, so that downstream services never poll for changes.

- Given a state transition succeeds, when it commits, then a `WorkItemStateChanged` event is published within the same transaction boundary (outbox pattern) so no event is lost on a crash.
- Given an event schema changes, when a new field is added, then it is additive-only and old consumers keep working unmodified.

**US5.2** As a consumer service, I want idempotent event processing, so that at-least-once delivery never causes duplicate side effects.

- Given the same event is delivered twice, when both are processed, then the second is a no-op because `event_id` was already seen.

**US5.3** As a platform operator, I want failed events routed to a dead-letter queue with alerting, so that a bad event doesn't silently vanish or block the partition.

- Given a consumer fails to process an event after the configured retry count, when retries are exhausted, then the event moves to that consumer's DLQ and an alert fires on DLQ depth exceeding zero.

## Epic 6 — Git & CI/CD integration

**US6.1** As a developer, I want commits and pull requests automatically linked to the work item referenced in their message, so that I don't have to link manually.

- Given a commit message contains a recognized work item key (e.g. `STORY-482`), when the webhook is received, then a `fixed_by` or `relates_to` link is created automatically.
- Given no recognizable key is found, when the webhook is received, then the commit is stored unlinked and no error is raised.

**US6.2** As a team, I want a merged PR to auto-transition its linked story, so that board status reflects reality without manual updates.

- Given a PR linked to a Story is merged, when the merge webhook fires, then the Story transitions per its `WorkflowDefinition` (e.g. to `In Review`), or the transition is skipped and logged if a guard blocks it.

**US6.3** As a release manager, I want deployments linked to the stories and release they ship, so that "what's in this release" and "where did this feature deploy" are both answerable.

- Given a CI/CD pipeline reports a successful deployment tagged with a release identifier, when the event is received, then all stories in that release are linked to the deployment and the Release item's state advances to `Deployed`.

## Epic 7 — Monitoring/APM integration & auto-incident creation

**US7.1** As an on-call engineer, I want a fired monitoring alert to automatically create an Incident work item, so that incidents don't depend on someone remembering to log one.

- Given a monitoring tool fires an alert above the configured severity threshold, when the webhook is received, then an Incident is created with severity mapped from the alert, in the `Triaged` state.
- Given an alert for the same underlying issue fires again within a dedupe window, when received, then it updates the existing Incident rather than creating a duplicate.

**US7.2** As an incident commander, I want the Incident automatically linked to the affected Service, so that impact analysis (Epic 4) works without manual tagging.

- Given an alert payload identifies a service/host, when the Incident is auto-created, then an `affects` edge to the matching Service record is created.

**US7.3** As an on-call engineer, I want an auto-resolved alert to propose (not force) closing the linked Incident, so that automation speeds things up without hiding real problems.

- Given a monitoring alert resolves, when the resolution event is received, then the linked Incident is moved to `Mitigated` pending human confirmation, never auto-closed to `Resolved` without confirmation.

## Epic 8 — Notification & escalation service

**US8.1** As a work item owner, I want a notification when my item nears its SLA, so that I can act before it breaches.

- Given an item crosses 75% of its SLA threshold, when the `SLAWarning` event is published, then the owner receives a notification via their preferred channel within 1 minute.

**US8.2** As a team lead, I want breach and escalation notifications routed beyond the individual owner, so that aging work doesn't stay invisible to management.

- Given an item breaches its SLA, when `SLABreached` is published, then both the owner and the team lead are notified.
- Given an item reaches 150% of its SLA, when detected, then it escalates to the configured manager/on-call and appears on the executive aging dashboard.

**US8.3** As a user, I want to choose my notification channel (email, Slack, Teams), so that alerts reach me where I actually work.

- Given a user has configured Slack as their preferred channel, when a notification is triggered for them, then it is delivered via Slack, with email as fallback if delivery fails.

## Epic 9 — Dashboards & reporting

**US9.1** As a team member, I want an aging heatmap for my team's board, so that I can see at a glance which items are green/amber/red.

- Given my team's work items, when I open the team dashboard, then each item is colored by its current aging bucket and sorted worst-first within each column.

**US9.2** As an executive, I want a cross-team rollup of flow and SLA compliance, so that I can spot systemic bottlenecks without visiting each team's board.

- Given multiple teams' data, when I open the executive dashboard, then SLA compliance %, average cycle time, and aging distribution are shown per team and business unit.

**US9.3** As an engineering lead, I want an interactive traceability explorer, so that I can visually trace one item's full lineage instead of reading a JSON response.

- Given a work item id, when I open the traceability explorer for it, then its upstream and downstream graph renders interactively, expandable to the configured depth.

**US9.4** As a delivery lead, I want DORA and ITIL metrics reports, so that I can track delivery and operational health with standard, comparable metrics.

- Given a date range, when I request the flow-metrics report, then deployment frequency, change failure rate, MTTR, and lead time for changes are returned, computed from event history (not manual entry).

## Epic 10 — RBAC, identity & audit

**US10.1** As an employee, I want to log in via my company's SSO, so that I don't need a separate platform password.

- Given the org's SAML/OIDC provider is configured, when I attempt login, then I am redirected to the IdP and, on success, issued a platform session without a local password ever existing.

**US10.2** As an IT admin, I want new hires and team changes provisioned automatically via SCIM, so that access stays correct without manual account admin.

- Given a user is added to a team in the IdP, when the SCIM sync runs, then the corresponding team membership and default role are created in the platform within the configured sync interval.

**US10.3** As a security lead, I want every workflow transition gated by role, so that only qualified actors can perform sensitive actions (e.g. closing an Incident, approving a Change).

- Given a role lacks the permission for a transition, when that actor attempts it, then the request is denied with a clear reason (Epic 2, US2.2).

**US10.4** As a compliance reviewer, I want to export the full audit trail for any work item, so that postmortems and audits don't require reconstructing history from logs.

- Given a work item's id, when I call the audit export endpoint, then every event affecting it (state changes, links, field edits) is returned with actor, timestamp, and before/after values.

## Epic 11 — CMDB federation

**US11.1** As a platform architect, I want to federate Service/Asset data from an existing CMDB rather than duplicate it, so that the platform never becomes a second source of truth that drifts.

- Given an external CMDB (e.g. ServiceNow) is configured as the federated source, when a Service is referenced, then its details are fetched live or synced on a defined interval, never hand-entered.
- Given the CMDB is unreachable, when a Service is referenced, then the platform falls back to the last-synced cached copy and flags it as stale.

**US11.2** As an incident commander, I want incidents linked to the correct Service/Asset from the federated CMDB, so that ownership and impact are accurate.

- Given an alert identifies a host or service, when the Incident is auto-created (Epic 7), then it links to the matching federated Service record, including its owning team from the CMDB.

## Epic 12 — ChatOps integration

**US12.1** As an on-call engineer, I want to query and update work item status from Slack/Teams, so that I don't need to context-switch to a browser during an incident.

- Given a linked Slack workspace, when a user runs `/platform status INC-4821`, then the bot replies with current state, aging, and owner.

**US12.2** As an incident responder, I want to run incident commands (acknowledge, mitigate, resolve) directly from chat, so that transitions happen where the team is already coordinating.

- Given a user with the required role runs `/platform mitigate INC-4821 "rolled back v2.3.1"`, when the command executes, then the same guarded transition as the API (Epic 2, US2.2) is applied, including required-field validation.

**US12.3** As a CAB member, I want to approve or reject Change requests from chat, so that approvals aren't blocked on someone being logged into the platform.

- Given a Change request awaiting CAB review, when a CAB member reacts or replies with an approval command, then the Change transitions to `Approved` and the decision is recorded with the approver's identity in the audit trail.
