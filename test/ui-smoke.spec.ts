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

  /** Layers an alert-driven Incident, an impact chain and a fallback notification onto the seed. */
  async function seedScenario() {
    await api('/integrations/monitoring/settings', {
      min_severity: 'SEV4', dedupe_window_minutes: 60, default_team_id: TEAM,
    });

    const alert = await api(
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
  }

  beforeAll(async () => {
    server = spawn(process.execPath, [serverEntry], {
      // Forced ephemeral: this suite seeds its own scenario and must start from the seed
      // every run, even if the surrounding shell exports a data directory.
      env: { ...process.env, PORT: String(PORT), CADENA_DATA_DIR: '' },
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

    expect(consoleErrors).toEqual([]);
  });
});
