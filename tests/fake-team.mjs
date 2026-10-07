// A stand-in for what a team sits behind, for the app's side of the tests: Cloudflare
// Access with Managed OAuth (client registration, the browser login, tokens and
// their refresh) in front of the team's hosts. It is a fetch function, so nothing
// listens and nothing reaches the network: `fetch(url, init)` answers for
// https://<issuer>/cdn-cgi/access/oauth/* and for every host in `hosts`, whose
// handler gets the request with the email Access saw, the way an origin gets it
// from Cf-Access-Jwt-Assertion.
import crypto from "node:crypto";

export const ISSUER_HOST = "example-team.cloudflareaccess.com";

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * `hosts` maps a host name to `{ app, handle(request, { email, url }) }`; `app` names
 * the Access application ("hub" or "servers"): a token from one app works on every
 * host of that app and on no other. `people` is who may log in to each app.
 */
export function fakeTeam({ hosts = {}, people = { hub: null, servers: null }, tokenSeconds = 900 } = {}) {
  const state = {
    clients: new Map(),
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    // Who logs in at the next browser login, and whether they agree.
    loginAs: "me@example.com",
    refuseLogin: false,
    requests: [],
    registrations: 0,
    refreshes: 0,
    now: () => Date.now(),
  };

  const appOfResource = (resource) => {
    try { return hosts[new URL(resource).hostname]?.app || null; } catch { return null; }
  };

  function issue(app, email, clientId) {
    const accessToken = `oauth:${crypto.randomBytes(12).toString("hex")}`;
    const refreshToken = `refresh-${crypto.randomBytes(12).toString("hex")}`;
    state.access.set(accessToken, { app, email, expiresAt: state.now() + tokenSeconds * 1000 });
    state.refresh.set(refreshToken, { app, email, clientId });
    return { access_token: accessToken, token_type: "Bearer", expires_in: tokenSeconds, refresh_token: refreshToken };
  }

  /** What the browser does after it opens the authorization address: log in, come back with a code. */
  function browserLogin(authorizeUrl) {
    const url = new URL(authorizeUrl);
    const params = url.searchParams;
    const redirect = new URL(params.get("redirect_uri"));
    const client = state.clients.get(params.get("client_id"));
    if (!client || !client.redirectUris.includes(params.get("redirect_uri"))) throw new Error("unknown client or redirect");
    const app = appOfResource(params.get("resource"));
    const allowed = people[app];
    if (state.refuseLogin || (allowed && !allowed.includes(state.loginAs))) {
      redirect.search = new URLSearchParams({ error: "access_denied", state: params.get("state") }).toString();
      return redirect.toString();
    }
    const code = crypto.randomBytes(8).toString("hex");
    state.codes.set(code, {
      app,
      email: state.loginAs,
      clientId: params.get("client_id"),
      redirectUri: params.get("redirect_uri"),
      challenge: params.get("code_challenge"),
      resource: params.get("resource"),
    });
    redirect.search = new URLSearchParams({ code, state: params.get("state") }).toString();
    return redirect.toString();
  }

  async function handleIssuer(url, request) {
    const path = url.pathname.replace("/cdn-cgi/access/oauth/", "");
    if (path === "registration") {
      const body = await request.json();
      state.registrations += 1;
      const clientId = `client-${crypto.randomBytes(6).toString("hex")}`;
      state.clients.set(clientId, { redirectUris: body.redirect_uris || [], name: body.client_name });
      return json(201, { client_id: clientId, redirect_uris: body.redirect_uris });
    }
    if (path === "token") {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "authorization_code") {
        const code = state.codes.get(form.get("code"));
        state.codes.delete(form.get("code"));
        const challenge = crypto.createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
        if (!code || code.clientId !== form.get("client_id") || code.redirectUri !== form.get("redirect_uri") || code.challenge !== challenge) {
          return json(400, { error: "invalid_grant" });
        }
        return json(200, issue(code.app, code.email, code.clientId));
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes += 1;
        const known = state.refresh.get(form.get("refresh_token"));
        if (!known || known.clientId !== form.get("client_id")) return json(400, { error: "invalid_grant" });
        // Rotated, as Access may do: the old refresh token is spent.
        state.refresh.delete(form.get("refresh_token"));
        return json(200, issue(known.app, known.email, known.clientId));
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (path === "revoke") return json(200, {});
    return json(404, { error: "not_found" });
  }

  const fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    state.requests.push({ method: request.method, url: url.toString(), headers: Object.fromEntries(request.headers) });
    if (url.hostname === ISSUER_HOST) return handleIssuer(url, request);
    const host = hosts[url.hostname];
    if (!host) throw new TypeError(`fetch failed: ${url.hostname} is not a host of this fake`);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const base = `https://${ISSUER_HOST}/cdn-cgi/access/oauth`;
      return json(200, {
        issuer: `https://${ISSUER_HOST}`,
        authorization_endpoint: `${base}/authorization`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/registration`,
        revocation_endpoint: `${base}/revoke`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "")?.[1];
    const token = bearer ? state.access.get(bearer) : null;
    if (!token || token.app !== host.app || token.expiresAt <= state.now()) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="https://${url.hostname}/.well-known/cloudflare-access-protected-resource"` },
      });
    }
    return host.handle(request, { email: token.email, url });
  };

  return { fetch, state, browserLogin, issue };
}
