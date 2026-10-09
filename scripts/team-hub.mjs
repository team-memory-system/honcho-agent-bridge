// The team, from this computer's side: making it (once, on the admin's first
// computer), and what the app asks the team hub.
//
// Making a team (`team make`) needs the admin's Cloudflare API token once. It finds
// the zone, the Zero Trust team and its Google login, keeps the people list (the
// reusable "Team Memory people" policy: the roster every server's Access checks),
// makes the hub's Access app (open to any Google login, so the hub can tell someone
// which email it saw and that it is not on the list) and its guard app (<hub>/guard,
// which Access lets through for members' servers and their guard tokens), and
// deploys the hub Worker (cloudflare-workers.mjs) at https://team.<zone>. What it
// made is added to team-access.json beside what sharing keeps there; the token stays
// in <runtime>/cloudflare/api-token and, as a secret, in the hub, which uses it to
// make each member's server address.
//
// Everything else is a request to the hub over HTTPS with this computer's team login
// (team-auth.mjs): who this is, the team's people and servers, a server address for
// this computer, requests between members and their answers, and the admin's roster.
// The hub decides who may do what; nothing here is trusted for that.
import os from "node:os";

import {
  accessTeamDomain,
  ensureAccessApp,
  ensureBypassPolicy,
  ensureEveryonePolicy,
  ensurePeoplePolicy,
  hubAppBody,
  hubGuardAppBody,
  normalizeEmail,
} from "./cloudflare-api.mjs";
import { deployHub, hubModules, HUB_SCRIPT, workersClient } from "./cloudflare-workers.mjs";
import { chooseIdp, chooseZone } from "./share-manager.mjs";
import { readTeamAuth, setTeam, teamHost, teamJson } from "./team-auth.mjs";
import {
  API_BASE_ENV,
  ownerClient,
  privateFileOptionsFrom,
  readTeamState,
  saveApiToken,
  teamAccessPaths,
  validName,
  withTeamAccessLock,
  writeTeamState,
} from "./team-access.mjs";

export const DEFAULT_HUB_LABEL = "team";
const MAX_TEAM_NAME = 60;

function failure(error) {
  return {
    ok: false,
    error: String(error?.message || error),
    // Cloudflare has more than one zone or Google login and none was named: which ones.
    ...(error?.choose ? { choose: error.choose, choices: error.choices } : {}),
  };
}

function apiBase(options) {
  if (options.apiBaseUrl) return options.apiBaseUrl;
  const fromEnv = String((options.env || process.env)[API_BASE_ENV] || "").trim();
  try {
    if (fromEnv && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(fromEnv).hostname)) return fromEnv;
  } catch {}
  return undefined;
}

/** This computer's name as the team sees it: what the hub and a gate call it. */
export function computerName() {
  const name = os.hostname().replace(/\.local$/i, "").replace(/[^\w .-]/g, "").trim();
  return (name || "computer").slice(0, 64);
}

// ------------------------------------------------------------------- make

