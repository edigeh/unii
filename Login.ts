// Login
// =====
// Unii's own sign-ins, kept here and not read from omp (Omp.ts is asked
// only when unii has none of its own). Two providers, as omp's auth rules:
// openai-codex (ChatGPT Plus/Pro, OAuth) runs codex; opencode-go (its API
// key) runs opencode-go. The OAuth flow is PKCE (S256) with the public
// client its CLI signs in with, and the authorize page opened in the
// browser; the browser ends on a redirect URL nothing answers, and that URL
// (or the code in it) is pasted back here. So nothing listens: the harness
// still opens no port and no socket (Harness.test.ts), over ssh too. What
// is signed in is kept in DIR/auth.json (0600, replaced whole, one entry
// per provider), the OAuth token refreshed EARLY before it ends, one
// refresh at a time, written back. A sign-in whose refresh token stops
// working says so: /login again.

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as config from "./Config.ts";

// Types
// =====

// what unii can sign in to
export type Provider = "openai-codex" | "opencode-go";

// a sign-in: an OAuth token (access, refresh, when it ends in ms) or a key,
// the account it is (email, workspace, plan)
export type Credential = {
  access?  : string;
  refresh? : string;
  expires? : number;
  key?     : string;
  email?   : string;
  account? : string;
  plan?    : string;
};

// what /login opened: the page to open in the browser, what to paste back,
// and the paste exchanged; submit throws, saying why, on something it
// can't use and may be tried again
export type Flow = { url: string; prompt: string; submit: (text: string) => Promise<Credential> };

// a provider, as /login lists it
export type Spec = { id: Provider; name: string; kind: "oauth" | "key"; hint: string };

// Constants
// =========

// refresh a token with less than this left, in ms
const EARLY = 5 * 60e3;

const FILE = config.DIR + "/auth.json";

// the OAuth client ChatGPT signs in with
const CODEX = {
  client    : "app_EMoamEEZ73f0CkXaXp7hrann",
  authorize : "https://auth.openai.com/oauth/authorize",
  token     : "https://auth.openai.com/oauth/token",
  redirect  : "http://localhost:1455/auth/callback",
  scopes    : ["openid", "profile", "email", "offline_access", "api.connectors.read", "api.connectors.invoke"],
  params    : { id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "unii" },
  read      : (out: any, now: number): Credential => {
    const claims = Login.claims(out.access_token, out.id_token);
    return {
      access  : out.access_token,
      refresh : out.refresh_token ?? "",
      expires : now + (Number(out.expires_in) || 0) * 1000,
      email   : claims.email,
      account : claims.account,
      plan    : claims.plan,
    };
  },
};

// the vendor a provider runs (Pick.ts)
const VENDORS: Record<Provider, "codex" | "opencode-go"> = {
  "openai-codex" : "codex",
  "opencode-go"  : "opencode-go",
};

// the refresh under way
let REFRESH: Promise<string> | null = null;

// Login
// =====

export namespace Login {

  // every provider /login can sign in to
  export const PROVIDERS: Spec[] = [
    { id: "openai-codex", name: "ChatGPT (Plus/Pro)", kind: "oauth", hint: "signs codex in with your browser" },
    { id: "opencode-go",  name: "OpenCode Go",        kind: "key",   hint: "its API key, from opencode.ai/auth" },
  ];

  // the sign-in kept of a provider, if any
  export function credential(id: Provider): Credential | null {
    const kept = Login.read()[id];
    if (kept === null || typeof kept !== "object") {
      return null;
    }
    return typeof (id === "openai-codex" ? kept.access : kept.key) === "string" ? kept : null;
  }

  // whether unii has a sign-in of its own
  export function signed(id: Provider): boolean {
    return Login.credential(id) !== null;
  }

  // the vendor a provider runs
  export function vendor(id: Provider): "codex" | "opencode-go" {
    return VENDORS[id];
  }

  // the account signed in, for a note
  export function who(id: Provider): string {
    const c = Login.credential(id);
    return c?.email ?? c?.plan ?? c?.account ?? PROVIDERS.find((p) => p.id === id)?.name ?? id;
  }

  // a fresh access token of the ChatGPT sign-in, refreshed here if it is
  // near its end; null when unii has no sign-in of its own
  export async function token(): Promise<string | null> {
    const c = Login.credential("openai-codex");
    if (c === null) {
      return null;
    }
    if ((c.expires ?? 0) - Date.now() > EARLY) {
      return c.access!;
    }
    REFRESH ??= Login.refresh(c).finally(() => {
      REFRESH = null;
    });
    return REFRESH;
  }

  // the key of a key provider; null when unii has none
  export function key(id: Provider): string | null {
    return Login.credential(id)?.key ?? null;
  }

  // a key kept as a sign-in
  export function setKey(id: Provider, text: string): Credential {
    const key = text.trim();
    if (key === "") {
      throw new Error("No key in that.");
    }
    return Login.save(id, { key });
  }

  // a sign-in started: the page, what to paste, and the paste exchanged
  export function begin(id: Provider): Flow {
    const spec = PROVIDERS.find((p) => p.id === id)!;
    if (id === "opencode-go") {
      return {
        url    : "https://opencode.ai/auth",
        prompt : spec.hint + ": paste it here",
        submit : async (text) => Login.setKey(id, text),
      };
    }
    const verifier  = randomBytes(96).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state     = randomBytes(16).toString("hex");
    const url       = Login.url(state, challenge);
    let waiting: Promise<Credential> | null = null;
    return {
      url,
      prompt : "paste the authorization code (or the whole redirect URL) here",
      submit : (text) => {
        if (waiting !== null) {
          return waiting;
        }
        const code = Login.parse(text);
        if (code === "") {
          return Promise.reject(new Error("No authorization code in that; paste the code or the whole redirect URL."));
        }
        waiting = Login.exchange(code, verifier).then((c) => Login.save(id, c));
        waiting.catch(() => {
          waiting = null;
        });
        return waiting;
      },
    };
  }

