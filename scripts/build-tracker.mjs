/**
 * Builds the implementation tracker page from backlog.json + implementation-status.json.
 *
 *   node scripts/build-tracker.mjs [--fragment <path>]
 *
 * backlog.json owns the epics, stories and acceptance criteria. implementation-status.json
 * owns delivery status, the abridged titles shown in the tracker, and phase alignment.
 * Keeping them apart means adding a requirement never silently changes a status, and
 * test/tracker.spec.ts fails if either file gains an entry the other does not have.
 *
 * Writes public/status.html (a full document the pilot server serves at /status.html).
 * With --fragment it also writes the headless body used when publishing the page elsewhere.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));

const backlog = read('backlog.json');
const overlay = read('implementation-status.json');

const STATUS_LABEL = { done: 'Done', partial: 'Partial', idle: 'Not started' };

/** Merges the two sources into the shape the page renders, failing loudly on a gap. */
export function buildModel() {
  const problems = [];
  const seen = new Set();

  const epics = backlog.epics.map((epic) => {
    const meta = overlay.epics[epic.epic_id];
    if (!meta) problems.push(`implementation-status.json has no entry for epic ${epic.epic_id}`);

    const stories = epic.stories.map((story) => {
      const status = overlay.stories[story.id];
      seen.add(story.id);
      if (!status) {
        problems.push(`implementation-status.json has no entry for story ${story.id}`);
        return null;
      }
      if (!STATUS_LABEL[status.status]) {
        problems.push(`${story.id} has unknown status '${status.status}'`);
      }
      return {
        id: story.id,
        name: status.name,
        status: status.status,
        phase: status.phase,
        note: status.note,
        isNew: Boolean(status.isNew),
        addedIn: status.addedIn ?? null,
        expandedIn: status.expandedIn ?? null,
        statement: story.statement,
        criteria: story.acceptance_criteria.length,
      };
    }).filter(Boolean);

    return {
      id: epic.epic_id,
      title: epic.title,
      rollout: meta?.rollout ?? 'Unassigned',
      isNew: Boolean(meta?.isNew),
      addedIn: meta?.addedIn ?? null,
      stories,
    };
  });

  for (const id of Object.keys(overlay.stories)) {
    if (!seen.has(id)) problems.push(`implementation-status.json describes ${id}, which is not in backlog.json`);
  }

  /**
   * Scope changes are recorded as an ordered list of deltas.
   *
   * This was a single `latest_delta`, which could not represent a second increment: its
   * `current_*` counts had to equal the canonical backlog, so adding any story outside that
   * one delta made the file self-contradictory. A list keeps each increment's provenance
   * intact and lets the newest one drive the page's "new" badges. The old single-object
   * shape is still accepted so the contract degrades rather than breaks.
   */
  const deltas = overlay.deltas ?? (overlay.latest_delta ? [overlay.latest_delta] : []);
  const latestDelta = deltas.length > 0 ? deltas[deltas.length - 1] : null;

  if (deltas.length > 0) {
    const epicIds = new Set(epics.map((epic) => epic.id));
    const storyIds = new Set(epics.flatMap((epic) => epic.stories.map((story) => story.id)));

    // Only the newest delta describes the backlog as it stands now.
    if (latestDelta.current_epics !== epics.length || latestDelta.current_stories !== storyIds.size) {
      problems.push('the newest delta current counts do not match the canonical backlog');
    }

    for (const delta of deltas) {
      if (delta.baseline_epics + delta.added_epics.length !== delta.current_epics) {
        problems.push(`delta ${delta.id} epic arithmetic does not balance`);
      }
      if (delta.baseline_stories + delta.added_stories.length !== delta.current_stories) {
        problems.push(`delta ${delta.id} story arithmetic does not balance`);
      }
      for (const id of delta.added_epics) {
        if (!epicIds.has(id)) problems.push(`delta ${delta.id} added epic ${id} is not in backlog.json`);
        if (overlay.epics[id]?.addedIn !== delta.id) problems.push(`${id} is missing addedIn=${delta.id}`);
      }
      for (const id of delta.added_stories) {
        if (!storyIds.has(id)) problems.push(`delta ${delta.id} added story ${id} is not in backlog.json`);
        if (overlay.stories[id]?.addedIn !== delta.id) problems.push(`${id} is missing addedIn=${delta.id}`);
      }
      for (const id of delta.expanded_stories) {
        if (!storyIds.has(id)) problems.push(`delta ${delta.id} expanded story ${id} is not in backlog.json`);
        if (overlay.stories[id]?.expandedIn !== delta.id) problems.push(`${id} is missing expandedIn=${delta.id}`);
      }
    }
  }

  return {
    epics,
    problems,
    specPhases: overlay.spec_phases,
    rollouts: overlay.rollout_phases,
    latestDelta,
  };
}