async function teamMakeUnlocked(paths, options) {
  const name = String(options.name || "").trim();
  if (!name || name.length > MAX_TEAM_NAME) return { ok: false, error: `--name takes the team's name, up to ${MAX_TEAM_NAME} characters` };
  const email = normalizeEmail(options.email);
  if (!email) return { ok: false, error: "--email takes the admin's Google email" };
  const label = String(options.hubLabel || DEFAULT_HUB_LABEL).trim().toLowerCase();
  if (!validName(label)) return { ok: false, error: "--hub takes a short name for the team address: lower-case letters, digits and -, up to 32 characters" };
  const owner = await ownerClient(paths, { env: options.env, apiBaseUrl: options.apiBaseUrl, cloudflareFetch: options.cloudflareFetch });
  if (!owner.ok) return owner;
  const { client } = owner;
  const previous = (await readTeamState(paths)) || {};
  try {
    const zone = await chooseZone(client, options.zone, previous.zone);
    const same = previous.accountId === zone.accountId;
    const teamDomain = await accessTeamDomain(client, zone.accountId);
    const idp = await chooseIdp(client, zone.accountId, String(options.idp || "").trim(), same ? previous.idpId : "");
    const people = await ensurePeoplePolicy(client, zone.accountId, { id: same ? previous.peoplePolicyId : "", add: [email] });
    const everyone = await ensureEveryonePolicy(client, zone.accountId, { id: same ? previous.everyonePolicyId : "" });
    const hubHost = `${label}.${zone.name}`;
    const hubApp = await ensureAccessApp(client, zone.accountId, hubAppBody({ host: hubHost, idpId: idp.id, policyId: everyone.id }), {
      id: same && previous.hub?.host === hubHost ? previous.hub.appId : "",
    });
    if (!hubApp.aud) throw new Error(`Cloudflare returned no AUD tag for the Access app on ${hubHost}`);
    // <hubHost>/guard passes Access: members' servers ask it with a guard token.
    const sameHub = same && previous.hub?.host === hubHost;
    const bypass = await ensureBypassPolicy(client, zone.accountId, { id: same ? previous.bypassPolicyId : "" });
    const guardApp = await ensureAccessApp(client, zone.accountId, hubGuardAppBody({ host: hubHost, policyId: bypass.id }), {
      id: sameHub ? previous.hub.guardAppId : "",
    });
    const team = {
      name,
      hubHost,
      zone: zone.name,
      zoneId: zone.id,
      accountId: zone.accountId,
      teamDomain,
      idpId: idp.id,
      peoplePolicyId: people.id,
      hubAud: hubApp.aud,
      admins: [email],
    };
    const workers = workersClient({ token: owner.token, baseUrl: apiBase(options), fetchImpl: options.cloudflareFetch || globalThis.fetch });
    const deployed = await deployHub(workers, {
      accountId: zone.accountId,
      zoneId: zone.id,
      hubHost,
      team,
      token: owner.token,
      modules: await (options.hubModules || hubModules)(),
    });
    // The token worked all the way, so it is worth keeping.
    if (owner.source === "env") await saveApiToken(paths, owner.token, privateFileOptionsFrom(options));
    await writeTeamState(paths, {
      ...previous,
      accountId: zone.accountId,
      zoneId: zone.id,
      zone: zone.name,
      teamDomain,
      idpId: idp.id,
      idpName: idp.name,
      ownerEmail: email,
      peoplePolicyId: people.id,
      everyonePolicyId: everyone.id,
      bypassPolicyId: bypass.id,
      teamName: name,
      hub: { host: hubHost, appId: hubApp.id, guardAppId: guardApp.id, aud: hubApp.aud, script: HUB_SCRIPT, deployedAt: new Date().toISOString() },
      ...(same ? {} : { owner: undefined, sharers: {} }),
    }, privateFileOptionsFrom(options));
    return {
      ok: true,
      team: { name, host: hubHost, url: `https://${hubHost}` },
      created: deployed.created,
      next: `Log in at the team address with ${email} (team login), then make this computer's server`,
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Makes the team, or deploys its hub again (a new token, a new version of the hub):
 * the same zone and team domain keep every member and request, which live in the
 * hub's Durable Object.
 */
export async function teamMake(options = {}) {
  const paths = teamAccessPaths(options);
  try {
    return await withTeamAccessLock(paths, "team-make", () => teamMakeUnlocked(paths, options));
  } catch (error) {
    return failure(error);
  }
}

/** The team this computer made, if it did: names only, never the token. */
export async function madeTeam(options = {}) {
  const state = await readTeamState(teamAccessPaths(options));
  if (!state?.hub?.host) return null;
  return {
    name: state.teamName || "",
    host: state.hub.host,
    zone: state.zone || "",
    ownerEmail: state.ownerEmail || "",
    deployedAt: state.hub.deployedAt || null,
  };
}

// -------------------------------------------------------------- the hub

/** A request to this computer's team hub with its team login. */
export async function hubCall(method, apiPath, body, { paths, fetchImpl } = {}) {
  const auth = await readTeamAuth(paths);
  if (!auth.hub) throw Object.assign(new Error("This computer has not joined a team yet"), { code: "no_team" });
  return teamJson(`https://${auth.hub}${apiPath}`, { method, body, paths, fetchImpl, device: false });
}

/**
 * After the hub login: who the hub says this is, kept with the team's address. A
 * member gets a peer name the first time (the one this computer already uses, else
 * one made from the email).
 */
export async function teamWhoami({ hub, peer, paths, fetchImpl }) {
  const host = teamHost(hub);
  if (!host) throw new Error("The team address is not a host name");
  await setTeam({ hub: host }, { paths });
  const me = await hubCall("GET", "/api/me", undefined, { paths, fetchImpl });
  if (me.member && !me.peer) {
    const named = await hubCall("POST", "/api/me", peer ? { peer } : {}, { paths, fetchImpl }).catch(async (error) => {
      // Someone else in the team already has this computer's peer name: take one
      // made from the email instead.
      if (error.code === "peer_taken" && peer) return hubCall("POST", "/api/me", {}, { paths, fetchImpl });
      throw error;
    });
    me.peer = named.peer;
  }
  await setTeam({ hub: host, email: me.email, peer: me.peer || null, admin: Boolean(me.admin), name: me.team?.name || null }, { paths });
  return me;
}
