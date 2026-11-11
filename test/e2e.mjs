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
const server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--var', 'SETUP_TOKEN:e2e-setup'], {
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
  step('intercessor creates a station');

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
  await rider.getByRole('heading', { name: "Hi there, I'm Sam." }).waitFor();
  await rider.waitForURL(/\/p\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);
  const pageUrl = rider.url();
  const pageKey = pageUrl.split('#')[1];
  await shot(rider, '04-rider-landing');
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
  await host.getByText('New request').click();
  await host.getByText(SECRET).waitFor();
  await host.getByRole('heading', { name: 'Dana' }).waitFor();
  await shot(host, '07-dash-detail');
  await host.getByRole('button', { name: "I've prayed for this" }).click();
  await host.getByText('They can see this on their page').waitFor();
  await rider.getByText('I prayed for you at').waitFor();
  await shot(rider, '08-rider-prayed');
  step('intercessor decrypts, prays, and the rider sees it without reloading');

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

  // --- pause and bookmark -------------------------------------------------------
  await rider.getByRole('button', { name: /Pause/ }).click();
  await rider.getByText(/erases itself in 2[45] h/).waitFor();
  await host.getByText(/erases in 2[45] h/).waitFor();
  await rider.goto('about:blank');
  await rider.goto(pageUrl);
  await rider.getByText(SECRET).waitFor();
  await rider.getByText('Of course. I am right here.').waitFor();
  step('pause adds a day; the bookmarked address reopens the page');

  // Scanning the hat again returns to the same page instead of starting another.
  await rider.goto('about:blank');
  await rider.goto(link);
  await rider.getByText(SECRET).waitFor();
  if (rider.url() !== pageUrl) throw new Error('second scan opened a different page');
  step('scanning again returns to the same page');

  // --- privacy ----------------------------------------------------------------
  const code = link.split('#k=')[1];
  const all = sent.join('\n');
  for (const [what, value] of [['hat key', code], ['page key', pageKey], ['request text', SECRET], ['name', 'Dana'], ['chat text', 'Could we talk']]) {
    if (all.includes(value)) throw new Error(`the rider's browser sent the ${what} over the network`);
  }
  if (!all.includes('/api/sessions')) throw new Error('request capture is not working');
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
  await host.reload();
  await host.getByRole('switch').waitFor();
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