  // the authorization URL: the standard parameters, PKCE, the client's own
  export function url(state: string, challenge: string): string {
    const params = new URLSearchParams({
      client_id             : CODEX.client,
      response_type         : "code",
      redirect_uri          : CODEX.redirect,
      scope                 : CODEX.scopes.join(" "),
      code_challenge        : challenge,
      code_challenge_method : "S256",
      state,
      ...CODEX.params,
    });
    return CODEX.authorize + "?" + params.toString();
  }

  // the code in what was pasted: the code alone or the whole redirect URL;
  // "" when there is none
  export function parse(text: string): string {
    const trimmed = text.trim();
    const url = /^https?:\/\//i.test(trimmed) ? Login.urled(trimmed) : null;
    return url === null ? trimmed : url.searchParams.get("code") ?? "";
  }

  // opens a page in the browser, where there is one (a test's never)
  export function browse(url: string): boolean {
    if (!process.stdout.isTTY) {
      return false;
    }
    const [cmd, ...args] = process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
    try {
      Bun.spawn([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
      return true;
    } catch {
      return false;
    }
  }

  // the code exchanged for a token
  export async function exchange(code: string, verifier: string): Promise<Credential> {
    const res = await Login.post({
      grant_type    : "authorization_code",
      client_id     : CODEX.client,
      code,
      redirect_uri  : CODEX.redirect,
      code_verifier : verifier,
    }).catch((err) => {
      throw new Error("Sign-in failed: " + Login.why(err));
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error("Sign-in failed: " + res.status + " " + text.slice(0, 300));
    }
    const out = Login.json(text);
    if (typeof out?.access_token !== "string" || out.access_token === "") {
      throw new Error("Sign-in failed: the token answer had no access token");
    }
    return CODEX.read(out, Date.now());
  }

  // the token renewed at its end; a sign-in that is over says so
  export async function refresh(c: Credential): Promise<string> {
    if (c.refresh === undefined || c.refresh === "") {
      throw new Error("The openai-codex sign-in has no refresh token: /login openai-codex");
    }
    const res = await Login.post({ grant_type: "refresh_token", client_id: CODEX.client, refresh_token: c.refresh }).catch((err) => {
      throw new Error("The openai-codex sign-in could not be renewed: " + Login.why(err));
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error("The openai-codex sign-in is over (" + res.status + "): /login openai-codex again");
    }
    const out = Login.json(text);
    if (typeof out?.access_token !== "string" || out.access_token === "") {
      throw new Error("The openai-codex sign-in could not be renewed: the token answer had no access token");
    }
    const fresh = CODEX.read(out, Date.now());
    const next: Credential = {
      ...c,
      ...fresh,
      refresh : fresh.refresh === undefined || fresh.refresh === "" ? c.refresh : fresh.refresh,
      plan    : fresh.plan ?? c.plan,
      email   : fresh.email ?? c.email,
      account : fresh.account ?? c.account,
    };
    const kept = Login.credential("openai-codex");
    // a sign-in made meanwhile (another unii) is the one to keep
    if (kept !== null && kept.access !== c.access && (kept.expires ?? 0) > Date.now() + EARLY) {
      return kept.access!;
    }
    Login.save("openai-codex", next);
    return next.access!;
  }

  // the token endpoint asked for a token
  export function post(params: Record<string, string>): Promise<Response> {
    return fetch(CODEX.token, {
      method  : "POST",
      headers : { "content-type": "application/x-www-form-urlencoded" },
      body    : new URLSearchParams(params).toString(),
    });
  }

  // the account an OpenAI token names: its ChatGPT workspace (the plan's
  // pool), its email and its plan type, from the access and id tokens
  export function claims(access: string, id: string | undefined): { account?: string; email?: string; plan?: string } {
    const one = Login.jwt(access);
    const two = id === undefined ? null : Login.jwt(id);
    return {
      account : one?.account ?? two?.account,
      email   : (one?.email ?? two?.email)?.toLowerCase(),
      plan    : (one?.plan ?? two?.plan)?.toLowerCase(),
    };
  }

  export function jwt(token: unknown): { account?: string; email?: string; plan?: string } | null {
    try {
      const payload = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8"));
      const auth = payload["https://api.openai.com/auth"];
      const profile = payload["https://api.openai.com/profile"];
      return { account: auth?.chatgpt_account_id, email: profile?.email, plan: auth?.chatgpt_plan_type };
    } catch {
      return null;
    }
  }

  // what is kept, by provider
  export function read(): Record<string, Credential> {
    try {
      const out = JSON.parse(fs.readFileSync(FILE, "utf8"));
      return out !== null && typeof out === "object" ? out : {};
    } catch {
      return {};
    }
  }

  // one kept whole, written beside itself then moved over it (0600)
  export function save(id: Provider, c: Credential): Credential {
    const all = { ...Login.read(), [id]: c };
    fs.mkdirSync(config.DIR, { recursive: true, mode: 0o700 });
    const tmp = FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return c;
  }

  export function urled(text: string): URL | null {
    try {
      return new URL(text);
    } catch {
      return null;
    }
  }

  export function json(text: string): any {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  export function why(err: unknown): string {
    return String((err as any)?.message ?? err);
  }

  // a signed-in provider's vendor is offered (/model) even when config.json
  // leaves it out: signing in is a choice as much as the config is
  for (const p of PROVIDERS) {
    if (signed(p.id)) {
      config.config_offer(vendor(p.id));
    }
  }

}
