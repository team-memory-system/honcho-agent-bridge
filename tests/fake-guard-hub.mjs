// This computer's team login and a team hub answering POST /api/me/guard, for the
// tests of sharing and starting a server: a team-auth.json holding a hub login that
// has not ended, and a fetch that answers for the hub alone. Nothing reaches the
// network.
import fsp from "node:fs/promises";
import path from "node:path";

import { teamAuthPaths } from "../scripts/team-auth.mjs";

export const HUB_HOST = "team.example.com";
export const GUARD_URL = `https://${HUB_HOST}/guard`;
export const SERVER_HOST = "memory-owner.example.com";
const HUB_LOGIN = "oauth:hub-login-for-tests";

/** The nth guard token the stand-in hub issues: 64 hex digits, plainly not a real one. */
export function fakeGuardToken(n) {
  return n.toString(16).padStart(2, "0").repeat(32);
}

/** The hub's answer with `token` (a new one each time when left out). */
export const guardAnswer = (token, extra = {}) => ({ body: { url: GUARD_URL, token, host: SERVER_HOST, jev: { set: true }, ...extra } });

/**
 * A hub login in `directory` (or, with `login: false`, a team without one) and the
 * hub's fetch. `answer` is { status, body }, an Error to throw (the hub cannot be
 * reached), or a function of the URL returning one; left out, each request is given
 * a new token, as the hub does. `answer(next)` changes it. `seen` lists what reached
 * the hub and `issued` every token handed out.
 */
export async function guardHub(directory, answer = null, { login = true } = {}) {
  const authFile = path.join(directory, "team-auth.json");
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(authFile, JSON.stringify({
    version: 1,
    hub: HUB_HOST,
    email: "owner@example.com",
    me: {},
    logins: login ? {
      hub: {
        accessToken: HUB_LOGIN,
        expiresAt: Date.now() + 3_600_000,
        refreshToken: "refresh-hub-login-for-tests",
        clientId: "client-hub",
        tokenEndpoint: "https://example-team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
        resource: `https://${HUB_HOST}`,
      },
    } : {},
    devices: {},
  }), { mode: 0o600 });
  const seen = [];
  const issued = [];
  let current = answer;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    seen.push({
      method: init.method || "GET",
      url: url.toString(),
      authorization: new Headers(init.headers).get("authorization"),
      ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}),
    });
    if (url.hostname !== HUB_HOST) throw new TypeError(`fetch failed: ${url.hostname} is not the hub`);
    let value = typeof current === "function" ? current(url) : current;
    if (!value) value = guardAnswer(fakeGuardToken(issued.length + 1));
    if (value instanceof Error) throw value;
    if (typeof value.body?.token === "string" && (value.status || 200) === 200) issued.push(value.body.token);
    return Response.json(value.body, { status: value.status || 200 });
  };
  return {
    teamAuth: { paths: teamAuthPaths(null, { HONCHO_AGENT_TEAM_AUTH: authFile }), fetchImpl },
    seen,
    issued,
    login: `Bearer ${HUB_LOGIN}`,
    answer(next) { current = next; },
  };
}
