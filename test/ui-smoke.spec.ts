import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer-core';

/**
 * Browser smoke test for the pilot workspace.
 *
 * This drives the **built production server** (`dist/server.js`) rather than a Nest testing
 * module, for two reasons: it is the artifact people actually run, and `ServeStaticModule`
 * does not serve the `public/` directory under vitest's transform, so an in-process app
 * would be testing a page that never loads.
 *
 * It uses `puppeteer-core` against a browser already installed on the machine, so no
 * Chromium download is needed. The suite skips, rather than fails, when no browser or no
 * build is present: both are environment gaps, not product defects.
 *
 * Run it with `npm run test:ui`, which builds first.
 */
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const executablePath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
const serverEntry = join(__dirname, '..', 'dist', 'server.js');
const canRun = Boolean(executablePath) && existsSync(serverEntry);

const PORT = 3477;
const BASE = `http://127.0.0.1:${PORT}`;
const ORG = '00000000-0000-0000-0000-000000000099';
const TEAM = '00000000-0000-0000-0000-000000000001';
const OWNER = '00000000-0000-0000-0000-00000000a001'; // Ada Owner, seeded with a Slack preference

describe.skipIf(!canRun)('UI smoke — pilot workspace renders and responds', () => {
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const consoleErrors: string[] = [];

  const api = async (path: string, body?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-org-id': ORG, 'Content-Type': 'application/json', ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json() as Promise<any>;
  };

  async function waitForServer(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${BASE}/workitems`, { headers: { 'x-org-id': ORG } });
        if (response.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Server did not become ready on ${BASE}`);
  }

  async function waitForMonitoringDelivery(deliveryId: string, provider: string, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const delivery = await api(
        `/integrations/monitoring/deliveries/${encodeURIComponent(deliveryId)}?provider=${provider}`,
      );
      if (delivery.status === 'completed') return delivery.result;
      if (delivery.status === 'failed') throw new Error(`Monitoring delivery failed: ${delivery.error}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Monitoring delivery '${deliveryId}' did not complete before timeout`);
  }

  /** Layers an alert-driven Incident, an impact chain and a fallback notification onto the seed. */
  async function seedScenario() {
    await api('/integrations/monitoring/settings', {
      min_severity: 'SEV4', dedupe_window_minutes: 60, default_team_id: TEAM,
    });

    await api(
      '/integrations/monitoring/webhooks',
      {
        provider: 'datadog',
        event_type: 'alert_fired',
        alert: {
          id: 'ui-smoke-evt', dedupe_key: 'ui-smoke-latency',
          title: 'Checkout API p99 latency above 2s', severity: 'critical',
          service: 'checkout-api', url: 'https://app.datadoghq.example/monitors/1',
        },
      },
      { 'x-delivery-id': 'ui-smoke-alert' },
    );
    const alert = await waitForMonitoringDelivery('ui-smoke-alert', 'datadog');

    const release = await api('/workitems', {
      type: 'release', title: 'Release 4.2.0', team_id: TEAM, org_id: ORG,
    });
    await api(`/workitems/${alert.incident.id}/links`, {
      target_id: release.id, link_type: 'caused_by',
    });

    // Ada prefers Slack; taking Slack down forces the US8.3 email fallback into the log.
    // The escalation threshold is lowered so a 1-minute SLA escalates within the seed wait
    // rather than requiring 90+ seconds of wall clock.
    await api('/notifications/settings', {
      unavailable_channels: ['slack'], escalation_threshold_percent: 110,
    });
    await api('/sla-policies', {
      item_type: 'story', state: 'In Review', threshold_minutes: 1, calendar: '24x7',
    });

    const story = await api('/workitems', {
      type: 'story', title: 'Story awaiting review', team_id: TEAM, org_id: ORG, owner_id: OWNER,
    });
    for (const toState of ['Planned', 'In Progress', 'In Review']) {
      await api(`/workitems/${story.id}/transitions`, { to_state: toState });
    }

    // SlaCalculatorService floors elapsed time to whole minutes, so a 1-minute threshold
    // reads exactly 100% at 60-119 seconds. Crossing into the second minute gives 200%,
    // which is past both the breach and the lowered escalation threshold.
    await new Promise((resolve) => setTimeout(resolve, 130000));
    await api('/aging/recompute', {});

    // A fresh item in the same column remains green, giving the browser suite a real
    // worst-first ordering assertion rather than merely checking that cards have colours.
    const freshStory = await api('/workitems', {
      type: 'story', title: 'Fresh story entering review', team_id: TEAM, org_id: ORG,
    });
    for (const toState of ['Planned', 'In Progress', 'In Review']) {
      await api(`/workitems/${freshStory.id}/transitions`, { to_state: toState });
    }

  }

  beforeAll(async () => {
    server = spawn(process.execPath, [serverEntry], {
      // Forced ephemeral: this suite seeds its own scenario and must start from the seed
      // every run, even if the surrounding shell exports a data directory.
      env: { ...process.env, PORT: String(PORT), CADENA_DATA_DIR: '', CADENA_CONNECTOR_LIVE_HTTP: '', UI_SMOKE_JIRA_TOKEN: 'ui-smoke-token' },
      stdio: 'ignore',
    });
    await waitForServer();
    await seedScenario();

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.work-card', { timeout: 20000 });
  }, 180000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  const textOf = (selector: string) => page.$eval(selector, (node) => (node as HTMLElement).innerText);

  /**
   * `innerText` returns *rendered* text, and several labels here are styled
   * `text-transform: uppercase`, so assertions compare case-insensitively.
   */
  const lowerTextOf = async (selector: string) => (await textOf(selector)).toLowerCase();

  /** Dialogs are modal, so a dialog left open by a failing test would block every later click. */
  async function closeAnyDialog() {
    await page.evaluate(() => {
      document.querySelectorAll('dialog[open]').forEach((dialog) => (dialog as HTMLDialogElement).close());
    });
  }

  async function openCardByKey(key: string) {
    const clicked = await page.evaluate((targetKey) => {
      const card = Array.from(document.querySelectorAll('.work-card')).find(
        (node) => node.querySelector('.item-key')?.textContent?.trim() === targetKey,
      );
      const button = card?.querySelector('.card-open') as HTMLButtonElement | undefined;
      if (!button) return false;
      button.click();
      return true;
    }, key);
    if (!clicked) throw new Error(`No work card rendered for ${key}`);
  }

  it('renders the board with work cards, columns and KPI totals', async () => {
    expect((await page.$$('.work-card')).length).toBeGreaterThan(0);
    expect(Number(await textOf('#kpiTotal'))).toBeGreaterThan(0);

    const columns = await page.$$eval(
      '.column-title',
      (nodes) => nodes.map((n) => (n as HTMLElement).innerText.trim().toLowerCase()),
    );
    expect(columns).toContain('triaged');
    expect(await textOf('#resultSummary')).toMatch(/work item/);
  });

  it('orders every board column by SLA severity and score, worst first', async () => {
    const ordering = await page.$$eval('.column-items', (columns) => columns.map((column) => {
      const cards = Array.from(column.querySelectorAll<HTMLElement>('.work-card'));
      const values = cards.map((card) => ({
        bucket: card.dataset.agingBucket || 'none',
        score: Number(card.dataset.agingScore || 0),
      }));
      const rank: Record<string, number> = { red: 3, amber: 2, green: 1, none: 0 };
      const valid = values.every((value, index) => index === 0
        || rank[values[index - 1].bucket] > rank[value.bucket]
        || (rank[values[index - 1].bucket] === rank[value.bucket]
          && values[index - 1].score >= value.score));
      return { count: values.length, valid, buckets: values.map((value) => value.bucket) };
    }));

    expect(ordering.some((column) => column.count > 1)).toBe(true);
    expect(ordering.every((column) => column.valid)).toBe(true);
    expect(ordering.some((column) => column.buckets[0] === 'red' && column.buckets.includes('green'))).toBe(true);
  });

  it('shows monitoring evidence and the affected service in the Incident drawer', async () => {
    await closeAnyDialog();
    const incidents = await api('/workitems?type=incident');
    const target = incidents.find((item: any) => item.custom_fields?.alert_dedupe_key === 'ui-smoke-latency');
    expect(target, 'alert-created incident should exist').toBeTruthy();

    await page.select('#typeFilter', 'incident');
    await page.waitForFunction(() => document.querySelectorAll('.work-card').length > 0, { timeout: 10000 });
    await openCardByKey(target.key);

    await page.waitForSelector('#itemDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#detailBody')?.textContent?.includes('SVC-CHECKOUT-API') ?? false,
      { timeout: 15000 },
    );

    const detail = await lowerTextOf('#detailBody');
    expect(detail).toContain('monitoring evidence');
    expect(detail).toContain('svc-checkout-api');
    expect(detail).toContain('sev1');
    expect(detail).toContain('datadog');
    expect(detail).toContain('delivery evidence');

    await closeAnyDialog();
    await page.select('#typeFilter', '');
  });

  it('shows and exports the immutable audit history from item details', async () => {
    await closeAnyDialog();
    const stories = await api('/workitems?type=story');
    const target = stories.find((item: any) => item.title === 'Story awaiting review');
    expect(target).toBeTruthy();

    await page.select('#typeFilter', 'story');
    await page.waitForFunction(() => document.querySelectorAll('.work-card').length > 0, { timeout: 10000 });
    await openCardByKey(target.key);
    await page.waitForSelector('#itemDialog[open] .audit-timeline', { timeout: 10000 });

    const history = await lowerTextOf('#detailBody');
    expect(history).toContain('audit history');
    expect(history).toContain('work item created');
    expect(history).toContain('work item state changed');
    expect(history).toContain('proposed → planned');
    expect(history).toContain('sha-256 chain verified');

    await page.evaluate(() => {
      const originalClick = HTMLAnchorElement.prototype.click;
      (window as any).__restoreAuditDownloadClick = () => {
        HTMLAnchorElement.prototype.click = originalClick;
      };
      HTMLAnchorElement.prototype.click = function captureDownload() {
        if (this.download) {
          (window as any).__capturedAuditDownloadName = this.download;
          return;
        }
        originalClick.call(this);
      };
    });
    const responsePromise = page.waitForResponse(
      (response) => response.request().method() === 'GET'
        && response.url().includes(`/audit/export?work_item_id=${target.id}`),
    );
    await page.click('#itemDialog .audit-head button');
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const report = await response.json() as any;
    expect(report.schema).toBe('cadena.audit-trail.v1');
    expect(report.event_count).toBeGreaterThanOrEqual(4);
    expect(report.events.every((event: any) => event.actor?.id && event.timestamp)).toBe(true);
    await page.waitForFunction(
      () => document.querySelector('#toastRegion')?.textContent?.includes('audit event') ?? false,
    );
    const downloadName = await page.evaluate(() => {
      const name = (window as any).__capturedAuditDownloadName;
      (window as any).__restoreAuditDownloadClick?.();
      return name;
    });
    expect(downloadName).toBe(`${target.key}-audit-trail.json`);

    await closeAnyDialog();
    await page.select('#typeFilter', '');
  });

  it('renders Service impact with the edge chain that implicates each item', async () => {
    await closeAnyDialog();
    await page.click('#openServicesFromNav');
    await page.waitForSelector('#impactDialog[open]', { timeout: 10000 });

    await page.waitForFunction(() => {
      const select = document.querySelector('#impactService') as HTMLSelectElement | null;
      return (select?.options.length ?? 0) > 0;
    }, { timeout: 10000 });

    const checkoutValue = await page.$$eval('#impactService option', (options) => {
      const match = (options as HTMLOptionElement[]).find((o) => o.textContent?.includes('SVC-CHECKOUT-API'));
      return match?.value ?? '';
    });
    expect(checkoutValue).toBeTruthy();
    await page.select('#impactService', checkoutValue);

    await page.waitForFunction(
      () => document.querySelector('#impactContent')?.textContent?.includes('REL-') ?? false,
      { timeout: 15000 },
    );

    const impact = await textOf('#impactContent');
    expect(impact).toContain('implicated');
    expect(impact).toContain('INC-');
    expect(impact).toContain('REL-');
    expect(impact).toContain('caused by');
    expect(impact).toContain('SVC-CHECKOUT-API');

    // Narrowing depth drops the release and leaves only what directly touches the service.
    await page.select('#impactDepth', '1');
    await page.waitForFunction(() => {
      const text = document.querySelector('#impactContent')?.textContent ?? '';
      return text.includes('INC-') && !text.includes('REL-');
    }, { timeout: 10000 });
    expect(await textOf('#impactContent')).toContain('INC-');

    await closeAnyDialog();
  });

  it('renders an interactive upstream and downstream graph that expands by depth', async () => {
    await closeAnyDialog();
    const stories = await api('/workitems?type=story');
    const target = stories.find((item: any) => item.title === 'Story: State Machine Transition Engine');
    expect(target).toBeTruthy();

    await page.select('#typeFilter', 'story');
    await page.waitForFunction(() => document.querySelectorAll('.work-card').length > 0, { timeout: 10000 });
    await openCardByKey(target.key);
    await page.waitForSelector('#itemDialog[open]', { timeout: 10000 });
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#detailBody button'))
        .find((candidate) => candidate.textContent?.trim() === 'Trace lineage');
      button?.click();
    });
    await page.waitForSelector('#lineageDialog[open] #lineageGraph', { timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#lineageGraph .trace-node').length === 4,
      { timeout: 10000 },
    );

    expect((await page.$$('#lineageGraph .trace-node')).length).toBe(4);
    expect((await page.$$('#lineageGraph .trace-edge')).length).toBe(3);
    const graphText = await lowerTextOf('#lineageContent');
    expect(graphText).toContain('upstream');
    expect(graphText).toContain('downstream');
    expect(graphText).toContain('fixed by');
    expect(await textOf('#lineageSummary')).toContain('4 nodes');

    await page.select('#lineageDepth', '1');
    await page.waitForFunction(
      () => document.querySelectorAll('#lineageGraph .trace-node').length === 3,
      { timeout: 10000 },
    );
    expect(await textOf('#lineageSummary')).toContain('1 hop');

    await page.click('#expandLineageButton');
    await page.waitForFunction(
      () => (document.querySelector('#lineageDepth') as HTMLSelectElement)?.value === '2'
        && document.querySelectorAll('#lineageGraph .trace-node').length === 4,
      { timeout: 10000 },
    );

    await page.click('#lineageGraph .trace-node:not(.root)');
    const inspector = await textOf('#lineageInspector');
    expect(inspector).toContain('Explore from this node');
    expect(inspector).toMatch(/Upstream|Downstream/);

    const selectedKey = await textOf('#lineageGraph .trace-node.selected .trace-node-key');
    await page.click('#lineageInspector .button');
    await page.waitForFunction(
      (key) => document.querySelector('#lineageDialogTitle')?.textContent?.includes(String(key)),
      { timeout: 10000 },
      selectedKey,
    );
    expect(await textOf('#lineageDialogTitle')).toContain(selectedKey);

    await closeAnyDialog();
    await page.select('#typeFilter', '');
    await page.select('#lineageDepth', '3');
  });

  it('exports a full lineage snapshot from the Traceability dialog', async () => {
    await closeAnyDialog();
    const incidents = await api('/workitems?type=incident');
    const target = incidents.find((item: any) => item.custom_fields?.alert_dedupe_key === 'ui-smoke-latency');
    expect(target).toBeTruthy();

    await page.select('#typeFilter', 'incident');
    await page.waitForFunction(() => document.querySelectorAll('.work-card').length > 0, { timeout: 10000 });
    await openCardByKey(target.key);
    await page.waitForSelector('#itemDialog[open]', { timeout: 10000 });
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('#detailBody button'))
        .find((candidate) => candidate.textContent?.trim() === 'Trace lineage');
      button?.click();
    });
    await page.waitForSelector('#lineageDialog[open]', { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('#lineageContent .skeleton'), { timeout: 10000 });

    // Capture the client-side download without writing a browser download into the test host.
    await page.evaluate(() => {
      const originalClick = HTMLAnchorElement.prototype.click;
      (window as any).__restoreDownloadClick = () => {
        HTMLAnchorElement.prototype.click = originalClick;
      };
      HTMLAnchorElement.prototype.click = function captureDownload() {
        if (this.download) {
          (window as any).__capturedDownloadName = this.download;
          return;
        }
        originalClick.call(this);
      };
    });

    const responsePromise = page.waitForResponse(
      (response) => response.request().method() === 'POST'
        && response.url().endsWith(`/workitems/${target.id}/lineage-exports`),
    );
    await page.click('#exportLineageButton');
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const report = await response.json() as any;
    expect(report.schema).toBe('cadena.lineage-report.v1');
    expect(report.summary.node_count).toBeGreaterThanOrEqual(2);
    expect(report.summary.edge_count).toBeGreaterThanOrEqual(1);
    await page.waitForFunction(() => document.querySelector('#toastRegion')?.textContent?.includes('Exported'));

    const downloadName = await page.evaluate(() => {
      const name = (window as any).__capturedDownloadName;
      (window as any).__restoreDownloadClick?.();
      return name;
    });
    expect(downloadName).toContain(`${target.key}-lineage-`);

    await closeAnyDialog();
    await page.select('#typeFilter', '');
  });

  it('shows the notification delivery log including the Slack to email fallback', async () => {
    await closeAnyDialog();
    await page.click('#openNotificationsFromNav');
    await page.waitForSelector('#notificationsDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#notificationsContent')?.textContent?.includes('SLA') ?? false,
      { timeout: 15000 },
    );

    const log = await textOf('#notificationsContent');
    expect(log).toContain('[SLA');
    expect(log).toContain('slack → email (fallback)');
    expect(log).toContain('fallback sent');
    expect(log).toContain('owner');

    await closeAnyDialog();
  });

  it('offers only workflow-permitted next states in the transition dialog', async () => {
    await closeAnyDialog();
    await page.select('#typeFilter', 'incident');
    await page.waitForFunction(() => document.querySelectorAll('.work-card').length > 0, { timeout: 10000 });

    const [moveButton] = await page.$$('.work-card .card-action');
    await moveButton.click();
    await page.waitForSelector('#transitionDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => ((document.querySelector('#transitionTarget') as HTMLSelectElement)?.options.length ?? 0) > 0,
      { timeout: 10000 },
    );

    const options = await page.$$eval(
      '#transitionTarget option',
      (nodes) => (nodes as HTMLOptionElement[]).map((n) => n.value),
    );
    // The seeded Incident workflow permits Triaged -> Investigating and nothing else.
    expect(options).toEqual(['Investigating']);
    expect(await textOf('#transitionCurrentState')).toBe('Triaged');

    await closeAnyDialog();
    await page.select('#typeFilter', '');
  });

  it('surfaces escalated work through the SLA health filter', async () => {
    await closeAnyDialog();
    await page.select('#agingFilter', 'escalated');
    await page.waitForFunction(
      () => (document.querySelector('#resultSummary')?.textContent ?? '').length > 0,
      { timeout: 10000 },
    );

    const body = await textOf('#workspaceBody');
    // The seeded story blew past 150% of a one-minute SLA, so it carries the Escalated badge.
    expect(body).toContain('Escalated');

    await page.select('#agingFilter', '');
  });

  it('renders the flow metrics view with DORA and ITIL figures', async () => {
    await closeAnyDialog();
    await page.click('#openMetricsFromNav');
    await page.waitForSelector('#metricsDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#metricsContent')?.textContent?.includes('DORA') ?? false,
      { timeout: 15000 },
    );

    const metrics = await lowerTextOf('#metricsContent');
    expect(metrics).toContain('deployment frequency');
    expect(metrics).toContain('change failure rate');
    expect(metrics).toContain('time to restore service');
    expect(metrics).toContain('itil');
    expect(metrics).toContain('incidents opened');
    // The coverage note must be shown, so a figure over partial evidence says so.
    expect(metrics).toContain('lead time covers only deployments');

    await page.select('#metricsWindow', '7');
    await page.waitForFunction(
      () => document.querySelector('#metricsContent')?.textContent?.includes('DORA') ?? false,
      { timeout: 15000 },
    );
    await closeAnyDialog();
  });

  it('renders the executive rollup by business unit and team', async () => {
    await closeAnyDialog();
    await page.click('#openExecutiveFromNav');
    await page.waitForSelector('#executiveDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelector('#executiveContent')?.textContent?.includes('Business units') ?? false,
      { timeout: 15000 },
    );

    const executive = await lowerTextOf('#executiveContent');
    expect(executive).toContain('portfolio');
    expect(executive).toContain('sla compliance');
    expect(executive).toContain('average cycle time');
    expect(executive).toContain('business units');
    expect(executive).toContain('engineering');
    expect(executive).toContain('platform team');
    expect(executive).toContain('aging distribution');
    expect(executive).toContain('recorded transition');
    await closeAnyDialog();
  });

  it('renders the dead letters view with its depth summary', async () => {
    await closeAnyDialog();
    await page.click('#openDlqFromNav');
    await page.waitForSelector('#dlqDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => (document.querySelector('#dlqContent')?.textContent?.length ?? 0) > 0
        && !document.querySelector('#dlqContent .skeleton'),
      { timeout: 15000 },
    );

    const dlq = await lowerTextOf('#dlqContent');
    expect(dlq).toContain('awaiting attention');

    // Switching status re-queries rather than leaving a stale list on screen.
    await page.select('#dlqStatus', 'replayed');
    await page.waitForFunction(
      () => !document.querySelector('#dlqContent .skeleton'),
      { timeout: 15000 },
    );
    expect((await textOf('#dlqContent')).length).toBeGreaterThan(0);
    await closeAnyDialog();
  });

  it('creates and publishes a lifecycle state mapping', async () => {
    await closeAnyDialog();
    await page.click('#openStateMappingsFromNav');
    await page.waitForSelector('#stateMappingDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => !document.querySelector('#stateMappingList .skeleton'),
      { timeout: 10000 },
    );

    await page.type('#mappingName', 'UI incident lifecycle');
    await page.type('.mapping-from', 'New');
    await page.type('.mapping-to', 'To Do');
    await page.type('.mapping-required', 'priority');
    await page.click('#saveMappingButton');

    await page.waitForFunction(
      () => (document.querySelector('#stateMappingList')?.textContent ?? '').includes('UI incident lifecycle')
        && (document.querySelector('#stateMappingList')?.textContent ?? '').includes('draft'),
      { timeout: 10000 },
    );
    expect(await textOf('#stateMappingList')).toContain('New → To Do');

    const publishClicked = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#stateMappingList .mapping-card')).find(
        (node) => node.textContent?.includes('UI incident lifecycle'),
      );
      const button = card?.querySelector('button') as HTMLButtonElement | undefined;
      if (!button) return false;
      button.click();
      return true;
    });
    expect(publishClicked).toBe(true);

    await page.waitForFunction(
      () => (document.querySelector('#stateMappingList')?.textContent ?? '').includes('UI incident lifecycle')
        && (document.querySelector('#stateMappingList')?.textContent ?? '').includes('published'),
      { timeout: 10000 },
    );
    await closeAnyDialog();
  });

  it('creates and publishes a visual field mapping with a value-table transform', async () => {
    await closeAnyDialog();
    await page.click('#openFieldMappingsFromNav');
    await page.waitForSelector('#fieldMappingDialog[open]', { timeout: 10000 });
    await page.waitForFunction(
      () => !document.querySelector('#fieldMappingList .skeleton'),
      { timeout: 10000 },
    );

    await page.type('#fieldMappingName', 'UI priority translation');
    await page.type('.fm-source', 'priority');
    await page.type('.fm-target', 'priority');
    await page.select('.fm-type', 'value_table');
    await page.waitForSelector('.fm-kv-row', { timeout: 5000 });
    await page.type('.fm-kv-key', 'High');
    await page.type('.fm-kv-value', '1 - Critical');
    await page.click('#saveFieldMappingButton');

    await page.waitForFunction(
      () => (document.querySelector('#fieldMappingList')?.textContent ?? '').includes('UI priority translation')
        && (document.querySelector('#fieldMappingList')?.textContent ?? '').includes('draft'),
      { timeout: 10000 },
    );
    expect(await textOf('#fieldMappingList')).toContain('priority → priority (value_table)');

    const publishClicked = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#fieldMappingList .mapping-card')).find(
        (node) => node.textContent?.includes('UI priority translation'),
      );
      const button = card?.querySelector('button') as HTMLButtonElement | undefined;
      if (!button) return false;
      button.click();
      return true;
    });
    expect(publishClicked).toBe(true);

    await page.waitForFunction(
      () => (document.querySelector('#fieldMappingList')?.textContent ?? '').includes('UI priority translation')
        && (document.querySelector('#fieldMappingList')?.textContent ?? '').includes('published'),
      { timeout: 10000 },
    );
    await closeAnyDialog();
  });

  it('connects a source system and reports that live provider access is not yet authorised', async () => {
    await closeAnyDialog();
    await page.click('#openConnectorsFromNav');
    await page.waitForSelector('#connectorsDialog[open]', { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('#connectorList .skeleton'), { timeout: 10000 });
    const providers = await page.$$eval('#connectorProvider option', (options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(providers.sort()).toEqual(['jira', 'servicenow']);
    expect(await textOf('#connectorList')).toContain('No source systems are connected');

    await page.type('#connectorName', 'UI Jira Cloud');
    await page.type('#connectorBaseUrl', 'https://acme.atlassian.net');
    await page.type('#connectorAccount', 'sync@acme.test');
    await page.type('#connectorSecretRef', 'env:UI_SMOKE_JIRA_TOKEN');
    await page.type('#connectorScopes', 'CAD');
    await page.click('#saveConnectorButton');
    await page.waitForFunction(
      () => (document.querySelector('#connectorList')?.textContent ?? '').includes('UI Jira Cloud'),
      { timeout: 10000 },
    );
    expect(await textOf('#connectorList')).toContain('unconfigured');

    const tested = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#connectorList .mapping-card')).find((node) => node.textContent?.includes('UI Jira Cloud'));
      const button = Array.from(card?.querySelectorAll('button') ?? []).find((node) => node.textContent === 'Test') as HTMLButtonElement | undefined;
      button?.click();
      return Boolean(button);
    });
    expect(tested).toBe(true);
    await page.waitForFunction(
      () => (document.querySelector('#connectorList')?.textContent ?? '').includes('Live connector HTTP is disabled'),
      { timeout: 10000 },
    );
    expect(await textOf('#connectorList')).toContain('error');
    await closeAnyDialog();
  });

  it('keeps local creation under Pilot actions and shows sources above the pilot board', async () => {
    await closeAnyDialog();
    expect(await page.$eval('#createButton', (node) => (node as HTMLElement).hidden)).toBe(true);
    expect(await page.$eval('#sourceWorkspace', (node) => (node as HTMLElement).hidden)).toBe(false);
    expect(await page.$eval('#workspaceSection', (node) => (node as HTMLElement).hidden)).toBe(false);
    await page.click('#pilotActionsButton');
    await page.waitForSelector('#pilotDialog[open]', { timeout: 10000 });
    await page.click('#pilotCreateButton');
    await page.waitForSelector('#createDialog[open]', { timeout: 10000 });
    await closeAnyDialog();
  });

  it('renders without console errors and does not overflow at phone width', async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('.work-card', { timeout: 20000 });

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);

    const menuVisible = await page.$eval(
      '#mobileMenuButton',
      (node) => window.getComputedStyle(node).display !== 'none',
    );
    expect(menuVisible).toBe(true);

    // The field-mapping studio's transform editor is the newest, most nested form on the page;
    // it must reflow to a single column at phone width rather than clip or force page-wide scroll.
    await page.click('#mobileMenuButton');
    await page.waitForSelector('#sidebar.open', { timeout: 5000 });
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#openFieldMappingsFromNav')?.click());
    await page.waitForSelector('#fieldMappingDialog[open]', { timeout: 10000 });
    await page.select('.fm-type', 'conditional');
    await page.waitForSelector('.fm-cond-row', { timeout: 5000 });
    const dialogOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(dialogOverflows).toBe(false);
    await closeAnyDialog();

    expect(consoleErrors).toEqual([]);
  });
});

