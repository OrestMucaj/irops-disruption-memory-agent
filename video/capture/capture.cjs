/**
 * Captures the real IROPS console, driven end to end, for the showcase video.
 *
 * Runs against the app's own dev server (npm run dev) on a local CockroachDB
 * seeded with the demo dataset. Every screenshot is the real UI in a real
 * state; the only intervention is a short network delay on two endpoints so
 * the loading and in-progress states stay on screen long enough to photograph.
 *
 * Output (video/public/captures/):
 *   <name>.png       3840x2160 screenshots (1440x810 CSS px at DPR 8/3)
 *   manifest.json    per shot: scrollY and bounding boxes (CSS px) of the
 *                    elements the camera, cursor and spotlights aim at
 *   data/*.json|txt  API responses and query output the script quotes
 *
 *     node video/capture/capture.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const pg = require('/home/user/irops-disruption-memory-agent/node_modules/pg');

const BASE = process.env.APP_URL || 'http://localhost:3000';
const DB = process.env.DATABASE_URL || 'postgresql://root@localhost:26257/defaultdb?sslmode=disable';
const OUT = path.resolve(__dirname, '../public/captures');
const DATA = path.join(OUT, 'data');
const VIEW = { width: 1440, height: 810 };
const DPR = 8 / 3;

fs.mkdirSync(DATA, { recursive: true });
const manifest = { viewport: VIEW, dpr: DPR, shots: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boxes(page, targets) {
  const out = {};
  for (const [key, locator] of Object.entries(targets)) {
    const loc = typeof locator === 'string' ? page.locator(locator).first() : locator;
    const b = await loc.boundingBox().catch(() => null);
    if (b === null) throw new Error(`no box for ${key}`);
    out[key] = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  return out;
}

async function shot(page, name, targets = {}) {
  await page.evaluate(() => document.fonts.ready);
  await sleep(250);
  const b = await boxes(page, targets);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  manifest.shots[name] = { boxes: b, scrollY: await page.evaluate(() => window.scrollY) };
  console.log('shot', name, Object.keys(b).join(', '));
}

async function getJson(url) {
  const res = await fetch(`${BASE}${url}`);
  return res.json();
}
const save = (file, value) =>
  fs.writeFileSync(path.join(DATA, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Resolved neighbours of a reference case, through the prefix-filtered vector index. */
async function neighbours(db, flightNo) {
  const { rows } = await db.query(
    `WITH q AS (SELECT e.embedding FROM case_embeddings e
                  JOIN disruption_cases c ON c.id = e.case_id WHERE c.flight_no = $1)
     SELECT c.flight_no, c.cause, c.delay_minutes, r.outcome_rating,
            round((e.embedding <=> (SELECT embedding FROM q))::DECIMAL, 4)::STRING AS distance
       FROM case_embeddings e
       JOIN disruption_cases c ON c.id = e.case_id
       LEFT JOIN resolutions r ON r.case_id = e.case_id
      WHERE e.case_status = 'resolved' AND c.flight_no <> $1
      ORDER BY e.embedding <=> (SELECT embedding FROM q)
      LIMIT 5`,
    [flightNo],
  );
  return rows;
}

