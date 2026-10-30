/**
 * Captures the live IROPS console, driven end to end, for the showcase video.
 *
 * Runs against the deployed demo: the S3 frontend, the Lambda API, Amazon
 * Bedrock (Titan Text Embeddings V2, Nova Lite) and CockroachDB Cloud with its
 * Managed MCP Server. Every screenshot is the real UI in a real state. The only
 * intervention is a short network delay on two endpoints, so the loading and
 * in-progress states stay on screen long enough to photograph.
 *
 * It writes to the live demo: it runs the agent on ZZ1137, approves the plan
 * and resolves the case. Re-seed afterwards to reset the caseload.
 *
 * Queries the script needs for the video (nearest resolved neighbours before
 * and after ZZ1137 becomes precedent) go through the same Managed MCP Server
 * the analyst uses, read-only, with select_query.
 *
 * Output (video/public/captures/):
 *   <name>.png       3840x2160 screenshots (1440x810 CSS px at DPR 8/3)
 *   manifest.json    per shot: scrollY and bounding boxes (CSS px) of the
 *                    elements the camera, cursor and spotlights aim at
 *   data/*.json      API responses and query results the video quotes
 *
 *     NODE_USE_ENV_PROXY=1 node --env-file=.env video/capture/capture.cjs
 *
 * MCP_API_KEY and MCP_CLUSTER_ID come from .env. Requires `npm run build`
 * (for dist/mcp/client.js).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const SITE = process.env.APP_URL || 'https://irops-memory-demo-21.s3.us-east-1.amazonaws.com/index.html';
const API = process.env.API_URL || 'https://7p2mkku36rbgbj2chqcsers5qy0gkccu.lambda-url.us-east-1.on.aws';
const QUESTION = 'Which cause had the worst average outcome rating?';
const OUT = path.resolve(__dirname, '../public/captures');
const DATA = path.join(OUT, 'data');
const VIEW = { width: 1440, height: 810 };
const DPR = 8 / 3;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const manifest = { source: SITE, viewport: VIEW, dpr: DPR, shots: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const save = (file, value) => fs.writeFileSync(path.join(DATA, file), JSON.stringify(value, null, 2));

/** Bounding boxes in CSS px. Missing optional targets are recorded as absent, not fatal. */
async function boxes(page, targets) {
  const out = {};
  for (const [key, target] of Object.entries(targets)) {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    const b = (await loc.count().catch(() => 0)) > 0 ? await loc.boundingBox().catch(() => null) : null;
    if (b !== null) out[key] = { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  return out;
}

async function shot(page, name, targets = {}, extra = {}) {
  await page.evaluate(() => document.fonts.ready);
  await sleep(250);
  const b = await boxes(page, targets);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  manifest.shots[name] = { boxes: b, scrollY: await page.evaluate(() => window.scrollY), ...extra };
  const missing = Object.keys(targets).filter((k) => !(k in b));
  console.log('shot', name, missing.length ? `(absent: ${missing.join(', ')})` : '');
}

async function getJson(url) {
  const res = await fetch(`${API}${url}`);
  return res.json();
}

const scrollTo = (page, selector, offset) =>
  page.evaluate(([sel, off]) => {
    const el = document.querySelector(sel);
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - off });
  }, [selector, offset]);

/** Resolved cases nearest a reference case, through the case_status prefix. */
async function neighbours(mcp, flightNo) {
  const sql = `WITH q AS (SELECT e.embedding FROM case_embeddings e
                 JOIN disruption_cases c ON c.id = e.case_id WHERE c.flight_no = '${flightNo}')
    SELECT c.flight_no, c.cause, c.delay_minutes, r.outcome_rating,
           round((e.embedding <=> (SELECT embedding FROM q))::DECIMAL, 4)::STRING AS distance
      FROM case_embeddings e
      JOIN disruption_cases c ON c.id = e.case_id
      LEFT JOIN resolutions r ON r.case_id = e.case_id
     WHERE e.case_status = 'resolved' AND c.flight_no <> '${flightNo}'
     ORDER BY e.embedding <=> (SELECT embedding FROM q)
     LIMIT 5`;
  return JSON.parse(await mcp.callTool('select_query', { database: 'defaultdb', query: sql })).rows;
}

