// End-to-end check in real browsers: one "rider" phone and one "intercessor"
// phone against a local `wrangler dev`. Run with: npm run e2e
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

rmSync('.wrangler/state', { recursive: true, force: true });
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--var', 'SETUP_TOKEN:e2e-setup', '--var', 'MAX_NEW_PAGES_PER_MINUTE:1000', '--var', 'MAX_LIVE_PAGES:1000', '--var', 'MAX_PAGES_PER_SHIFT:10000'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

const stop = () => {
  try {
    process.kill(-server.pid);
  } catch {}
};
const step = (name) => console.log(`✓ ${name}`);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

const PARTNER_LINKS = [
  ['https://www.24-7prayer.com', '24-7 Prayer'],
  ['https://orderofthemustardseed.com', 'Order of the Mustard Seed'],
];

// Both logos present, linked to the right sites, safe to follow, and actually loaded
// (loading proves the page's content security policy allows them).
async function checkPartners(page, who) {
  const links = page.locator('footer.partners a');
  await links.first().waitFor();
  if ((await links.count()) !== PARTNER_LINKS.length) throw new Error(`${who}: expected ${PARTNER_LINKS.length} partner links`);
  for (const [i, [href, name]] of PARTNER_LINKS.entries()) {
    const a = links.nth(i);
    const got = await a.evaluate((el) => ({ href: el.getAttribute('href'), target: el.target, rel: el.rel, alt: el.querySelector('img')?.alt }));
    if (got.href !== href) throw new Error(`${who}: ${name} links to ${got.href}`);
    if (got.target !== '_blank') throw new Error(`${who}: ${name} link does not open a new tab`);
    if (!/noopener/.test(got.rel) || !/noreferrer/.test(got.rel)) throw new Error(`${who}: ${name} link rel is "${got.rel}"`);
    if (got.alt !== name) throw new Error(`${who}: ${name} logo alt text is "${got.alt}"`);
  }
  await page.waitForFunction(() => [...document.querySelectorAll('footer.partners img')].every((i) => i.complete && i.naturalWidth > 0));
  const box = await page.locator('footer.partners').boundingBox();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (!box || overflow) throw new Error(`${who}: footer missing or the page scrolls sideways`);
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/host`)).status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not start:\n${log}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch();
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1 };
  const hostCtx = await browser.newContext(phone);
  const riderCtx = await browser.newContext(phone);
  const host = await hostCtx.newPage();
  const rider = await riderCtx.newPage();
  const errors = [];
  for (const [who, p] of [['host', host], ['rider', rider]]) {
    p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && !/40[134]/.test(m.text()) && errors.push(`${who} console: ${m.text()}`));
  }

  // Everything the rider's browser sends, to prove no secret leaves the phone.
  const sent = [];
  rider.on('request', (r) => sent.push(`${r.method()} ${r.url()} ${r.postData() ?? ''} ${JSON.stringify(r.headers())}`));
  rider.on('websocket', (ws) => sent.push(`WS ${ws.url()}`));
  const riderUrls = [];
  rider.on('request', (r) => riderUrls.push(r.url()));

  // --- intercessor sets up -------------------------------------------------
  await host.goto(`${BASE}/dash`);
  await host.getByLabel('Your first name').fill('Sam');
  await host.getByLabel('Setup code').fill('wrong');
  await host.getByRole('button', { name: 'Create my station' }).click();
  await host.getByText('That setup code is not right.').waitFor();
  await host.getByLabel('Setup code').fill('e2e-setup');
  await shot(host, '01-setup');
  await host.getByRole('button', { name: 'Create my station' }).click();
  await host.getByRole('switch').waitFor();
  await checkPartners(host, 'dashboard');
  await shot(host, '01b-dash-footer');
  step('intercessor creates a station; the dashboard footer shows both linked logos');

  await host.getByRole('button', { name: 'Settings' }).click();
  const link = (await host.locator('.qr + p').innerText()).trim();
  if (!/^http:\/\/localhost:\d+\/#k=[A-Za-z0-9_-]{44}$/.test(link)) throw new Error(`unexpected hat link: ${link}`);
  await host.locator('.qr svg').waitFor();
  await shot(host, '02-settings');
  await host.getByRole('button', { name: '← Back' }).click();

  // --- off duty: the hat does nothing ---------------------------------------
  await rider.goto(link);
  await rider.getByText("I'm not out praying right now").waitFor();
  await shot(rider, '03-off-duty');
  step('off duty: scanning shows a "not right now" page and creates nothing');

  await host.getByRole('switch').click();
  await host.getByText('Praying on the bus').waitFor();

  // --- rider scans ----------------------------------------------------------
  await rider.goto('about:blank');
  await rider.goto(link);
  await rider.getByRole('heading', { name: "Hi, I'm Sam." }).waitFor();
  await rider.waitForURL(/\/p\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);
  const pageUrl = rider.url();
  const pageKey = pageUrl.split('#')[1];
  await shot(rider, '04-rider-landing');
  await checkPartners(rider, 'rider page');
  await host.getByText('Opened your page').waitFor();
  step('rider lands; dashboard shows the new page live');

  // --- rider sends a request ------------------------------------------------
  const SECRET = 'Please pray for my job interview tomorrow';
  await rider.getByLabel('Your name (optional)').fill('Dana');
  await rider.getByLabel('How can I pray for you? (optional)').fill(SECRET);
  await rider.getByRole('button', { name: 'Send it off' }).click();
  await rider.getByText('Sent. Keep this page open').waitFor();
  await shot(rider, '05-rider-sent');
  await host.getByText('New request').waitFor();
  await shot(host, '06-dash-new-request');
  step('rider sends a request; dashboard marks it new');

  // --- intercessor reads and prays -------------------------------------------
  // The rider scrolls to the very bottom (the footer logos), far from the banner at the top.
  // A short window makes sure the page is long enough to scroll however much text it has.
  await rider.setViewportSize({ width: 390, height: 520 });
  await rider.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  if ((await rider.evaluate(() => window.scrollY)) < 200) throw new Error('the rider page did not scroll, so the toast check would prove nothing');
  await host.getByText('New request').click();
  await host.getByText(SECRET).waitFor();
  await host.getByRole('heading', { name: 'Dana' }).waitFor();
  await shot(host, '07-dash-detail');
  await host.getByRole('button', { name: "I've prayed for this" }).click();
  await host.getByText('They can see this on their page').waitFor();
  const toast = rider.locator('.toast');
  await toast.getByText('I prayed for you at').waitFor();
  // Wait for the slide-in to finish, then require the whole toast to be on screen.
  await rider.waitForFunction(() => {
    const r = document.querySelector('.toast')?.getBoundingClientRect();
    return !!r && r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0;
  });
  const bannerOffScreen = await rider.locator('.banner').evaluate((el) => el.getBoundingClientRect().bottom < 0);
  if (!bannerOffScreen) throw new Error('the inline banner is on screen, so the toast check would prove nothing');
  if (SHOTS) await rider.screenshot({ path: `${SHOTS}/08b-rider-toast.png` });
  await rider.getByRole('button', { name: 'Dismiss notification' }).click();
  await toast.waitFor({ state: 'hidden' });
  await rider.locator('.banner').getByText('I prayed for you at').waitFor();
  await rider.setViewportSize({ width: 390, height: 844 });
  await rider.evaluate(() => window.scrollTo(0, 0));
  await shot(rider, '08-rider-prayed');
  step('intercessor decrypts and prays; the rider sees a toast wherever they have scrolled, and the banner stays');

  // --- chat -------------------------------------------------------------------
  await rider.getByRole('button', { name: 'Start a chat' }).click();
  await rider.getByLabel('Message').fill('Thank you. Could we talk a little?');
  await rider.getByRole('button', { name: 'Send', exact: true }).click();
  await host.getByText('Thank you. Could we talk a little?').waitFor();
  await host.getByLabel('Message').fill('Of course. I am right here.');
  await host.getByRole('button', { name: 'Send', exact: true }).click();
  await rider.getByText('Of course. I am right here.').waitFor();
  await shot(rider, '09-rider-chat');
  step('chat works both ways, live');

  // A message that arrives while the intercessor is on the list shows a chat bubble.
  await host.getByRole('button', { name: '← Back' }).click();
  await rider.getByLabel('Message').fill('One more thing');
  await rider.getByRole('button', { name: 'Send', exact: true }).click();
  await host.getByLabel('1 unread chat messages').waitFor();
  await shot(host, '10-dash-chat-bubble');
  step('dashboard shows a chat bubble with the unread count');

  // --- names in the list --------------------------------------------------------
  const titles = async () => host.locator('.item .what').allInnerTexts();
  if ((await titles()).join('|') !== 'Dana') throw new Error(`expected the row to be titled with the rider's name, got: ${(await titles()).join('|')}`);
  await shot(host, '10b-dash-named-row');

  const openAnonymous = async (text) => {
    const ctx = await browser.newContext(phone);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`anonymous rider: ${e.message}`));
    await page.goto(link);
    await page.getByLabel('How can I pray for you? (optional)').fill(text);
    await page.getByRole('button', { name: 'Send it off' }).click();
    await page.getByText('Sent. Keep this page open').waitFor();
    return page;
  };
  const eraseFromRider = async (page) => {
    await page.getByRole('button', { name: 'Erase now' }).click();
    await page.getByRole('button', { name: 'Tap again to erase everything' }).click();
    await page.getByRole('heading', { name: 'Nothing is here.' }).waitFor();
  };
  const row = (title) => host.locator('.item', { has: host.locator('.what', { hasText: new RegExp(`^${title}$`) }) });

  // Riders who give no name become "Anonymous 1", "Anonymous 2", ...
  const anon1 = await openAnonymous('Please pray for my family');
  await row('Anonymous 1').waitFor();
  const anon2 = await openAnonymous('Please pray for my health');
  await row('Anonymous 2').waitFor();
  await shot(host, '10c-dash-anonymous-rows');

  // A chat message on an anonymous page is unread, and looking up names must not mark it read.
  await anon1.getByRole('button', { name: 'Start a chat' }).click();
  await anon1.getByLabel('Message').fill('Hello from a stranger');
  await anon1.getByRole('button', { name: 'Send', exact: true }).click();
  await row('Anonymous 1').getByLabel('1 unread chat messages').waitFor();
  await host.reload();
  await row('Anonymous 1').getByLabel('1 unread chat messages').waitFor();
  await row('Dana').waitFor();
  await row('Anonymous 2').waitFor();
  if ((await titles()).length !== 3) throw new Error(`expected three rows after a reload, got: ${(await titles()).join('|')}`);

  // Numbers are never reused: after Anonymous 1 erases, the next newcomer is Anonymous 3.
  await eraseFromRider(anon1);
  await host.getByText('Anonymous 1').waitFor({ state: 'detached' });
  const anon3 = await openAnonymous('Please pray for my job');
  await row('Anonymous 3').waitFor();
  const detailTitles = await titles();
  if (!detailTitles.includes('Anonymous 2') || detailTitles.includes('Anonymous 1')) throw new Error(`unexpected rows: ${detailTitles.join('|')}`);

  // The detail view carries the same title.
  await row('Anonymous 3').click();
  await host.getByRole('heading', { name: 'Anonymous 3' }).waitFor();
  await host.getByText('Please pray for my job').waitFor();
  await host.getByRole('button', { name: '← Back' }).click();

  await eraseFromRider(anon2);
  await eraseFromRider(anon3);
  await host.getByText('Anonymous 2').waitFor({ state: 'detached' });
  await host.getByText('Anonymous 3').waitFor({ state: 'detached' });
  step('list rows are titled with the rider\'s name, or "Anonymous N" with numbers that only go up and survive a reload');

  // --- pause and bookmark -------------------------------------------------------
  await rider.getByRole('button', { name: /Pause/ }).click();
  await rider.getByText(/erases itself in 2[45] h/).waitFor();
  await host.getByText(/erases in 2[45] h/).waitFor();
  await rider.goto('about:blank');
  await rider.goto(pageUrl);
  await rider.getByText(SECRET).waitFor();
  await rider.getByText('Of course. I am right here.').waitFor();
  if ((await rider.locator('.toast').count()) !== 0) throw new Error('the prayer was announced again after a reload');
  step('pause adds a day; the bookmarked address reopens the page without repeating the toast');

  // Scanning the hat again returns to the same page instead of starting another.
  await rider.goto('about:blank');
  await rider.goto(link);
  await rider.getByText(SECRET).waitFor();
  if (rider.url() !== pageUrl) throw new Error('second scan opened a different page');
  step('scanning again returns to the same page');

  // A prayer that happened while the rider was away is announced once on return, then goes away by itself.
  const pageId = pageUrl.match(/\/p\/([^#]+)/)[1];
  await rider.evaluate((key) => localStorage.removeItem(key), `mps-seen:${pageId}`);
  await rider.mouse.move(5, 600); // keep the pointer off the toast: hovering holds it open
  await rider.goto('about:blank');
  await rider.goto(pageUrl);
  await rider.locator('.toast').getByText('I prayed for you at').waitFor();
  await rider.locator('.toast').waitFor({ state: 'hidden', timeout: 18000 });
  await rider.reload();
  await rider.getByText(SECRET).waitFor();
  await rider.waitForTimeout(500);
  if ((await rider.locator('.toast').count()) !== 0) throw new Error('the toast came back after it had been seen');
  step('on return the toast appears once, disappears by itself after about 15 seconds, and does not come back');

  // --- privacy ----------------------------------------------------------------
  const code = link.split('#k=')[1];
  const all = sent.join('\n');
  for (const [what, value] of [['hat key', code], ['page key', pageKey], ['request text', SECRET], ['name', 'Dana'], ['chat text', 'Could we talk']]) {
    if (all.includes(value)) throw new Error(`the rider's browser sent the ${what} over the network`);
  }
  if (!all.includes('/api/sessions')) throw new Error('request capture is not working');
  const foreign = riderUrls.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:') && u !== 'about:blank');
  if (foreign.length) throw new Error(`the rider's browser contacted other sites: ${foreign.join(', ')}`);
  step(`privacy: ${sent.length} rider requests inspected, no key or plaintext in any of them`);

  // --- erase --------------------------------------------------------------------
  await shot(rider, '11-rider-full');
  await rider.getByRole('button', { name: 'Erase now' }).click();
  await rider.getByRole('button', { name: 'Tap again to erase everything' }).click();
  await rider.getByRole('heading', { name: 'Nothing is here.' }).waitFor();
  await host.getByText('Waiting for you (0)').waitFor();
  await rider.goto('about:blank');
  await rider.goto(pageUrl);
  await rider.getByRole('heading', { name: 'Nothing is here.' }).waitFor();
  step('erase removes the page for both sides; the old address shows nothing');

  // --- the dashboard survives a reload (keys in IndexedDB, cookie login) ---------
  // Wait until the dashboard's live connection is open before dropping the login, so the
  // connection is not attempted without a cookie (which would log an expected 401).
  const live = host
    .waitForEvent('websocket', { predicate: (ws) => ws.url().includes('/api/host/ws') })
    .then((ws) => ws.waitForEvent('framesent'));
  await host.reload();
  await host.getByRole('switch').waitFor();
  await live;
  await hostCtx.clearCookies();
  await host.reload();
  await host.getByRole('switch').waitFor();
  step('dashboard reopens, and signs itself back in with its key when the login lapses');

  if (errors.length) throw new Error(`browser errors:\n${errors.join('\n')}`);
  console.log('\nAll end-to-end checks passed.');
} catch (err) {
  console.error(`\n✗ ${err.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  stop();
}
