// Prints a fresh VAPID key pair for Web Push.
const b64u = (b) => Buffer.from(b).toString('base64url');
const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const pub = await crypto.subtle.exportKey('raw', keys.publicKey);
const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
console.log(`VAPID_PUBLIC_KEY=${b64u(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
