// A stand-in for Cloudflare Access in the gate's tests: RSA keys made here, a local
// server for the team's signing keys, and assertions signed the way Access signs
// its Cf-Access-Jwt-Assertion. Nothing reaches the network.
import crypto from "node:crypto";
import http from "node:http";

export const ACCESS_TEAM_DOMAIN = "gate-test.example";
export const ACCESS_ISSUER = `https://${ACCESS_TEAM_DOMAIN}`;
export const ACCESS_AUD = "aud-gate-test-0000";
export const PERSON_EMAIL = "teammate@example.com";

/** An RS256 signing key with its key id. */
export function accessKey(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function segment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Claims as Access puts them in a person's application token, with `overrides` on top. */
export function personClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [ACCESS_AUD],
    email: PERSON_EMAIL,
    exp: now + 300,
    iat: now,
    nbf: now,
    iss: ACCESS_ISSUER,
    type: "app",
    identity_nonce: "nonce-0000",
    sub: "00000000-0000-0000-0000-000000000000",
    country: "XX",
    ...overrides,
  };
}

/** A signed assertion. `header` overrides the JWT header; `kid` defaults to the key's own. */
export function signAssertion(key, claims, header = {}) {
  const head = segment({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const body = segment(claims);
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

/**
 * The team's certs endpoint. `keys` is the list it serves and may be changed
 * between requests; `fetches` counts how often it was asked.
 */
export async function startAccessCerts(keys) {
  const state = { keys, fetches: 0, server: null, url: "" };
  state.server = http.createServer((req, res) => {
    state.fetches += 1;
    const body = JSON.stringify({ keys: state.keys.map((key) => key.jwk) });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    state.server.once("error", reject);
    state.server.listen(0, "127.0.0.1", resolve);
  });
  state.url = `http://127.0.0.1:${state.server.address().port}/cdn-cgi/access/certs`;
  state.close = () => new Promise((resolve) => {
    state.server.closeAllConnections?.();
    state.server.close(() => resolve());
  });
  return state;
}