/** Renders one delta category, or nothing at all when it contributed none. */
function deltaLine(noun, ids, verb = 'added') {
  if (!ids || ids.length === 0) return '';
  const plural = ids.length === 1 ? noun : `${noun}s`;
  return `<li><b>${ids.length} ${plural} ${verb}:</b> ${ids.join(', ')}</li>`;
}

function page(model, meta) {
  const data = JSON.stringify({
    epics: model.epics,
    specPhases: model.specPhases,
    rollouts: model.rollouts,
    latestDelta: model.latestDelta,
  });

  return `<title>Cadena Delivery Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Serif:ital,wght@0,400;0,600;1,400&display=swap">
<style>
  :root {
    --ground:#f4f6f5; --surface:#fff; --surface-2:#eef2f1;
    --ink:#16201f; --ink-2:#4a5755; --ink-3:#6e7b79;
    --line:#dce3e1; --line-strong:#c5cfcd;
    --accent:#0e7c86; --done:#2f6b3a; --done-soft:#e2f0e4;
    --partial:#a96a12; --partial-soft:#f8ebd7;
    --idle:#6e7b79; --idle-soft:#e6ebea; --risk:#a63a3a;
    --sans:"IBM Plex Sans",ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
    --serif:"IBM Plex Serif",Georgia,"Times New Roman",serif;
    --mono:"IBM Plex Mono",ui-monospace,Consolas,monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground:#0e1514; --surface:#151e1d; --surface-2:#1c2726;
      --ink:#e6edeb; --ink-2:#a9b6b4; --ink-3:#7d8a88;
      --line:#263432; --line-strong:#354643;
      --accent:#3fb3bd; --done:#6fcb86; --done-soft:#15291c;
      --partial:#e0a950; --partial-soft:#2e2313;
      --idle:#8a9795; --idle-soft:#1e2827; --risk:#e07a7a;
    }
  }
  :root[data-theme="dark"] {
    --ground:#0e1514; --surface:#151e1d; --surface-2:#1c2726;
    --ink:#e6edeb; --ink-2:#a9b6b4; --ink-3:#7d8a88;
    --line:#263432; --line-strong:#354643;
    --accent:#3fb3bd; --done:#6fcb86; --done-soft:#15291c;
    --partial:#e0a950; --partial-soft:#2e2313;
    --idle:#8a9795; --idle-soft:#1e2827; --risk:#e07a7a;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--ground); color:var(--ink); font-family:var(--sans); font-size:15px; line-height:1.5; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1120px; margin:0 auto; padding:0 20px; }
  .wrap.page { padding-block:40px 72px; }
  .masthead { border-bottom:2px solid var(--ink); padding-bottom:18px; margin-bottom:26px; }
  .eyebrow { font-family:var(--mono); font-size:11px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); margin:0 0 10px; }
  h1 { font-family:var(--serif); font-weight:600; font-size:clamp(30px,5vw,46px); line-height:1.04; letter-spacing:-.02em; margin:0 0 12px; text-wrap:balance; }
  .standfirst { font-family:var(--serif); font-size:17px; line-height:1.55; color:var(--ink-2); max-width:62ch; margin:0 0 16px; }
  .provenance { display:flex; flex-wrap:wrap; gap:8px 22px; font-family:var(--mono); font-size:11.5px; color:var(--ink-3); }
  .provenance b { color:var(--ink-2); font-weight:500; }
  .tally-band { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); margin-bottom:8px; }
  .tally { background:var(--surface); padding:16px 18px; }
  .tally-n { font-family:var(--mono); font-size:30px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums; }
  .tally-l { font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); margin-top:7px; font-weight:600; }
  .tally.done .tally-n { color:var(--done); } .tally.partial .tally-n { color:var(--partial); } .tally.idle .tally-n { color:var(--ink-3); } .tally.delta .tally-n { color:var(--accent); }
  .meter { display:flex; height:10px; border:1px solid var(--line); border-top:0; overflow:hidden; margin-bottom:34px; }
  .meter span { display:block; }
  .meter .s-done { background:var(--done); } .meter .s-partial { background:var(--partial); } .meter .s-idle { background:var(--idle-soft); }
  .sec-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; margin:0 0 14px; }
  h2 { font-family:var(--serif); font-size:21px; font-weight:600; letter-spacing:-.01em; margin:0; }
  .sec-note { font-size:13px; color:var(--ink-3); max-width:54ch; }
  .phases { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:34px; }
  .phase { background:var(--surface); border:1px solid var(--line); padding:15px 16px 14px; display:flex; flex-direction:column; gap:10px; }
  .phase-top { display:flex; align-items:baseline; gap:9px; }
  .phase-n { font-family:var(--mono); font-size:11px; font-weight:600; color:var(--surface); background:var(--ink); padding:2px 6px; letter-spacing:.04em; }
  .phase-name { font-weight:600; font-size:14px; }
  .phase-focus { font-size:12.5px; color:var(--ink-3); line-height:1.45; flex:1; }
  .phase-bar { height:5px; background:var(--idle-soft); display:flex; }
  .phase-bar i { display:block; background:var(--done); } .phase-bar i.p { background:var(--partial); }
  .phase-count { font-family:var(--mono); font-size:11.5px; color:var(--ink-2); font-variant-numeric:tabular-nums; }
  .callout { border:1px solid var(--line); border-left:3px solid var(--risk); background:var(--surface); padding:16px 18px; margin-bottom:34px; }
  .callout h3 { margin:0 0 8px; font-size:14px; font-weight:700; color:var(--risk); }
  .callout p { margin:0 0 10px; font-size:13.5px; color:var(--ink-2); max-width:74ch; line-height:1.55; }
  .callout p:last-child { margin-bottom:0; }
  .callout ul { margin:0 0 10px; padding-left:18px; font-size:13.5px; color:var(--ink-2); }
  .callout li { margin-bottom:5px; }
  .callout.delta-callout { border-left-color:var(--accent); }
  .callout.delta-callout h3 { color:var(--accent); }
  .callout code, .prose code, .story-note code, .provenance code { font-family:var(--mono); font-size:.89em; background:var(--surface-2); padding:1px 5px; border-radius:2px; }
  .controls { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); margin-bottom:26px; position:sticky; top:env(safe-area-inset-top,0px); background:var(--ground); z-index:5; }
  .ctl-label { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); margin-right:2px; }
  .chip { font:inherit; font-size:12.5px; font-weight:500; padding:6px 12px; border:1px solid var(--line-strong); background:var(--surface); color:var(--ink-2); cursor:pointer; border-radius:999px; }
  .chip:hover { border-color:var(--ink-3); color:var(--ink); }
  .chip[aria-pressed="true"] { background:var(--ink); border-color:var(--ink); color:var(--ground); }
  .spacer { flex:1 1 24px; }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .group-title { font-family:var(--mono); font-size:11.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3); margin:30px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .group-title:first-child { margin-top:0; }
  .epic { background:var(--surface); border:1px solid var(--line); margin-bottom:12px; }
  .epic-head { display:flex; align-items:center; gap:12px; padding:13px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .epic-id { font-family:var(--mono); font-size:12px; font-weight:600; color:var(--surface); background:var(--accent); padding:2px 7px; }
  .epic-title { font-weight:600; font-size:15px; flex:1 1 260px; }
  .tag-new { font-family:var(--mono); font-size:10px; font-weight:600; letter-spacing:.08em; color:var(--accent); border:1px solid var(--accent); padding:1px 5px; }
  .epic-ratio { font-family:var(--mono); font-size:12px; color:var(--ink-3); font-variant-numeric:tabular-nums; }
  .epic-bar { width:74px; height:5px; background:var(--idle-soft); display:flex; flex:0 0 auto; }
  .epic-bar i { display:block; background:var(--done); } .epic-bar i.p { background:var(--partial); }
  .story { display:grid; grid-template-columns:62px minmax(0,1fr) 110px 128px; gap:12px; align-items:start; padding:11px 16px; border-bottom:1px solid var(--line); }
  .story:last-child { border-bottom:0; }
  .story-id { font-family:var(--mono); font-size:12px; font-weight:500; color:var(--ink-3); padding-top:1px; }
  .story-name { font-size:14px; font-weight:500; }
  .story-note { font-size:12.5px; color:var(--ink-3); margin-top:3px; line-height:1.45; }
  .pill { display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:600; padding:3px 9px; border-radius:999px; white-space:nowrap; }
  .pill::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; flex:0 0 auto; }
  .pill.done { color:var(--done); background:var(--done-soft); }
  .pill.partial { color:var(--partial); background:var(--partial-soft); }
  .pill.idle { color:var(--idle); background:var(--idle-soft); }
  .phase-tag { font-family:var(--mono); font-size:11px; color:var(--ink-3); line-height:1.4; }
  .phase-tag b { display:block; color:var(--ink-2); font-weight:500; }
  .empty { padding:34px 16px; text-align:center; color:var(--ink-3); font-size:14px; border:1px dashed var(--line-strong); }
  .prose { margin-top:40px; padding-top:22px; border-top:1px solid var(--line); }
  .prose h2 { margin-bottom:10px; }
  .prose p { font-size:13.5px; color:var(--ink-2); max-width:74ch; line-height:1.6; margin:0 0 10px; }
  .legend { display:flex; flex-wrap:wrap; gap:8px 18px; margin:14px 0 0; font-size:12.5px; color:var(--ink-2); }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  @media (max-width:860px) { .tally-band,.phases { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:620px) {
    .story { grid-template-columns:minmax(0,1fr); gap:6px; }
    .story-id { padding-top:0; } .phase-tag b { display:inline; }
    .phases { grid-template-columns:minmax(0,1fr); }
  }
  @media (prefers-reduced-motion:reduce) { * { animation:none !important; transition:none !important; } }
</style>

<div class="wrap page">
  <header class="masthead">
    <p class="eyebrow">Unified SDLC &amp; ITSM Platform &middot; Pilot</p>
    <h1>Cadena Delivery Ledger</h1>
    <p class="standfirst">Every epic and user story in the backlog, its verified status in the repository, and where it sits in both the specification roadmap and the research playbook's five-phase rollout.</p>
    <div class="provenance">
      <span><b>Generated from</b> <code>backlog.json</code> + <code>implementation-status.json</code></span>
      <span><b>Verification</b> ${meta.tests}</span>
      <span><b>Built</b> ${meta.built}</span>
      <span><b>Refresh</b> <code>npm run tracker</code></span>
    </div>
  </header>

  <section>
    <div class="tally-band">
      <div class="tally"><div class="tally-n" id="t-total">0</div><div class="tally-l">Stories across <span id="t-epics">0</span> epics</div></div>
      <div class="tally done"><div class="tally-n" id="t-done">0</div><div class="tally-l">Done &amp; test-verified</div></div>
      <div class="tally partial"><div class="tally-n" id="t-partial">0</div><div class="tally-l">Partial, gap named</div></div>
      <div class="tally idle"><div class="tally-n" id="t-idle">0</div><div class="tally-l">Not started</div></div>
      <div class="tally delta"><div class="tally-n" id="t-delta">0</div><div class="tally-l">New in latest delta</div></div>
    </div>
    <div class="meter" id="meter" role="img" aria-label="Overall delivery progress"></div>
  </section>

  <section>
    <div class="sec-head">
      <h2>Specification roadmap</h2>
      <p class="sec-note">Phases from &sect;15 of the technical specification. Each is independently shippable.</p>
    </div>
    <div class="phases" id="phases"></div>
  </section>

  <section class="callout delta-callout">
    <h3>Latest scope delta &middot; ${model.latestDelta?.date ?? 'not recorded'}</h3>
    <p><code>${model.latestDelta?.source ?? 'No source recorded'}</code> moved the canonical scope from <b>${model.latestDelta?.baseline_epics ?? 0} epics / ${model.latestDelta?.baseline_stories ?? 0} stories</b> to <b>${model.latestDelta?.current_epics ?? model.epics.length} epics / ${model.latestDelta?.current_stories ?? 0} stories</b>. Existing identifiers and delivery status are never reassigned by a delta.</p>
    <ul>
      ${deltaLine('epic', model.latestDelta?.added_epics)}
      ${deltaLine('new story', model.latestDelta?.added_stories)}
      ${deltaLine('expanded story', model.latestDelta?.expanded_stories, 'expanded')}
    </ul>
    <p>Filter by <b>New in latest delta</b> below to see exactly what this delta contributed.</p>
  </section>

  <section class="callout">
    <h3>The research playbook's status table disagrees with the repository</h3>
    <p><em>Cadena Research.docx</em> &sect;7 records a backlog execution status that does not match what the code and tests show. The repository is authoritative here; the divergences are listed rather than silently reconciled.</p>
    <ul>
      <li><b>Epic 2 is understated.</b> The playbook marks US2.1&ndash;US2.3 <em>In Progress</em>. All three are implemented and covered by <code>us2.1</code>&ndash;<code>us2.3</code>.</li>
      <li><b>Epic 10 is overstated, and it matters.</b> The playbook marks US10.1&ndash;US10.2 (SSO and SCIM provisioning) <em>Completed</em>. Neither exists. The stories that <em>are</em> complete in that epic are US10.3 (role-gated transitions), US10.4 (full audit-trail export), US10.7 (SHA-256-verifiable audit evidence) and US10.9 (authenticated tenant and actor identity).</li>
      <li><b>Epic 4 is now complete.</b> The playbook described it as in progress; US4.1&ndash;US4.4 are implemented and acceptance-tested, including immutable lineage report export.</li>
    </ul>
    <p>Treating the playbook's table as a delivery signal would credit the platform with an enterprise identity posture it does not have.</p>
  </section>

  <section>
    <div class="sec-head">
      <h2>Epic ledger</h2>
      <p class="sec-note">Story titles are abridged; full statements and acceptance criteria live in <code>Backlog.md</code>.</p>
    </div>
    <div class="controls">
      <span class="ctl-label">Group</span>
      <button class="chip" type="button" data-group="epic" aria-pressed="true">Epic</button>
      <button class="chip" type="button" data-group="phase" aria-pressed="false">Spec phase</button>
      <button class="chip" type="button" data-group="rollout" aria-pressed="false">Rollout phase</button>
      <span class="spacer"></span>
      <span class="ctl-label">Status</span>
      <button class="chip" type="button" data-status="all" aria-pressed="true">All</button>
      <button class="chip" type="button" data-status="done" aria-pressed="false">Done</button>
      <button class="chip" type="button" data-status="partial" aria-pressed="false">Partial</button>
      <button class="chip" type="button" data-status="idle" aria-pressed="false">Not started</button>
      <button class="chip" type="button" data-status="delta" aria-pressed="false">Latest delta</button>
      <button class="chip" type="button" data-status="new" aria-pressed="false">All scope additions</button>
    </div>
    <div id="ledger"></div>
  </section>

  <section class="prose">
    <h2>How status was decided</h2>
    <p><b>Done</b> means implemented and covered by an automated acceptance test whose assertions match the story's criteria. <b>Partial</b> means the capability exists but a named part of the acceptance criteria is not met &mdash; most often a deliberate pilot boundary, such as notification transports that record rather than send. <b>Not started</b> means no implementation exists.</p>
    <p>This page is generated, not maintained by hand: <code>backlog.json</code> supplies the epics and stories, <code>implementation-status.json</code> supplies status and phase, and <code>test/tracker.spec.ts</code> fails if either file gains an entry the other does not have. A new requirement cannot quietly go untracked.</p>
    <div class="legend">
      <span><span class="pill done">Done</span> verified by test</span>
      <span><span class="pill partial">Partial</span> gap named in the row</span>
      <span><span class="pill idle">Not started</span> no implementation</span>
    </div>
  </section>
</div>

<script>
const MODEL = ${data};
const EPICS = MODEL.epics;
const ALL = EPICS.flatMap(e => e.stories.map(s => ({ ...s, epic: e })));
const LABEL = { done: "Done", partial: "Partial", idle: "Not started" };
const state = { group: "epic", status: "all" };

const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html !== undefined) n.innerHTML = html; return n; };
const count = (list, s) => list.filter(x => x.status === s).length;

function renderTallies() {
  document.getElementById("t-total").textContent = ALL.length;
  document.getElementById("t-epics").textContent = EPICS.length;
  document.getElementById("t-done").textContent = count(ALL, "done");
  document.getElementById("t-partial").textContent = count(ALL, "partial");
  document.getElementById("t-idle").textContent = count(ALL, "idle");
  document.getElementById("t-delta").textContent = MODEL.latestDelta?.added_stories.length ?? 0;
  const meter = document.getElementById("meter");
  meter.replaceChildren();
  [["done", count(ALL,"done")], ["partial", count(ALL,"partial")], ["idle", count(ALL,"idle")]].forEach(([k,n]) => {
    const seg = el("span", "s-" + k); seg.style.width = (n / ALL.length * 100) + "%"; meter.appendChild(seg);
  });
}

function renderPhases() {
  const host = document.getElementById("phases");
  host.replaceChildren();
  MODEL.specPhases.forEach(p => {
    const list = ALL.filter(s => s.phase === p.id);
    const d = count(list,"done"), pa = count(list,"partial");
    const card = el("div","phase"), top = el("div","phase-top");
    top.append(el("span","phase-n","P"+p.id), el("span","phase-name",p.name));
    const bar = el("div","phase-bar");
    const bd = el("i"); bd.style.width = (d/list.length*100)+"%";
    const bp = el("i","p"); bp.style.width = (pa/list.length*100)+"%";
    bar.append(bd,bp);
    card.append(top, el("p","phase-focus",p.focus), bar,
      el("div","phase-count", d+" done &middot; "+pa+" partial &middot; "+(list.length-d-pa)+" open"));
    host.appendChild(card);
  });
}

function storyRow(s) {
  const row = el("div","story"), mid = el("div");
  const deltaBadge = s.addedIn === MODEL.latestDelta?.id
    ? ' <span class="tag-new">NEW MASTER</span>'
    : s.expandedIn === MODEL.latestDelta?.id
      ? ' <span class="tag-new">EXPANDED</span>'
      : s.isNew ? ' <span class="tag-new">ADDED SCOPE</span>' : "";
  mid.append(el("div","story-name", s.name + deltaBadge),
             el("div","story-note", s.note));
  row.append(el("div","story-id", s.id), mid,
    el("div","", '<span class="pill '+s.status+'">'+LABEL[s.status]+'</span>'),
    el("div","phase-tag", "<b>Phase "+s.phase+"</b>"+s.epic.rollout));
  return row;
}

function epicBlock(epic, stories) {
  const block = el("div","epic"), head = el("div","epic-head");
  const d = count(stories,"done"), pa = count(stories,"partial");
  const bar = el("div","epic-bar");
  const bd = el("i"); bd.style.width = (d/stories.length*100)+"%";
  const bp = el("i","p"); bp.style.width = (pa/stories.length*100)+"%";
  bar.append(bd,bp);
  const epicBadge = epic.addedIn === MODEL.latestDelta?.id
    ? ' <span class="tag-new">NEW MASTER</span>'
    : epic.isNew ? ' <span class="tag-new">ADDED SCOPE</span>' : "";
  head.append(el("span","epic-id",epic.id),
    el("span","epic-title", epic.title + epicBadge),
    bar, el("span","epic-ratio", d+"/"+stories.length));
  block.appendChild(head);
  stories.forEach(s => block.appendChild(storyRow(s)));
  return block;
}

function render() {
  const host = document.getElementById("ledger");
  host.replaceChildren();
  const match = s => state.status === "all"
    ? true
    : state.status === "delta"
      ? s.addedIn === MODEL.latestDelta?.id || s.expandedIn === MODEL.latestDelta?.id
      : state.status === "new" ? Boolean(s.isNew) : s.status === state.status;

  if (state.group === "epic") {
    let shown = 0;
    EPICS.forEach(epic => {
      const stories = ALL.filter(s => s.epic.id === epic.id).filter(match);
      if (!stories.length) return;
      shown++; host.appendChild(epicBlock(epic, stories));
    });
    if (!shown) host.appendChild(el("div","empty","No stories match this filter."));
    return;
  }

  const keys = state.group === "phase" ? MODEL.specPhases.map(p => p.id) : MODEL.rollouts;
  let shown = 0;
  keys.forEach(key => {
    const inGroup = ALL.filter(s => (state.group === "phase" ? s.phase : s.epic.rollout) === key).filter(match);
    if (!inGroup.length) return;
    shown++;
    const label = state.group === "phase"
      ? "Phase " + key + " — " + MODEL.specPhases.find(p => p.id === key).name
      : "Rollout — " + key;
    host.appendChild(el("h3","group-title", label + " · " + inGroup.length + " stories"));
    const byEpic = new Map();
    inGroup.forEach(s => {
      if (!byEpic.has(s.epic.id)) byEpic.set(s.epic.id, { epic: s.epic, stories: [] });
      byEpic.get(s.epic.id).stories.push(s);
    });
    byEpic.forEach(v => host.appendChild(epicBlock(v.epic, v.stories)));
  });
  if (!shown) host.appendChild(el("div","empty","No stories match this filter."));
}

document.querySelectorAll("[data-group]").forEach(btn => btn.addEventListener("click", () => {
  state.group = btn.dataset.group;
  document.querySelectorAll("[data-group]").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
  render();
}));
document.querySelectorAll("[data-status]").forEach(btn => btn.addEventListener("click", () => {
  state.status = btn.dataset.status;
  document.querySelectorAll("[data-status]").forEach(b => b.setAttribute("aria-pressed", String(b === btn)));
  render();
}));

renderTallies(); renderPhases(); render();
</script>`;
}

