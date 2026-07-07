// src/discoverSlots.ts
// One-off slot discovery — logs in with account #1, stays on booking.php,
// inspects the court dropdown and per-court time dropdown. Outputs JSON + screenshots.
// Run with: npm run discover

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './server/configLoader';

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';

// Pick account via CLI arg: `npm run discover -- --account=2` (default: 0)
// Use a fresh account (one that hasn't booked today) to avoid the 1-per-day rule.
const accountArg = process.argv.find(a => a.startsWith('--account='));
const ACCOUNT_INDEX = accountArg ? parseInt(accountArg.split('=')[1], 10) : 1; // default to account #2 (fresh)
const ACCOUNT = getConfig().accounts[ACCOUNT_INDEX];

const SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'screenshots');
const REPORT_PATH = path.resolve(__dirname, '..', 'reports', 'slots-discovered.json');

interface SelectOption {
  value: string;
  text: string;
  disabled: boolean;
  selected: boolean;
}

interface SelectControl {
  kind: 'select';
  name?: string | null;
  id?: string | null;
  label?: string | null;
  options: SelectOption[];
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function shoot(page: Page, name: string) {
  ensureDir(SCREENSHOTS_DIR);
  const file = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`📸 ${file}`);
}

async function tryFill(page: Page, selectors: string[], value: string, label: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible()) {
        await loc.fill(value);
        console.log(`✓ ${label}: filled via "${sel}"`);
        return true;
      }
    } catch { /* try next */ }
  }
  console.log(`✗ ${label}: no selector matched (tried: ${selectors.join(', ')})`);
  return false;
}

async function tryClick(page: Page, selectors: string[], label: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible()) {
        await loc.click();
        console.log(`✓ ${label}: clicked via "${sel}"`);
        return true;
      }
    } catch { /* try next */ }
  }
  console.log(`✗ ${label}: no selector matched (tried: ${selectors.join(', ')})`);
  return false;
}

async function dumpSelect(page: Page, selector: string, label: string): Promise<SelectControl | null> {
  const loc = page.locator(selector).first();
  if (await loc.count() === 0) {
    console.log(`   ✗ ${label}: selector "${selector}" not found`);
    return null;
  }
  const name = await loc.getAttribute('name');
  const id = await loc.getAttribute('id');
  const optionLocs = await loc.locator('option').all();
  const options: SelectOption[] = [];
  for (const opt of optionLocs) {
    options.push({
      value: await opt.getAttribute('value') ?? '',
      text: (await opt.textContent())?.trim() ?? '',
      disabled: await opt.isDisabled(),
      selected: await opt.evaluate((el: HTMLOptionElement) => el.selected),
    });
  }
  return { kind: 'select', name, id, label, options };
}

