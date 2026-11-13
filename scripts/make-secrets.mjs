// Creates .secrets.json for the first deploy: a random setup code and a fresh Web Push key pair.
//
//   npm run secrets -- https://your-address.example
//
// The file is passed to `wrangler deploy --secrets-file .secrets.json` and should be deleted afterwards.
// Only the setup code is printed. The private key never leaves the file.

import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const FILE = '.secrets.json';
const args = process.argv.slice(2);
const force = args.includes('--force');
const subject = args.find((a) => a.startsWith('https://') || a.startsWith('mailto:'));

if (!subject) {
  console.error('Give the public address of the site (it goes to push services as a contact), for example:');
  console.error('  npm run secrets -- https://gopray.example.org');
  process.exit(1);
}
if (existsSync(FILE) && !force) {
  console.error(`${FILE} already exists. Delete it, or add --force to replace it.`);
  process.exit(1);
}

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const publicKey = b64u(await crypto.subtle.exportKey('raw', keys.publicKey));
const privateKey = (await crypto.subtle.exportKey('jwk', keys.privateKey)).d;
const setupCode = b64u(randomBytes(18));

writeFileSync(
  FILE,
  JSON.stringify({ SETUP_TOKEN: setupCode, VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject }),
  { mode: 0o600 },
);

console.log(`Wrote ${FILE} (setup code, notification keys, contact ${subject}).`);
console.log('');
console.log(`Your setup code: ${setupCode}`);
console.log('Keep it: you need it once, to create your station. Then delete it from Cloudflare.');