(async () => {
  const { McpClient } = await import(path.resolve(__dirname, '../../dist/mcp/client.js'));
  const mcp = new McpClient({ url: process.env.MCP_URL || 'https://cockroachlabs.cloud/mcp', apiKey: process.env.MCP_API_KEY, clusterId: process.env.MCP_CLUSTER_ID });
  await mcp.connect();

  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY } } : {});
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DPR, colorScheme: 'dark' });
  const page = await context.newPage();

  // --- 1. Caseload ---------------------------------------------------------
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.locator('tr:has(.ident:text-is("ZZ1137"))').waitFor({ timeout: 60000 });
  await page.locator('.sysok').waitFor({ timeout: 60000 });
  await sleep(800);
  const row = page.locator('tr:has(.ident:text-is("ZZ1137"))').first();
  await shot(page, '01-caseload', {
    kpis: '.kpis', table: '.p-datatable', row,
    flight: row.locator('td').nth(0), delay: row.locator('td').nth(4), misconnects: row.locator('td').nth(6),
    sidebar: '.side', sysbox: '.sysbox',
  });
  await row.hover();
  await shot(page, '02-caseload-hover', { row });
  save('cases.json', await getJson('/api/cases'));
  save('memory-before.json', await getJson('/api/memory'));

  // --- 2. Case detail, before the agent has run -----------------------------
  await row.click();
  await page.locator('.blank').waitFor();
  await sleep(600);
  const getRecs = page.locator('.blank .p-button').first();
  await shot(page, '03-detail-empty', { casebar: '.casebar', blank: '.blank', getRecs, gap: '.step >> nth=0 >> .p-message' });
  await getRecs.hover();
  await shot(page, '04-detail-empty-hover', { getRecs });

  await page.route('**/api/cases/*/run', async (r) => { await sleep(1500); await r.continue(); });
  await getRecs.click();
  await sleep(900);
  await shot(page, '05-running', { getRecs, casebar: '.casebar' });
  await page.locator('.grp').first().waitFor({ timeout: 120000 });
  await page.unroute('**/api/cases/*/run');
  // Park the pointer in the right gutter: the plan renders under it, and a
  // hovered precedent chip would show its tooltip in the next two shots.
  await page.mouse.move(1434, 420);
  await sleep(700);

  // --- 3. The plan -----------------------------------------------------------
  const groups = page.locator('.grp');
  const groupNames = await page.locator('.grp .grpname b').allTextContents();
  const groupTargets = Object.fromEntries(groupNames.map((n, i) => [`g${i}`, groups.nth(i)]));
  const chips = page.locator('.grp .cites .pchip');
  const chipTexts = (await chips.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
  // Prefer the README's example, then any precedent that worked, then the first.
  let chipIdx = chipTexts.findIndex((t) => t.includes('ZZ4381'));
  if (chipIdx === -1) chipIdx = chipTexts.findIndex((t) => /5\/5|4\/5/.test(t));
  if (chipIdx === -1) chipIdx = 0;
  const chip = chips.nth(chipIdx);
  const chipGroupIdx = await chip.evaluate((el) => [...document.querySelectorAll('.grp')].indexOf(el.closest('.grp')));
  const chipGroup = groups.nth(chipGroupIdx);
  await shot(page, '06-plan', {
    plan: '.step >> nth=0', planHead: '.step >> nth=0 >> .p-panel-header', gap: '.step >> nth=0 >> .p-message',
    chip, chipGroup, chipCites: chipGroup.locator('.cites'), chipConf: chipGroup.locator('.conf'),
    decisionbar: '.decisionbar', approveAll: '.decisionbar .p-button-success', toast: '.p-toast-message', ...groupTargets,
  }, { groupNames, chipTexts, chipIdx, chipGroupIdx });
  await sleep(4500);
  await shot(page, '07-plan-clean', {
    plan: '.step >> nth=0', gap: '.step >> nth=0 >> .p-message', chip, chipGroup, decisionbar: '.decisionbar',
    approveAll: '.decisionbar .p-button-success', ...groupTargets,
  });

  // --- 4. Open the cited precedent -------------------------------------------
  await chip.hover();
  await sleep(600);
  await shot(page, '08-chip-hover', { chip });
  await chip.click();
  await page.locator('.p-dialog').waitFor();
  await sleep(800);
  await shot(page, '09-precedent', {
    dialog: '.p-dialog', dlgHead: '.p-dialog-header', facts: '.p-dialog .facts',
    what: '.p-dialog .dlgquote >> nth=0', did: '.p-dialog .dlgtags', outcome: '.p-dialog .dlgquote >> nth=1',
  });
  await page.locator('.p-dialog-footer button:has-text("Close")').click();
  await sleep(600);

  // --- 5. Evidence: everything retrieved -------------------------------------
  const tabPrec = page.locator('.p-tab:has-text("Retrieved precedent")').first();
  await tabPrec.scrollIntoViewIfNeeded();
  await tabPrec.click();
  await sleep(500);
  await scrollTo(page, '.p-tablist', 70);
  await sleep(500);
  const precClasses = await page.locator('.prec').evaluateAll((els) => els.map((e) => e.className));
  const precTargets = Object.fromEntries(precClasses.map((_, i) => [`prec${i}`, `.prec >> nth=${i}`]));
  await shot(page, '10-retrieved', { tabs: '.p-tablist', tabPrec, ...precTargets }, { precClasses });
  const lowIdx = precClasses.findIndex((c) => /\bbad\b/.test(c));
  if (lowIdx !== -1) {
    await page.evaluate((i) => {
      const el = document.querySelectorAll('.prec')[i];
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 330 });
    }, lowIdx);
    await sleep(500);
    await shot(page, '11-retrieved-low', { low: `.prec >> nth=${lowIdx}` }, { lowIdx });
  }

  // --- 6. Review individually, then approve all ------------------------------
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await sleep(400);
  const counts = await page.locator('.grp .grpn').allTextContents();
  const reviewIdx = counts.map(Number).reduce((best, n, i, a) => (n > a[best] ? i : best), 0);
  const review = groups.nth(reviewIdx);
  await review.locator('.grphead').click();
  await sleep(700);
  await shot(page, '12-review-items', {
    review, items: review.locator('.grpitems'), item0: review.locator('.itm').first(),
    item0ctl: review.locator('.itm .itmctl').first(), decisionbar: '.decisionbar', approveAll: '.decisionbar .p-button-success',
  }, { reviewName: groupNames[reviewIdx] });
  await page.locator('.decisionbar .p-button-success').hover();
  await sleep(400);
  await shot(page, '13-approve-hover', { decisionbar: '.decisionbar', approveAll: '.decisionbar .p-button-success' },
    { approveLabel: (await page.locator('.decisionbar .p-button-success').textContent()).trim() });

  await page.route('**/api/actions/*/decision', async (r) => { await sleep(700); await r.continue(); });
  await page.locator('.decisionbar .p-button-success').click();
  await sleep(1300);
  await shot(page, '14-approving', { decisionbar: '.decisionbar' });
  await page.locator('.decisionbar.done').waitFor({ timeout: 120000 });
  await page.unroute('**/api/actions/*/decision');
  await sleep(700);
  await shot(page, '15-approved', { decisionbar: '.decisionbar', review, items: review.locator('.grpitems'), toast: '.p-toast-message' });

  // --- 7. Evidence: the run record -------------------------------------------
  await sleep(4500);
  const tabRun = page.locator('.p-tab:has-text("Agent run")').first();
  await tabRun.click();
  await sleep(400);
  await scrollTo(page, '.p-tablist', 70);
  await sleep(500);
  await shot(page, '16-agent-run', {
    tabs: '.p-tablist', tabRun, facts: '.p-tabpanels .facts', runAt: '.p-tabpanels .fact >> nth=0',
    model: '.p-tabpanels .fact >> nth=1', retrieved: '.p-tabpanels .fact >> nth=2', latency: '.p-tabpanels .fact >> nth=3',
    promptTok: '.p-tabpanels .fact >> nth=4', completionTok: '.p-tabpanels .fact >> nth=5', foot: '.p-tabpanels .foot',
  });
  await tabPrec.click();
  await sleep(400);
  await scrollTo(page, '.p-tablist', 70);
  await sleep(500);
  await shot(page, '10b-retrieved-after', { tabs: '.p-tablist', tabPrec, ...precTargets });

  const cases = (await getJson('/api/cases')).cases;
  const zz = cases.find((c) => c.flight_no === 'ZZ1137');
  const detail = await getJson(`/api/cases/${zz.id}`);
  save('zz1137-detail-planned.json', detail);

  // Reference candidates for the "comes back" query: ZZ1137's own precedents.
  const refs = detail.precedents.slice(0, 5).map((p) => p.flight_no);
  const before = {};
  for (const f of refs) before[f] = await neighbours(mcp, f);

  // --- 8. Close the loop -----------------------------------------------------
  const close = page.locator('#close-the-loop');
  await close.scrollIntoViewIfNeeded();
  await scrollTo(page, '#close-the-loop', 90);
  await sleep(500);
  const closeTargets = { close, notes: '#close-the-loop textarea', rating: '#close-the-loop .p-selectbutton', resolve: '#close-the-loop .p-button:has-text("Resolve")' };
  await shot(page, '17-close-empty', closeTargets);
  const note = 'Rebooked the misconnecting passengers onto the evening wave and worked the remaining transfers by connection buffer. Most onward journeys recovered the same day.';
  await page.locator('#close-the-loop textarea').fill(note);
  await page.locator('#close-the-loop .p-selectbutton .p-togglebutton').nth(3).click();
  await sleep(400);
  await page.locator('#close-the-loop .p-button:has-text("Resolve")').hover();
  await sleep(300);
  await shot(page, '18-close-filled', closeTargets);
  await page.locator('#close-the-loop .p-button:has-text("Resolve")').click();
  await page.locator('#close-the-loop .resolved-head').waitFor({ timeout: 120000 });
  await sleep(800);
  await shot(page, '19-resolved', { close, resolvedHead: '#close-the-loop .resolved-head', toast: '.p-toast-message', casebar: '.casebar' });

  // ZZ1137 is now inside the 'resolved' prefix. Find a precedent whose
  // nearest resolved neighbours now include it.
  let reference = null;
  for (const f of refs) {
    const after = await neighbours(mcp, f);
    const was = before[f].some((r) => r.flight_no === 'ZZ1137');
    if (!was && after.some((r) => r.flight_no === 'ZZ1137')) {
      const c = cases.find((x) => x.flight_no === f);
      reference = { flight_no: f, cause: c.cause, delay_minutes: c.delay_minutes, before: before[f], after };
      break;
    }
  }
  save('neighbours.json', reference);
  console.log('reference for the loop:', reference ? reference.flight_no : 'none found');
  save('zz1137-detail-resolved.json', await getJson(`/api/cases/${zz.id}`));
  const summary = JSON.parse(await mcp.callTool('select_query', {
    database: 'defaultdb',
    query: `SELECT e.summary_text, e.case_status, e.model_id FROM case_embeddings e
              JOIN disruption_cases c ON c.id = e.case_id WHERE c.flight_no = 'ZZ1137' LIMIT 1`,
  })).rows[0];
  save('zz1137-summary.json', summary);

  // --- 9. Memory view --------------------------------------------------------
  await sleep(4500);
  await page.locator('.nav button:has-text("Memory")').click();
  await page.locator('.kpis').waitFor();
  await sleep(1200);
  await shot(page, '20-memory', { kpis: '.kpis', kpiOutcomes: '.kpi >> nth=1', kpiDecisions: '.kpi >> nth=3', cols: '.cols', decisions: '.cols .step >> nth=1' });
  save('memory-after.json', await getJson('/api/memory'));

  // --- 10. Ask the memory ----------------------------------------------------
  await page.locator('.chatfab').click();
  await sleep(900);
  const sugg = page.locator('.sugg', { hasText: QUESTION }).first();
  await sugg.hover();
  await sleep(300);
  await shot(page, '21-chat', { chatwin: '.chatwin', chathead: '.chathead', chatempty: '.chatempty', sugg, fab: '.chatfab' });
  await sugg.click();
  await sleep(1500);
  await shot(page, '22-chat-thinking', { chatwin: '.chatwin', user: '.msg.user', thinking: '.thinking' });
  await page.locator('.msg.bot .botbody').last().locator('.botsay, .p-message').first().waitFor({ timeout: 180000 });
  await sleep(800);
  await page.locator('.chatbody').evaluate((el) => { el.scrollTop = 0; });
  await sleep(400);
  await shot(page, '23-chat-answer', { chatwin: '.chatwin', user: '.msg.user', answer: '.botsay', qtoggle: '.qtoggle', q0: '.qlist .q >> nth=0' },
    { answer: await page.locator('.botsay').last().textContent().catch(() => null) });
  const nq = await page.locator('.qlist .q').count();
  const last = page.locator('.qlist .q').nth(nq - 1);
  await last.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await sleep(500);
  await shot(page, '24-chat-sql', { chatwin: '.chatwin', q: last, sql: last.locator('.sql'), rows: last.locator('.rows'), qtoggle: '.qtoggle' }, { queries: nq });
  save('analyst.json', await page.evaluate(() => {
    const qs = [...document.querySelectorAll('.qlist .q')].map((q) => ({
      head: q.querySelector('.qh')?.textContent?.replace(/\s+/g, ' ').trim(),
      sql: q.querySelector('.sql')?.textContent ?? null,
      rows: q.querySelector('.rows')?.textContent ?? null,
    }));
    return { answer: document.querySelector('.botsay')?.textContent ?? null, meta: document.querySelector('.qtoggle')?.textContent?.replace(/\s+/g, ' ').trim(), queries: qs };
  }));

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await browser.close();
  console.log('done');
})().catch((err) => { console.error(err); process.exit(1); });
