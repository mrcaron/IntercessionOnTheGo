# Mobile Prayer Station

A rider scans the QR code on your hat, lands on a private page, and can share a
name, a prayer request, or chat with you anonymously. You get a notification,
pray, and tap 🙏; their page updates at once. Each page erases itself after one
hour unless the rider presses pause (each press adds 24 hours, at most 3 times and never past 72 hours in all).

## Demo

[![Watch the demo: a rider scans the hat, sends a request, and sees it prayed for](docs/demo-poster.png)](https://youtu.be/otHNt3nmBQg)

Watch a rider scan the hat, send a request, and see it prayed for live.

## Made for prayer and mission

<p align="center">
  <a href="https://www.24-7prayer.com"><img src="docs/logo-24-7-prayer.png" alt="24-7 Prayer" width="280"></a>
  &nbsp;&nbsp;
  <a href="https://orderofthemustardseed.com"><img src="docs/logo-order-of-the-mustard-seed.png" alt="Order of the Mustard Seed" width="280"></a>
</p>

Mobile Prayer Station is a personal project by a member of the
[Order of the Mustard Seed](https://orderofthemustardseed.com), a way of working
out the vows of Prayer and Mission, within the wider
[24-7 Prayer](https://www.24-7prayer.com) movement.

It is an independent project and not an official project of 24-7 Prayer or the
Order of the Mustard Seed.

## How it keeps its promises

- **Only the two of you can read it.** The rider's phone makes a random page
  key and locks it with the public key printed in your QR code. Requests and
  chat are encrypted with that page key before they leave either phone. The
  server stores ciphertext plus timing and status (opened / requested / prayed).
- **Zero record.** Each page is its own Durable Object. When its alarm fires it
  calls `deleteAll()`, and the address then answers exactly like one that never
  existed. Request logging is off and there are no analytics or third-party
  scripts.
- **"Praying for you right now" is true.** Pages can only be opened while your
  dashboard's on-duty switch is on (it turns itself off after 2 hours).

Limits worth knowing: the server can still see that a page exists and when; as
with any website, the encryption relies on the site serving honest code; and
Cloudflare's own storage backups are outside this app's control (anything in
them is ciphertext).

## Run it locally

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run vapid >> .dev.vars
```

```bash
npm run dev
```

Open `http://localhost:8787/dash`, use the setup code `dev-setup` (from
`.dev.vars`), switch on duty, then open the hat link shown under Settings in a
second browser window.

```bash
npm test
```

```bash
npm run e2e
```

`npm test` covers the encryption, the server rules and self-destruct.
`npm run e2e` drives a rider phone and your phone through the whole journey in
real browsers.

## Deploy to Cloudflare

You need a Cloudflare account. To serve the app from your own address, that
domain must be a zone on the same account. The address is set in
`wrangler.jsonc` under `routes` (it is `gopray.greenhouse247.org` there now);
without `routes`, Cloudflare gives the app a free `workers.dev` address instead.

### Automatic deploys (recommended)

Connect the repository to Cloudflare once, and every push to `main` is built and
deployed with no manual step (Cloudflare calls this Workers Builds).

1. In the Cloudflare dashboard, go to **Workers & Pages**, choose **Create
   application**, then **Import a repository**, pick GitHub and select this
   repository. You authorise Cloudflare's GitHub app in your browser.
2. Settings for the new Worker:
   - **Worker name:** `prayer-station`. It must match `name` in
     `wrangler.jsonc`, or the build fails.
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy` (the default)
   - **Production branch:** `main`
3. Under **Settings → Build → Branch control**, turn off **Enable Preview
   Builds**, so other branches do not build previews of the app.
4. Let the first build run. The app is live, but with no secrets yet, so no
   station can be created and notifications are off.
5. Add the secrets. On your own computer, create a random setup code and fresh
   notification keys, with your site's address as the contact for push services.
   This writes `.secrets.json` and prints only the setup code, which you keep:

   ```bash
   npm install
   ```

   ```bash
   npm run secrets -- https://gopray.greenhouse247.org
   ```

   Then upload them, either by signing in and sending the file:

   ```bash
   npx wrangler login
   ```

   ```bash
   npx wrangler secret bulk .secrets.json
   ```

   or by adding each of the four values from `.secrets.json` as a **secret** under
   the Worker's **Settings → Variables & Secrets** (not as a build variable,
   which the running app cannot see). Delete `.secrets.json` afterwards:

   ```bash
   rm .secrets.json
   ```

Cloudflare keeps secrets across later deploys. Builds only compile and deploy:
they do not run the tests, so run `npm test` before merging. To undo a bad
deploy, roll back from the Worker's **Deployments** tab.

### Deploy by hand (alternative)

Run these on your own computer (the static files upload needs your own sign-in):

1. Create the secrets file, as in step 5 above:

   ```bash
   npm install
   ```

   ```bash
   npm run secrets -- https://gopray.greenhouse247.org
   ```

2. Sign in to Cloudflare in the browser:

   ```bash
   npx wrangler login
   ```

3. Deploy, uploading the secrets with the code, then delete the secrets file:

   ```bash
   npm run deploy -- --secrets-file .secrets.json
   ```

   ```bash
   rm .secrets.json
   ```

### After the first deploy

1. On the phone you will carry, open `https://<your-address>/dash`, enter your
   name and the setup code. On iPhone, first use Share → Add to Home Screen and
   open it from the new icon, otherwise notifications cannot work.
2. In Settings: turn on notifications, download a key backup, and download the
   QR code for your hat.
3. Remove the setup code so nobody else can create a station: delete
   `SETUP_TOKEN` under **Settings → Variables & Secrets**, or run:

   ```bash
   npx wrangler secret delete SETUP_TOKEN
   ```

## Layout

```
src/shared/crypto.ts     key wrapping, encryption, login signatures, backup
src/worker/index.ts      HTTP routes
src/worker/session-do.ts one prayer page: ciphertext, alarm, live updates
src/worker/station-do.ts the intercessor: profile, duty, login, index, push
src/worker/webpush.ts    Web Push (VAPID + payload encryption)
src/rider/               the page riders see
src/dash/                your dashboard (installable)
test/                    Vitest suite and the browser end-to-end script
```