async function main() {
  console.log(`\n=== Slot Discovery ===`);
  console.log(`Account: ${ACCOUNT.username} (slot: ${ACCOUNT.slot})`);
  console.log(`Target:  ${LOGIN_URL}\n`);

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    // Log network activity — useful for catching AJAX calls that populate the time dropdown
    page.on('request', (req) => {
      if (req.url().includes('susport')) console.log(`   ↗ ${req.method()} ${req.url()}`);
    });
    const ajaxResponses: { url: string; status: number; body: string }[] = [];
    page.on('response', async (resp) => {
      if (resp.url().includes('susport') && resp.request().method() !== 'GET') {
        const status = resp.status();
        console.log(`   ↘ ${status} ${resp.url()}`);
        try {
          const body = await resp.text();
          ajaxResponses.push({ url: resp.url(), status, body });
        } catch { /* ignore */ }
      }
    });

    // ---- Step 1: Load login page ----
    console.log('[1] Loading login page…');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await shoot(page, 'discover-1-login-page');

    // ---- Step 2: Fill credentials ----
    console.log('\n[2] Filling credentials…');
    await tryFill(page, ['input[name="username"]', 'input[id="username"]'], ACCOUNT.username, 'username');
    await tryFill(page, ['input[name="password"]', 'input[id="password"]'], ACCOUNT.password, 'password');

    // ---- Step 3: Submit ----
    console.log('\n[3] Submitting login…');
    await tryClick(page, ['input[type="submit"]', 'button[type="submit"]'], 'login submit');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    console.log(`   Post-login URL: ${page.url()}`);
    await shoot(page, 'discover-2-post-login');

    // We should now be on booking.php — inspect what's there.
    console.log('\n[4] Inspecting booking page controls…');

    // Dump inline scripts so we can see how the time dropdown is supposed to populate
    const inlineScripts = await page.locator('script:not([src])').all();
    for (let i = 0; i < inlineScripts.length; i++) {
      const code = await inlineScripts[i].textContent();
      if (code && code.trim().length > 0) {
        console.log(`   (debug) Inline script #${i} (${code.length} chars):`);
        console.log(code.split('\n').map(l => '     | ' + l).join('\n'));
      }
    }
    const allSelects = await page.locator('select').all();
    console.log(`   Found ${allSelects.length} <select>(s) on booking page:`);
    const selectMeta: { selector: string; name: string | null; id: string | null; firstOption: string }[] = [];
    for (let i = 0; i < allSelects.length; i++) {
      const sel = allSelects[i];
      const name = await sel.getAttribute('name');
      const id = await sel.getAttribute('id');
      const firstOptText = (await sel.locator('option').first().textContent())?.trim() ?? '';
      // Build a robust selector — prefer #id, fall back to [name=...], then index
      let selector: string;
      if (id) selector = `#${id}`;
      else if (name) selector = `select[name="${name}"]`;
      else selector = `select >> nth=${i}`;
      selectMeta.push({ selector, name, id, firstOption: firstOptText });
      console.log(`     [${i}] name="${name}" id="${id}" first-option="${firstOptText}"  →  selector: ${selector}`);
    }

    if (selectMeta.length < 2) {
      throw new Error(`Expected at least 2 <select> elements (court + time); found ${selectMeta.length}`);
    }

    const courtSelectMeta = selectMeta[0]; // first select is the court picker (per UI order)
    const timeSelectMeta = selectMeta[1];  // second select is the time picker

    // ---- Step 5: Dump court dropdown BEFORE selecting anything ----
    console.log(`\n[5] Court dropdown (${courtSelectMeta.selector}):`);
    const courtSelect = await dumpSelect(page, courtSelectMeta.selector, 'court');
    if (courtSelect) {
      for (const o of courtSelect.options) {
        console.log(`     - value="${o.value}" text="${o.text}" disabled=${o.disabled}`);
      }
    }

    // ---- Step 6: For each court (แบดมินตัน1 then แบดมินตัน4), select and dump time dropdown ----
    const courtsToCheck = ['แบดมินตัน1', 'แบดมินตัน4'];
    const allTimeData: Record<string, SelectControl | null> = {};

    for (const courtName of courtsToCheck) {
      console.log(`\n[6.${courtName}] Selecting court and inspecting time dropdown…`);

      // Find option by text
      const optionLoc = page.locator(`${courtSelectMeta.selector} option`).filter({ hasText: courtName }).first();
      if (await optionLoc.count() === 0) {
        console.log(`   ✗ Court "${courtName}" not found in dropdown`);
        allTimeData[courtName] = null;
        continue;
      }
      const value = await optionLoc.getAttribute('value');
      console.log(`   Selecting "${courtName}" (value="${value}")…`);
      await page.locator(courtSelectMeta.selector).selectOption(value ?? { label: courtName });

      // Wait for the time dropdown to repopulate (AJAX likely)
      await page.waitForTimeout(4000);
      await shoot(page, `discover-3-court-${courtName.replace(/\s+/g, '_')}`);

      // Dump outerHTML of the time select for debugging if empty
      const timeHtml = await page.locator(timeSelectMeta.selector).evaluate((el) => el.outerHTML);
      console.log(`   (debug) #time outerHTML: ${timeHtml}`);

      const timeSelect = await dumpSelect(page, timeSelectMeta.selector, 'time');
      allTimeData[courtName] = timeSelect;

      if (timeSelect) {
        console.log(`   Time dropdown (${timeSelectMeta.selector}) after selecting "${courtName}":`);
        for (const o of timeSelect.options) {
          const marker = o.disabled ? '✗ taken' : '✓ available';
          console.log(`     ${marker}  value="${o.value}" text="${o.text}"`);
        }
      }
    }

    // ---- Step 7: Persist findings ----
    ensureDir(path.dirname(REPORT_PATH));
    const report = {
      discovered_at: new Date().toISOString(),
      account_used: ACCOUNT.username,
      login_url: LOGIN_URL,
      post_login_url: page.url(),
      selects_on_booking_page: selectMeta,
      court_dropdown: courtSelect,
      time_dropdown_by_court: allTimeData,
      ajax_responses: ajaxResponses.map(r => ({ url: r.url, status: r.status, body: r.body })),
    };
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n✓ Report saved: ${REPORT_PATH}`);
    console.log(`✓ Screenshots:   ${SCREENSHOTS_DIR}/`);

  } catch (err) {
    console.error(`\n❌ Discovery failed: ${err}`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

main();