/**
 * Connector-led mode (US20.2), driven against the local provider sandbox so the real Jira and
 * ServiceNow adapters run end to end without contacting any provider.
 */
describe.skipIf(!canRun)('UI smoke — connector-led workspace', () => {
  const LED_PORT = 3478;
  const LED_BASE = `http://127.0.0.1:${LED_PORT}`;
  const LED_ORG = '00000000-0000-0000-0000-000000000099';
  const JIRA_URL = 'https://jira.sandbox.cadena.local';
  const SNOW_URL = 'https://servicenow.sandbox.cadena.local';
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  const consoleErrors: string[] = [];

  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${LED_BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-org-id': LED_ORG, 'x-actor-id': 'ui.operator', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };

  const onboard = async (config: Record<string, unknown>) => {
    const created = await call('/integrations/connectors', config);
    expect(created.status).toBe(201);
    for (const step of ['test', 'discover', 'activate', 'sync']) {
      const result = await call(`/integrations/connectors/${created.body.id}/${step}`, {});
      expect(result.status).toBe(201);
    }
    return created.body.id as string;
  };

  const jiraConfig = (name: string) => ({
    name,
    provider: 'jira',
    baseUrl: JIRA_URL,
    credentials: { apiToken: 'env:UI_SANDBOX_TOKEN' },
    options: { accountEmail: 'sync@acme.test' },
    projectKeys: ['CAD'],
    writeBack: { state: true },
  });

  const textOf = (selector: string) => page.$eval(selector, (node) => (node as HTMLElement).innerText);
  const isHidden = (selector: string) => page.$eval(selector, (node) => (node as HTMLElement).hidden || getComputedStyle(node).display === 'none');
  const reload = async () => {
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#sourceKpiSources')?.textContent !== '—', { timeout: 15000 });
  };
  const openTwinRow = async (key: string) => {
    const clicked = await page.evaluate((target) => {
      const row = Array.from(document.querySelectorAll('#twinRows tr')).find((node) => node.querySelector('a')?.textContent === target) as HTMLElement | undefined;
      row?.click();
      return Boolean(row);
    }, key);
    expect(clicked).toBe(true);
    await page.waitForSelector('#twinDialog[open] .twin-field', { timeout: 10000 });
  };

  beforeAll(async () => {
    server = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        PORT: String(LED_PORT),
        CADENA_DATA_DIR: '',
        CADENA_INTERACTION_MODE: 'connector-led',
        CADENA_CONNECTOR_SANDBOX: 'enabled',
        CADENA_CONNECTOR_LIVE_HTTP: '',
        UI_SANDBOX_TOKEN: 'sandbox-token',
      },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${LED_BASE}/health/ready`)).ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.goto(LED_BASE, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#sourceKpiSources')?.textContent !== '—', { timeout: 20000 });
  }, 180000);

  afterAll(async () => {
    await browser?.close();
    server?.kill();
  });

  it('opens on connector onboarding with no local creation path', async () => {
    expect(await textOf('#pageTitle')).toBe('Synchronization health');
    expect(await isHidden('#sourceOnboarding')).toBe(false);
    expect(await isHidden('#workspaceSection')).toBe(true);
    expect(await isHidden('#workKpis')).toBe(true);
    expect(await isHidden('#createButton')).toBe(true);
    expect(await isHidden('#pilotActionsButton')).toBe(true);
    expect(await page.$$eval('[data-local-work]', (nodes) => nodes.every((node) => (node as HTMLElement).hidden))).toBe(true);
    expect(await textOf('#connectSourceButton')).toContain('Connect source');
    const refused = await call('/workitems', { type: 'story', title: 'Duplicate backlog', team_id: '00000000-0000-0000-0000-000000000001' });
    expect(refused.status).toBe(403);

    await page.click('#onboardingConnectButton');
    await page.waitForSelector('#connectorsDialog[open]', { timeout: 10000 });
    await page.evaluate(() => (document.querySelector('#connectorsDialog') as HTMLDialogElement).close());
  });

  it('shows healthy sources, twins, native links and counterparts', async () => {
    const jiraId = await onboard(jiraConfig('Sandbox Jira'));
    const snowId = await onboard({
      name: 'Sandbox ServiceNow',
      provider: 'servicenow',
      baseUrl: SNOW_URL,
      credentials: { password: 'env:UI_SANDBOX_TOKEN' },
      options: { username: 'svc.cadena' },
      tableNames: ['incident'],
    });
    expect((await call('/integrations/correlations', {
      source: { system: 'servicenow', entity_type: 'incident', immutable_id: 'sys10000' },
      target: { system: 'jira', entity_type: 'issue', immutable_id: '20000' },
    })).status).toBe(201);
    const draft = await call('/integrations/state-mappings', {
      name: 'Sandbox lifecycle',
      source: { system: 'servicenow', entity_type: 'incident' },
      target: { system: 'jira', entity_type: 'issue' },
      rules: [{ direction: 'target_to_source', from_state: 'Done', to_state: 'Resolved' }],
    });
    expect((await call(`/integrations/state-mappings/${draft.body.id}/publish`, {})).status).toBe(201);
    // The seeded tenant has several teams, so projection needs an explicit owning team.
    for (const id of [jiraId, snowId]) {
      const configured = await call(`/integrations/connectors/${id}/projection`, { teamId: '00000000-0000-0000-0000-000000000001' });
      expect(configured.status).toBe(201);
    }

    await reload();
    expect(await isHidden('#sourceOnboarding')).toBe(true);
    expect(await textOf('#sourceKpiSources')).toBe('2');
    expect(await textOf('#sourceKpiTwins')).toBe('5');
    expect((await textOf('#sourceKpiSourcesContext')).toLowerCase()).toContain('2 healthy');
    expect(await page.$$eval('#sourceHealthList .source-card', (cards) => cards.length)).toBe(2);
    expect(await textOf('#sourceHealthList')).toContain('Sandbox ServiceNow');
    expect(await page.$$eval('#twinRows tr', (rows) => rows.length)).toBe(5);

    const row = await page.evaluate(() => {
      const tr = Array.from(document.querySelectorAll('#twinRows tr')).find((node) => node.querySelector('a')?.textContent === 'CAD-101');
      const link = tr?.querySelector('a') as HTMLAnchorElement | undefined;
      return { href: link?.href, target: link?.target, text: (tr as HTMLElement | undefined)?.innerText };
    });
    expect(row.href).toBe('https://jira.sandbox.cadena.local/browse/CAD-101');
    expect(row.target).toBe('_blank');
    expect(row.text).toContain('ServiceNow INC0010000');
    expect(row.text).toContain('Sandbox Jira');
    expect(row.text).toContain('On track');
  });

  it('inspects a twin, explains ownership, and routes a permitted state change', async () => {
    await openTwinRow('INC0010000');
    const snowState = await page.$eval('#twinBody .twin-field[data-field="state"]', (node) => (node as HTMLElement).innerText);
    expect(snowState).toContain('Owned by ServiceNow');
    expect(snowState).toContain('write-back is disabled');
    expect(await page.$('#twinBody .twin-field[data-field="state"] select')).toBeNull();
    await page.evaluate(() => (document.querySelector('#twinDialog') as HTMLDialogElement).close());

    await openTwinRow('CAD-101');
    const drawer = await textOf('#twinBody');
    expect(drawer).toContain('Sandbox Jira · Jira');
    expect(drawer).toContain('Open in Jira');
    expect(drawer).toContain('ServiceNow INC0010000');
    expect(drawer).toContain('CADENA GOVERNANCE');
    expect(drawer).toContain('CAD-101 · story');
    expect(drawer).toContain('Open traceability');
    const summary = await page.$eval('#twinBody .twin-field[data-field="summary"]', (node) => (node as HTMLElement).innerText);
    expect(summary).toContain('Owned by Jira');
    expect(summary).toContain('no outbound mapping');
    expect(await page.$('#twinBody .twin-field[data-field="summary"] select')).toBeNull();

    await page.select('#twinBody .twin-field[data-field="state"] select', 'Done');
    await page.click('#twinBody .twin-field[data-field="state"] button');
    await page.waitForFunction(
      () => (document.querySelector('#twinBody')?.textContent ?? '').includes('Operator edit → Done'),
      { timeout: 10000 },
    );
    expect(await textOf('#twinBody .activity-list')).toContain('executed');
    await page.evaluate(() => (document.querySelector('#twinDialog') as HTMLDialogElement).close());

    // The counterpart incident was resolved through the published mapping.
    const snow = (await call('/integrations/connectors')).body.find((connector: any) => connector.provider === 'servicenow');
    await call(`/integrations/connectors/${snow.id}/sync`, {});
    const twins = (await call('/workspace/twins')).body;
    expect(twins.find((twin: any) => twin.nativeKey === 'INC0010000').status).toBe('Resolved');
  });

  it('edits a governed non-state field in the twin drawer as free text, not a picklist', async () => {
    // Priority has no discovered picklist (unlike state), so US17.2's write-back generalization
    // must render it as a text input rather than the state field's empty-if-no-choices <select>.
    const jira = (await call('/integrations/connectors')).body.find((connector: any) => connector.provider === 'jira');
    expect((await call(`/integrations/connectors/${jira.id}/write-back`, { state: true, fields: ['priority'] })).status).toBe(201);

    await openTwinRow('CAD-101');
    const priorityRow = '#twinBody .twin-field[data-field="priority"]';
    await page.waitForSelector(priorityRow, { timeout: 10000 });
    expect(await page.$eval(priorityRow, (node) => (node as HTMLElement).innerText)).toContain('Write-back to Jira');
    expect(await page.$(`${priorityRow} select`)).toBeNull();
    const input = await page.$(`${priorityRow} input`);
    expect(input).not.toBeNull();
    expect(await page.$eval(`${priorityRow} input`, (node) => (node as HTMLInputElement).value)).toBe('High');

    await page.$eval(`${priorityRow} input`, (node) => ((node as HTMLInputElement).value = ''));
    await page.type(`${priorityRow} input`, 'Highest');
    await page.click(`${priorityRow} button`);
    await page.waitForFunction(
      () => (document.querySelector('#twinBody')?.textContent ?? '').includes('Operator edit → priority'),
      { timeout: 10000 },
    );
    expect(await textOf('#twinBody .activity-list')).toContain('Operator edit → priority');
    expect(await textOf('#twinBody .activity-list')).toContain('executed');
    await page.evaluate(() => (document.querySelector('#twinDialog') as HTMLDialogElement).close());

    // The twin's own field only reflects the write after its connector's next sync pulls it back,
    // same as a state edit; confirm the round trip actually reached Jira.
    expect((await call(`/integrations/connectors/${jira.id}/sync`, {})).status).toBe(201);
    await openTwinRow('CAD-101');
    expect(await page.$eval(priorityRow, (node) => (node as HTMLElement).innerText)).toContain('Highest');
    await page.evaluate(() => (document.querySelector('#twinDialog') as HTMLDialogElement).close());
  });

  it('checks, blocks, saves, publishes, runs and disables a scheduled native query', async () => {
    const cardButton = (name: string, label: string) => page.evaluate((cardName, buttonLabel) => {
      const card = Array.from(document.querySelectorAll('#nativeQueryList .mapping-card')).find((node) => node.textContent?.includes(cardName));
      const button = Array.from(card?.querySelectorAll('button') ?? []).find((node) => node.textContent === buttonLabel) as HTMLButtonElement | undefined;
      button?.click();
      return Boolean(button);
    }, name, label);
    // The dialog's sticky footer covers a control that Puppeteer scrolls to the bottom edge, so centre it first.
    const centeredClick = async (selector: string) => {
      await page.$eval(selector, (node) => node.scrollIntoView({ block: 'center' }));
      await page.click(selector);
    };
    const cardText = (name: string) => page.evaluate((cardName) => {
      const card = Array.from(document.querySelectorAll('#nativeQueryList .mapping-card')).find((node) => node.textContent?.includes(cardName));
      return (card as HTMLElement | undefined)?.innerText ?? '';
    }, name);

    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#openNativeQueriesFromNav')?.click());
    await page.waitForSelector('#nativeQueryDialog[open]', { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('#nativeQueryList .skeleton'), { timeout: 10000 });

    // The Jira connector is offered with its own language and entity type.
    const jiraOption = await page.$$eval('#nativeQueryConnector option', (options) =>
      options.map((option) => ({ value: (option as HTMLOptionElement).value, text: option.textContent || '' })).find((option) => option.text.includes('JQL')));
    expect(jiraOption).toBeTruthy();
    await page.select('#nativeQueryConnector', jiraOption!.value);
    expect(await page.$eval('#nativeQueryEntity', (node) => (node as HTMLInputElement).value)).toBe('issue');
    expect(await textOf('#nativeQueryLanguageHint')).toContain('JQL');

    // An unbounded query is explained before it is saved, and cannot be published afterwards.
    await page.type('#nativeQueryName', 'UI unbounded');
    await page.type('#nativeQueryText', 'status = Open');
    await centeredClick('#checkNativeQueryButton');
    await page.waitForFunction(() => (document.querySelector('#nativeQueryCheck')?.textContent ?? '').includes('no selective scope'), { timeout: 10000 });
    expect(await textOf('#nativeQueryCheck')).toContain('project = "CAD"');
    await page.click('#saveNativeQueryButton');
    await page.waitForFunction(() => (document.querySelector('#nativeQueryList')?.textContent ?? '').includes('UI unbounded'), { timeout: 10000 });
    const draftText = await cardText('UI unbounded');
    expect(draftText).toContain('draft');
    expect(draftText).toContain('no selective scope');
    expect(await cardButton('UI unbounded', 'Publish')).toBe(true);
    await page.waitForFunction(() => !(document.querySelector('#nativeQueryAlert') as HTMLElement).hidden, { timeout: 10000 });
    expect(await textOf('#nativeQueryAlert')).toContain('Cannot publish');
    expect(await cardText('UI unbounded')).toContain('draft');
    // Chromium logs the deliberately refused publish as a network error; nothing else is excused.
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((message) => !/Failed to load resource.*422/.test(message)));

    // A bounded query checks clean, saves, publishes, runs and can be disabled. The sandbox's seeded
    // records are timestamped 2026-09-22, so the run starts from the day before.
    await page.type('#nativeQueryName', 'UI CAD watch');
    await page.$eval('#nativeQueryText', (node) => { (node as HTMLTextAreaElement).value = ''; });
    await page.type('#nativeQueryText', 'project = CAD');
    await page.$eval('#nativeQueryStart', (node) => { (node as HTMLInputElement).value = '2026-09-21T00:00'; });
    await centeredClick('#checkNativeQueryButton');
    await page.waitForFunction(() => (document.querySelector('#nativeQueryCheck')?.textContent ?? '').includes('Valid'), { timeout: 10000 });
    await page.click('#saveNativeQueryButton');
    await page.waitForFunction(() => (document.querySelector('#nativeQueryList')?.textContent ?? '').includes('UI CAD watch'), { timeout: 10000 });
    expect(await cardButton('UI CAD watch', 'Publish')).toBe(true);
    await page.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('#nativeQueryList .mapping-card')).find((node) => node.textContent?.includes('UI CAD watch'));
      return Boolean(card?.textContent?.includes('published'));
    }, { timeout: 10000 });
    expect(await cardText('UI CAD watch')).toContain('watermark');

    expect(await cardButton('UI CAD watch', 'Run now')).toBe(true);
    await page.waitForFunction(() => (document.querySelector('#toastRegion')?.textContent ?? '').includes('Run complete'), { timeout: 15000 });
    await page.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('#nativeQueryList .mapping-card')).find((node) => node.textContent?.includes('UI CAD watch'));
      return Boolean(card?.textContent?.includes('last run succeeded'));
    }, { timeout: 10000 });

    expect(await cardButton('UI CAD watch', 'Disable')).toBe(true);
    await page.waitForFunction(() => {
      const card = Array.from(document.querySelectorAll('#nativeQueryList .mapping-card')).find((node) => node.textContent?.includes('UI CAD watch'));
      return Boolean(card?.textContent?.includes('disabled'));
    }, { timeout: 10000 });
    expect(await cardButton('UI CAD watch', 'Publish')).toBe(true);

    // WIQL can be checked but is reported as not schedulable.
    await page.select('#nativeQueryCheckLanguage', 'wiql');
    await page.$eval('#nativeQueryText', (node) => { (node as HTMLTextAreaElement).value = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Payments'"; });
    await centeredClick('#checkNativeQueryButton');
    await page.waitForFunction(() => (document.querySelector('#nativeQueryCheck')?.textContent ?? '').includes('cannot be scheduled') || (document.querySelector('#nativeQueryCheck')?.textContent ?? '').includes('not scheduled'), { timeout: 10000 });
    expect(await textOf('#nativeQueryCheck')).toContain('Valid');
    await page.evaluate(() => (document.querySelector('#nativeQueryDialog') as HTMLDialogElement).close());
  });

  it('flags a degraded source and stays within a phone viewport without console errors', async () => {
    await onboard(jiraConfig('Overlapping Jira'));
    await reload();
    expect((await textOf('#sourceKpiSourcesContext')).toLowerCase()).toContain('1 needs attention');
    const degraded = await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll('#sourceHealthList .source-card')).find((node) => node.textContent?.includes('Overlapping Jira'));
      return { attention: card?.classList.contains('attention'), text: (card as HTMLElement | undefined)?.innerText };
    });
    expect(degraded.attention).toBe(true);
    expect(degraded.text).toContain('degraded');
    expect(degraded.text).toContain('already managed by connector');

    await page.setViewport({ width: 390, height: 844 });
    await reload();
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflows).toBe(false);
    await openTwinRow('CAD-102');
    const drawerFits = await page.$eval('#twinDialog', (node) => node.getBoundingClientRect().width <= window.innerWidth + 1);
    expect(drawerFits).toBe(true);

    // The scheduled-query studio holds long error text and query strings; it must wrap, not overflow.
    await page.evaluate(() => (document.querySelector('#twinDialog') as HTMLDialogElement).close());
    await page.click('#mobileMenuButton');
    await page.waitForSelector('#sidebar.open', { timeout: 5000 });
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('#openNativeQueriesFromNav')?.click());
    await page.waitForSelector('#nativeQueryDialog[open]', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#nativeQueryList .mapping-card').length > 0, { timeout: 10000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
    expect(await page.$eval('#nativeQueryDialog', (node) => node.getBoundingClientRect().width <= window.innerWidth + 1)).toBe(true);
    await page.evaluate(() => (document.querySelector('#nativeQueryDialog') as HTMLDialogElement).close());
    expect(consoleErrors).toEqual([]);
  });
});