(async () => {
  const db = new pg.Client({ connectionString: DB });
  await db.connect();

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, colorScheme: 'dark' });
  const page = await context.newPage();

  // --- 1. Caseload ---------------------------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.locator('tr:has(.ident:text-is("ZZ1137"))').waitFor();
  await sleep(600);
  const row = page.locator('tr:has(.ident:text-is("ZZ1137"))').first();
  await shot(page, '01-caseload', {
    kpis: '.kpis',
    table: '.p-datatable',
    row,
    flight: row.locator('td').nth(0),
    delay: row.locator('td').nth(4),
    misconnects: row.locator('td').nth(6),
    sidebar: '.side',
    synthTag: '.topbar .p-tag',
  });
  await row.hover();
  await shot(page, '02-caseload-hover', { row });

  save('cases.json', await getJson('/api/cases'));
  save('memory-before.json', await getJson('/api/memory'));
  save('neighbours-before.json', await neighbours(db, 'ZZ1467'));

  // --- 2. Case detail, before the agent has run -----------------------------
  await row.click();
  await page.locator('.blank').waitFor();
  await sleep(500);
  const getRecs = page.locator('.blank .p-button').first();
  await shot(page, '03-detail-empty', {
    casebar: '.casebar',
    blank: '.blank',
    getRecs,
    route: '.casebar .route',
  });
  await getRecs.hover();
  await shot(page, '04-detail-empty-hover', { getRecs });

  // Hold the run long enough to photograph the loading state.
  await page.route('**/api/cases/*/run', async (r) => { await sleep(2500); await r.continue(); });
  await getRecs.click();
  await sleep(700);
  await shot(page, '05-running', { getRecs, casebar: '.casebar' });
  await page.locator('.grp').first().waitFor({ timeout: 20000 });
  await page.unroute('**/api/cases/*/run');
  await sleep(500);

  // --- 3. The plan -----------------------------------------------------------
  const rebook = page.locator('.grp:has(.grpname b:text-is("Rebook"))').first();
  const notify = page.locator('.grp:has(.grpname b:text-is("Notify"))').first();
  await shot(page, '06-plan', {
    plan: '.step >> nth=0',
    planHead: '.step >> nth=0 >> .p-panel-header',
    gap: '.step >> nth=0 >> .p-message',
    rebook,
    rebookChip: rebook.locator('.pchip').first(),
    rebookCites: rebook.locator('.cites'),
    rebookConf: rebook.locator('.conf'),
    notify,
    decisionbar: '.decisionbar',
    approveAll: '.decisionbar .p-button-success',
    toast: '.p-toast-message',
  });
  await sleep(4500); // let the "Recommendations ready" toast go
  await shot(page, '07-plan-clean', {
    rebook,
    rebookChip: rebook.locator('.pchip').first(),
    notify,
    gap: '.step >> nth=0 >> .p-message',
    decisionbar: '.decisionbar',
    approveAll: '.decisionbar .p-button-success',
  });

  // --- 4. Open the cited precedent -------------------------------------------
  const chip = rebook.locator('.pchip').first();
  await chip.hover();
  await sleep(600);
  await shot(page, '08-chip-hover', { rebookChip: chip });
  await chip.click();
  await page.locator('.p-dialog').waitFor();
  await sleep(700);
  await shot(page, '09-precedent', {
    dialog: '.p-dialog',
    dlgHead: '.p-dialog-header',
    facts: '.p-dialog .facts',
    what: '.p-dialog .dlgquote >> nth=0',
    did: '.p-dialog .dlgtags',
    outcome: '.p-dialog .dlgquote >> nth=1',
  });
  await page.locator('.p-dialog-footer button:has-text("Close")').click();
  await sleep(600);

  // --- 5. Evidence: everything retrieved -------------------------------------
  const tabPrec = page.locator('.p-tab:has-text("Retrieved precedent")').first();
  await tabPrec.scrollIntoViewIfNeeded();
  await tabPrec.click();
  await sleep(500);
  await page.evaluate(() => {
    const el = document.querySelector('.p-tablist');
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70 });
  });
  await sleep(500);
  await shot(page, '10-retrieved', {
    tabs: '.p-tablist',
    tabPrec,
    prec0: '.prec >> nth=0',
    prec1: '.prec >> nth=1',
    prec2: '.prec >> nth=2',
    prec3: '.prec >> nth=3',
    decisionbar: '.decisionbar',
  });
  await page.evaluate(() => {
    const el = document.querySelectorAll('.prec')[3];
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 330 });
  });
  await sleep(500);
  await shot(page, '11-retrieved-low', {
    prec2: '.prec >> nth=2',
    prec3: '.prec >> nth=3',
    prec4: '.prec >> nth=4',
  });

  // --- 6. Review individually, then approve all ------------------------------
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await sleep(400);
  await rebook.locator('.grphead').click();
  await sleep(600);
  await shot(page, '12-review-items', {
    rebook,
    items: rebook.locator('.grpitems'),
    item0: rebook.locator('.itm').first(),
    item0ctl: rebook.locator('.itm .itmctl').first(),
    decisionbar: '.decisionbar',
    approveAll: '.decisionbar .p-button-success',
  });
  await page.locator('.decisionbar .p-button-success').hover();
  await sleep(400);
  await shot(page, '13-approve-hover', {
    decisionbar: '.decisionbar',
    approveAll: '.decisionbar .p-button-success',
  });

  await page.route('**/api/actions/*/decision', async (r) => { await sleep(900); await r.continue(); });
  await page.locator('.decisionbar .p-button-success').click();
  await sleep(1300);
  await shot(page, '14-approving', { decisionbar: '.decisionbar' });
  await page.locator('.decisionbar.done').waitFor({ timeout: 30000 });
  await page.unroute('**/api/actions/*/decision');
  await sleep(700);
  await shot(page, '15-approved', {
    decisionbar: '.decisionbar',
    rebook,
    items: rebook.locator('.grpitems'),
    toast: '.p-toast-message',
  });

  // --- 7. Evidence: the run record -------------------------------------------
  await sleep(4500);
  const tabRun = page.locator('.p-tab:has-text("Agent run")').first();
  await tabRun.click();
  await sleep(400);
  await page.evaluate(() => {
    const el = document.querySelector('.p-tablist');
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70 });
  });
  await sleep(500);
  await shot(page, '16-agent-run', {
    tabs: '.p-tablist',
    tabRun,
    facts: '.p-tabpanels .facts',
    model: '.p-tabpanels .fact >> nth=1',
    retrieved: '.p-tabpanels .fact >> nth=2',
    foot: '.p-tabpanels .foot',
  });

  // --- 8. Close the loop -----------------------------------------------------
  const close = page.locator('#close-the-loop');
  await close.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const el = document.querySelector('#close-the-loop');
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 90 });
  });
  await sleep(500);
  await shot(page, '17-close-empty', {
    close,
    notes: '#close-the-loop textarea',
    rating: '#close-the-loop .p-selectbutton',
    resolve: '#close-the-loop .p-button:has-text("Resolve")',
  });
  const note = 'Rebooked the 8 flagged passengers onto the evening wave, then worked the remaining misconnections at the transfer desk by connection buffer. Most onward journeys recovered the same day.';
  await page.locator('#close-the-loop textarea').fill(note);
  await page.locator('#close-the-loop .p-selectbutton .p-togglebutton').nth(3).click();
  await sleep(400);
  await page.locator('#close-the-loop .p-button:has-text("Resolve")').hover();
  await sleep(300);
  await shot(page, '18-close-filled', {
    close,
    notes: '#close-the-loop textarea',
    rating: '#close-the-loop .p-selectbutton',
    resolve: '#close-the-loop .p-button:has-text("Resolve")',
  });
  await page.locator('#close-the-loop .p-button:has-text("Resolve")').click();
  await page.locator('#close-the-loop .resolved-head').waitFor({ timeout: 30000 });
  await sleep(700);
  await shot(page, '19-resolved', {
    close,
    resolvedHead: '#close-the-loop .resolved-head',
    toast: '.p-toast-message',
    casebar: '.casebar',
  });

  save('neighbours-after.json', await neighbours(db, 'ZZ1467'));
  const { rows: summary } = await db.query(
    `SELECT e.summary_text, e.case_status, e.model_id FROM case_embeddings e
       JOIN disruption_cases c ON c.id = e.case_id WHERE c.flight_no = 'ZZ1137'`,
  );
  save('zz1137-summary.json', summary[0]);

  // --- 9. Memory view --------------------------------------------------------
  await sleep(4500);
  await page.locator('.nav button:has-text("Memory")').click();
  await page.locator('.kpis').waitFor();
  await sleep(900);
  await shot(page, '20-memory', {
    kpis: '.kpis',
    kpiOutcomes: '.kpi >> nth=1',
    kpiDecisions: '.kpi >> nth=3',
    cols: '.cols',
    decisions: '.cols .step >> nth=1',
  });
  save('memory-after.json', await getJson('/api/memory'));

  // --- 10. Ask the memory (UI only; the analyst needs CockroachDB Cloud) -----
  await page.locator('.chatfab').click();
  await sleep(800);
  await page.locator('.sugg').first().hover();
  await sleep(300);
  await shot(page, '21-chat', {
    chatwin: '.chatwin',
    chathead: '.chathead',
    chatempty: '.chatempty',
    sugg0: '.sugg >> nth=0',
    fab: '.chatfab',
  });

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const cases = JSON.parse(fs.readFileSync(path.join(DATA, 'cases.json'), 'utf8')).cases;
  const zz = cases.find((c) => c.flight_no === 'ZZ1137');
  save('zz1137-detail.json', await getJson(`/api/cases/${zz.id}`));

  await browser.close();
  await db.end();
  console.log('done');
})().catch((err) => { console.error(err); process.exit(1); });
