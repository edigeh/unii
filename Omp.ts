// Omp
// ===
// The sign-ins of oh-my-pi (omp), read from its database (config `omp`,
// default ~/.omp/agent/agent.db), so a server runs on the plans its owner
// already signed in to there: a ChatGPT plan (codex) by OAuth, OpenCode Go
// by its key. Each call reads the newest enabled credential of its
// provider; of ChatGPT accounts, the one whose plan is best (PLANS), or
// config `codex`: the email of the one to use.
// An OAuth token near its end is refreshed here, once at a time, and
// written back to its row only if omp didn't refresh it meanwhile (a
// refresh token works once: whoever loses the race reads the winner's),
// so omp and this server share one sign-in.

import { Database } from "bun:sqlite";
import * as config from "./Config.ts";

// Types
// =====

type Row = { id: number; data: string };

// Constants
// =========

const PATH = config.config_path(config.config_get("omp", "~/.omp/agent/agent.db"));

const ACCOUNT = config.config_get("codex", "").trim().toLowerCase();

const TOKEN  = "https://auth.openai.com/oauth/token";
const CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";

// ChatGPT plans, worst first; one not listed ranks below them all
const PLANS = ["free", "go", "plus", "team", "business", "enterprise", "edu", "prolite", "pro"];

// refresh a token with less than this left, in ms
const EARLY = 5 * 60e3;

// the refresh under way, if any
let REFRESH: Promise<string> | null = null;

// Omp
// ===

export namespace Omp {

  function db(): Database {
    return new Database(PATH, { readwrite: true, create: false });
  }

  // the newest enabled credential of a provider (and, for codex, of its
  // account, if set)
  function row(provider: string, account = ""): Row {
    const d = db();
    try {
      const rows = d.query("select id, data, identity_key from auth_credentials where provider = ? and disabled_cause is null order by updated_at desc, id desc").all(provider) as Array<Row & { identity_key: string | null }>;
      const ok = rows.filter((r) => !account || String(r.identity_key ?? "").toLowerCase().includes("email:" + account));
      const rank = (r: Row) => provider === "openai-codex" ? PLANS.indexOf(Omp.plan(JSON.parse(r.data).access)) : 0;
      const hit = ok.sort((a, b) => rank(b) - rank(a))[0];
      if (hit === undefined) {
        throw new Error("no " + provider + " sign-in in omp (" + PATH + ")" + (account ? " for " + account : "") + ": run omp and sign in");
      }
      return hit;
    } finally {
      d.close();
    }
  }

  // an API key omp keeps (opencode-go)
  export function key(provider: string): string {
    const key = JSON.parse(row(provider).data).key;
    if (typeof key !== "string" || key === "") {
      throw new Error("omp's " + provider + " credential has no key");
    }
    return key;
  }

  // a ChatGPT access token, fresh for a while
  export async function codex(): Promise<string> {
    const data = JSON.parse(row("openai-codex", ACCOUNT).data);
    if (data.expires - Date.now() > EARLY) {
      return data.access;
    }
    REFRESH ??= Omp.refresh().finally(() => (REFRESH = null));
    return REFRESH;
  }

  export async function refresh(): Promise<string> {
    const old = row("openai-codex", ACCOUNT);
    const data = JSON.parse(old.data);
    const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: data.refresh, client_id: CLIENT });
    const init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(15e3) };
    const res = await fetch(TOKEN, init);
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof out.access_token !== "string") {
      // omp may have refreshed it first, spending the refresh token
      const now = JSON.parse(row("openai-codex", ACCOUNT).data);
      if (now.access !== data.access && now.expires - Date.now() > EARLY) {
        return now.access;
      }
      throw new Error("ChatGPT sign-in refresh failed (HTTP " + res.status + "): sign in again in omp");
    }
    const next = { ...data, access: out.access_token, refresh: out.refresh_token ?? data.refresh, expires: Date.now() + Number(out.expires_in ?? 3600) * 1e3 };
    const d = db();
    try {
      const sql = "update auth_credentials set data = ?, updated_at = cast(strftime('%s','now') as integer) where id = ? and data = ?";
      const done = d.query(sql).run(JSON.stringify(next), old.id, old.data);
      if (done.changes === 0) {
        return JSON.parse(row("openai-codex", ACCOUNT).data).access;
      }
    } finally {
      d.close();
    }
    return next.access;
  }

  // the ChatGPT account a token is for, and its plan, from its claims
  export function account(token: string): string {
    return Omp.claims(token).chatgpt_account_id ?? "";
  }

  export function plan(token: string): string {
    return Omp.claims(token).chatgpt_plan_type ?? "";
  }

  export function claims(token: string): any {
    try {
      return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))["https://api.openai.com/auth"] ?? {};
    } catch {
      return {};
    }
  }

}