const SHELL_HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
  :root { color-scheme: light dark; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
  body { margin: 0; font: 14px system-ui, sans-serif; background: #fafaf9; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
`;

function main() {
  const model = buildModel();
  if (model.problems.length) {
    console.error('Tracker inputs are out of sync:');
    model.problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }

  const total = model.epics.reduce((n, e) => n + e.stories.length, 0);
  const done = model.epics.reduce((n, e) => n + e.stories.filter((s) => s.status === 'done').length, 0);
  const partial = model.epics.reduce((n, e) => n + e.stories.filter((s) => s.status === 'partial').length, 0);

  // Counted from disk so the page cannot claim a suite size the repo does not have.
  const specFiles = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.spec.ts'));
  const body = page(model, {
    tests: `${specFiles.length} spec files, including a headless-browser smoke suite`,
    built: new Date().toISOString().slice(0, 10),
  });

  const out = join(ROOT, 'public', 'status.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, SHELL_HEAD + body + '\n</body>\n</html>\n', 'utf8');

  const flag = process.argv.indexOf('--fragment');
  if (flag !== -1 && process.argv[flag + 1]) {
    writeFileSync(resolve(process.argv[flag + 1]), body + '\n', 'utf8');
  }

  console.log(`tracker: ${model.epics.length} epics, ${total} stories ` +
    `(${done} done, ${partial} partial, ${total - done - partial} not started) -> public/status.html`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
