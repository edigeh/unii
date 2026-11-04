// Login test
// ==========
// `bun test Login.test.ts`. Unii's own sign-ins, with the network and the
// browser stubbed: the authorization URL (PKCE, its client, its scopes),
// the code pasted back (alone or as the whole redirect URL), the token
// exchanged and kept 0600, a key kept, and a token near its end refreshed
// once and written back.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-login-");
process.env.UNII_DIR = DIR;

const { Login } = await import("./Login.ts");

const FILE = DIR + "/auth.json";
const CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT = "http://localhost:1455/auth/callback";

type Call = { url: string; init: any };

let CALLS: Call[] = [];
let ANSWER: (call: Call) => Response = () => new Response("{}", { status: 500 });

const real = globalThis.fetch;

function stub(answer: (call: Call) => Response): void {
  ANSWER = answer;
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { url: String(url), init: init ?? {} };
    CALLS.push(call);
    return ANSWER(call);
  }) as typeof fetch;
}

function jwt(claims: object): string {
  return "x." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".y";
}

const ACCESS = jwt({
  "https://api.openai.com/auth"   : { chatgpt_account_id: "ws-1", chatgpt_plan_type: "pro" },
  "https://api.openai.com/profile": { email: "Someone@Example.com" },
});

function token_answer(extra: object = {}): Response {
  return new Response(JSON.stringify({ access_token: ACCESS, refresh_token: "r", expires_in: 3600, ...extra }), { status: 200, headers: { "content-type": "application/json" } });
}

function form(call: Call): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.init.body));
}

function kept(): any {
  return JSON.parse(fs.readFileSync(FILE, "utf8"));
}

beforeEach(() => {
  CALLS = [];
  try {
    fs.rmSync(FILE);
  } catch {}
});

afterAll(() => {
  globalThis.fetch = real;
});

describe("authorization", () => {
  test("ChatGPT: PKCE, its client, its scopes and flow parameters", () => {
    const flow = Login.begin("openai-codex");
    const url = new URL(flow.url);
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("originator")).toBe("unii");
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.prompt).toContain("authorization code");
  });

  test("OpenCode Go: a key, from its console", () => {
    const flow = Login.begin("opencode-go");
    expect(flow.url).toBe("https://opencode.ai/auth");
    expect(flow.prompt).toContain("key");
  });
});

describe("pasted back", () => {
  test("a code alone or the whole redirect URL", () => {
    expect(Login.parse("  abc123  ")).toBe("abc123");
    expect(Login.parse(REDIRECT + "?code=abc&state=dead")).toBe("abc");
    expect(Login.parse(REDIRECT + "?state=dead")).toBe("");
    expect(Login.parse("nothing?here")).toBe("nothing?here");
  });

  test("the code exchanged and kept 0600, the account named", async () => {
    stub(() => token_answer());
    const c = await Login.begin("openai-codex").submit("the-code");
    expect(c.access).toBe(ACCESS);
    expect(c.email).toBe("someone@example.com");

    const call = CALLS.find((x) => x.url === TOKEN_URL)!;
    const body = form(call);
    expect(body).toMatchObject({
      grant_type   : "authorization_code",
      client_id    : CLIENT,
      code         : "the-code",
      redirect_uri : REDIRECT,
    });
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{128}$/);

    expect(kept()["openai-codex"].access).toBe(ACCESS);
    expect(fs.statSync(FILE).mode & 0o777).toBe(0o600);
    expect(Login.signed("openai-codex")).toBe(true);
    expect(Login.who("openai-codex")).toBe("someone@example.com");
    expect(Login.vendor("openai-codex")).toBe("codex");
  });

  test("the redirect URL pasted whole works alike", async () => {
    stub(() => token_answer());
    const flow = Login.begin("openai-codex");
    const state = new URL(flow.url).searchParams.get("state")!;
    await flow.submit(REDIRECT + "?code=c2&state=" + state);
    expect(form(CALLS[0]).code).toBe("c2");
  });

  test("a refused exchange says why, and may be tried again", async () => {
    stub(() => new Response("invalid_grant", { status: 400 }));
    const flow = Login.begin("openai-codex");
    await expect(flow.submit("bad")).rejects.toThrow(/400 invalid_grant/);
    stub(() => token_answer());
    const c = await flow.submit("good");
    expect(c.access).toBe(ACCESS);
  });

  test("nothing pasted with a code in it says so", async () => {
    await expect(Login.begin("openai-codex").submit(REDIRECT + "?state=x")).rejects.toThrow(/No authorization code/);
  });

  test("Codex: a form body, the account from the token claims", async () => {
    stub(() => token_answer());
    const c = await Login.begin("openai-codex").submit("the-code");
    expect(c.account).toBe("ws-1");
    expect(c.email).toBe("someone@example.com");
    expect(c.plan).toBe("pro");
    expect(CALLS[0].init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(CALLS[0].init.body).toContain("grant_type=authorization_code");
    expect(CALLS[0].init.body).not.toContain("state=");
  });

  test("OpenCode Go: a key kept, trimmed", async () => {
    const c = await Login.begin("opencode-go").submit("  sk-go-1 \n");
    expect(c.key).toBe("sk-go-1");
    expect(Login.key("opencode-go")).toBe("sk-go-1");
    expect(Login.signed("opencode-go")).toBe(true);
    expect(kept()["opencode-go"].key).toBe("sk-go-1");
  });
});

describe("tokens", () => {
  const write = (c: object) => fs.writeFileSync(FILE, JSON.stringify({ "openai-codex": c }), { mode: 0o600 });
  const cred = (expires: number) => ({ access: "old", refresh: "r1", expires });

  test("none kept: none to give", async () => {
    expect(await Login.token()).toBeNull();
    expect(Login.key("opencode-go")).toBeNull();
    expect(Login.signed("codex" as any)).toBe(false);
  });

  test("one far from its end is given as it is", async () => {
    write(cred(Date.now() + 3600e3));
    expect(await Login.token()).toBe("old");
    expect(CALLS.length).toBe(0);
  });

  test("one near its end is refreshed once, written back, and both callers get it", async () => {
    write(cred(Date.now() + 1000));
    stub(() => token_answer({ refresh_token: "r2" }));
    const [a, b] = await Promise.all([Login.token(), Login.token()]);
    expect([a, b]).toEqual([ACCESS, ACCESS]);
    expect(CALLS.length).toBe(1);
    expect(form(CALLS[0])).toEqual({ grant_type: "refresh_token", client_id: CLIENT, refresh_token: "r1" });
    const now = kept()["openai-codex"];
    expect(now.access).toBe(ACCESS);
    expect(now.refresh).toBe("r2");
    expect(now.email).toBe("someone@example.com");
    expect(now.expires).toBeGreaterThan(Date.now() + 3000e3);
  });

  test("a refresh refused says to sign in again", async () => {
    write(cred(Date.now() + 1000));
    stub(() => new Response("invalid_grant", { status: 400 }));
    await expect(Login.token()).rejects.toThrow(/is over \(400\): \/login openai-codex again/);
  });

  test("Codex refreshes as a form, keeping the account claims", async () => {
    write({ ...cred(Date.now() + 1000), account: "ws-1", email: "e@x" });
    stub(() => new Response(JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: 3600 }), { status: 200 }));
    expect(await Login.token()).toBe("new");
    expect(CALLS[0].init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(CALLS[0].init.body).toContain("grant_type=refresh_token");
    expect(kept()["openai-codex"].account).toBe("ws-1");
  });
});

beforeAll(() => {
  globalThis.fetch = real;
});
