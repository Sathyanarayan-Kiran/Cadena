import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import backlog from '../backlog.json';
import overlay from '../implementation-status.json';
import { buildTrackerDocument, trackerAsOfDate } from '../scripts/build-tracker.mjs';

/**
 * Keeps the implementation tracker honest.
 *
 * The tracker is generated from two files that are edited independently: backlog.json adds
 * requirements, implementation-status.json records how far each one has got. Nothing stops
 * those drifting apart except this test, so a new story with no status entry, or a status
 * entry for a story nobody wrote, fails here rather than silently vanishing from the page.
 */
describe('Implementation tracker', () => {
  const backlogStoryIds = backlog.epics.flatMap((epic) => epic.stories.map((story) => story.id));
  const overlayStoryIds = Object.keys(overlay.stories);
  const VALID_STATUSES = ['done', 'partial', 'idle'];

  it('records a status for every story in the backlog, and no others', () => {
    const missing = backlogStoryIds.filter((id) => !overlayStoryIds.includes(id));
    const orphaned = overlayStoryIds.filter((id) => !backlogStoryIds.includes(id));

    expect(missing, 'stories in backlog.json with no entry in implementation-status.json').toEqual([]);
    expect(orphaned, 'entries in implementation-status.json with no story in backlog.json').toEqual([]);
    expect(backlogStoryIds).toHaveLength(overlayStoryIds.length);
  });

  it('records a rollout phase for every epic', () => {
    const missing = backlog.epics
      .map((epic) => epic.epic_id)
      .filter((id) => !(id in overlay.epics));
    expect(missing, 'epics with no rollout phase assigned').toEqual([]);
  });

  it('uses only valid statuses and known phases', () => {
    const specPhaseIds = overlay.spec_phases.map((phase) => phase.id);
    const badStatus: string[] = [];
    const badPhase: string[] = [];
    const missingNote: string[] = [];

    for (const [id, story] of Object.entries(overlay.stories) as [string, any][]) {
      if (!VALID_STATUSES.includes(story.status)) badStatus.push(`${id}=${story.status}`);
      if (!specPhaseIds.includes(story.phase)) badPhase.push(`${id}=${story.phase}`);
      // A status with no explanation is the thing that rots first.
      if (!story.note?.trim() || !story.name?.trim()) missingNote.push(id);
    }

    expect(badStatus, 'stories with an unrecognized status').toEqual([]);
    expect(badPhase, 'stories assigned to a phase that does not exist').toEqual([]);
    expect(missingNote, 'stories missing a title or an explanatory note').toEqual([]);
  });

  it('assigns every epic a rollout phase that exists', () => {
    const known = overlay.rollout_phases;
    const bad = Object.entries(overlay.epics as Record<string, { rollout: string }>)
      .filter(([, meta]) => !known.includes(meta.rollout))
      .map(([id, meta]) => `${id}=${meta.rollout}`);
    expect(bad, 'epics assigned to an unknown rollout phase').toEqual([]);
  });

  it('records platform milestones separately from product-story completion', () => {
    const milestones = (overlay as any).platform_milestones;
    expect(Array.isArray(milestones)).toBe(true);
    expect(milestones.length).toBeGreaterThan(0);
    for (const milestone of milestones) {
      expect(milestone.id?.trim()).toBeTruthy();
      expect(milestone.name?.trim()).toBeTruthy();
      expect(VALID_STATUSES).toContain(milestone.status);
      expect(milestone.note?.trim()).toBeTruthy();
      expect(milestone.remaining?.trim()).toBeTruthy();
      expect(milestone.evidence?.length).toBeGreaterThan(0);
    }
  });

  it('records every scope delta without relabelling existing scope as new', () => {
    // Deltas are an ordered list: a single entry could not represent a second increment,
    // because its current_* counts must equal the canonical backlog and only one delta
    // can be the newest. Each entry must still balance on its own arithmetic.
    const deltas = (overlay as any).deltas;
    const epicIds = backlog.epics.map((epic) => epic.epic_id);
    const status = (overlay as any).stories;
    const epicStatus = (overlay as any).epics;

    expect(Array.isArray(deltas)).toBe(true);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0].source).toBe('cadena-master-epics-and-user-stories.md');

    for (const delta of deltas) {
      expect(delta.baseline_epics + delta.added_epics.length).toBe(delta.current_epics);
      expect(delta.baseline_stories + delta.added_stories.length).toBe(delta.current_stories);
      expect(delta.added_stories.filter((id: string) => delta.expanded_stories.includes(id))).toEqual([]);

      for (const id of delta.added_epics) {
        expect(epicIds).toContain(id);
        expect(epicStatus[id].addedIn).toBe(delta.id);
      }
      for (const id of delta.added_stories) expect(status[id].addedIn).toBe(delta.id);
      for (const id of delta.expanded_stories) expect(status[id].expandedIn).toBe(delta.id);
    }

    // Each delta must start where the previous one finished.
    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i].baseline_epics).toBe(deltas[i - 1].current_epics);
      expect(deltas[i].baseline_stories).toBe(deltas[i - 1].current_stories);
    }

    // Only the newest describes the backlog as it stands.
    const newest = deltas[deltas.length - 1];
    expect(newest.current_epics).toBe(backlog.epics.length);
    expect(newest.current_stories).toBe(backlogStoryIds.length);
  });

  it('has a generated page that matches the current story count', () => {
    const page = join(__dirname, '..', 'public', 'status.html');
    expect(existsSync(page), 'public/status.html is missing — run `npm run tracker`').toBe(true);

    const html = readFileSync(page, 'utf8');
    // The generator inlines the model, so a stale page is detectable by story id.
    const absent = backlogStoryIds.filter((id) => !html.includes(`"${id}"`));
    expect(absent, 'stories missing from the generated page — run `npm run tracker`').toEqual([]);
  });

  it('generates identical output on different wall-clock days', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-25T01:00:00Z'));
      const first = buildTrackerDocument();
      vi.setSystemTime(new Date('2031-04-17T23:59:59Z'));
      const second = buildTrackerDocument();

      expect(second).toBe(first);
      expect(first).toContain(`<span><b>Built</b> ${trackerAsOfDate()}</span>`);
    } finally {
      vi.useRealTimers();
    }
  });
});
