// Stub wire
// =========
// A Wire (Agent.ts) for deterministic tests of the loop and the terminal:
// every call, of any vendor, runs on it, and its requests are answered in
// process by a script, as a stream of events the Agent loop reads like
// any vendor's. The script gets each request (its items and tools, and
// whether it is a summary) and answers its events: text streamed, tool
// calls, a wait (cut by a stop, as a stream is).

import { Agent, type Item, type Step, type Wire } from "./Agent.ts";
import { Price, type Usage } from "./Price.ts";

export type Ev =
  | { t: "text"; x: string }
  | { t: "tool"; id: string; name: string; input: unknown }
  | { t: "wait"; ms: number };

// a request as the script reads it: its items, its tools' names, its last
// block's text (a summary's task, a turn's message), its number
export type Req = { items: Item[]; tools: string[]; last: string; system: string; n: number };

type St = { text: string; uses: Array<{ id: string; name: string; input: unknown }> };

const URL = "http://stub.invalid/v1";

export const STUB = {
  script : (_req: Req): Ev[] => [{ t: "text", x: "ok" }],
  reqs   : [] as Req[],
  fail   : null as null | { status: number; message: string },
};

// a summary's answer: one short line
export function summary(req: Req): Ev[] | null {
  return req.last.startsWith("Compaction:") ? [{ t: "text", x: "line: " + req.last.split("\n")[0].slice(0, 60) }] : null;
}

export const wire: Wire<St> = {
  key     : "stub",
  auth    : async () => "stub-key",
  idle    : 60e3,
  url     : URL,
  headers : () => ({ "content-type": "application/json" }),
  body    : (ask, items, tools) => ({ system: ask.system, items, tools: tools.map((t) => t.name) }),
  count   : async () => null,
  start   : () => ({ text: "", uses: [] }),
  read    : (st, ev, on) => {
    if (ev.t === "text") {
      st.text += ev.x;
      on("unii", ev.x);
    } else if (ev.t === "tool") {
      st.uses.push({ id: ev.id, name: ev.name, input: ev.input });
      on("tool", ev.name + " " + JSON.stringify(ev.input), true);
    }
    return ev.t === "end";
  },
  begun   : () => true,
  step    : (st): Step => {
    const entries = [
      ...(st.text === "" ? [] : [{ kind: "unii" as const, text: st.text }]),
      ...st.uses.map((u) => ({ kind: "tool" as const, text: u.name + " " + JSON.stringify(u.input), of: u.id })),
    ];
    return { out: [{ text: st.text, uses: st.uses }], uses: st.uses, entries, stop: st.uses.length > 0 ? "tools" : "done", why: "", note: "" };
  },
  usage   : (): Usage => ({ ...Price.usage("slow"), input: 1000, output: 10 }),
};

const real = { fetch: globalThis.fetch, wire: Agent.wire };

// every call runs on the stub
export function stub_install(): void {
  STUB.reqs = [];
  (Agent as any).wire = () => wire;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url) !== URL) {
      return real.fetch(url, init);
    }
    if (STUB.fail !== null) {
      return Response.json({ error: { message: STUB.fail.message } }, { status: STUB.fail.status });
    }
    const body = JSON.parse(init.body);
    const user = body.items.findLast((i: Item) => i.$ === "User");
    const last = user?.parts?.[user.parts.length - 1]?.text ?? "";
    const req: Req = { items: body.items, tools: body.tools, last, system: body.system, n: STUB.reqs.length };
    STUB.reqs.push(req);
    const evs = summary(req) ?? STUB.script(req);
    return new Response(stub_stream(evs, init.signal));
  }) as typeof fetch;
}

export function stub_remove(): void {
  (Agent as any).wire = real.wire;
  globalThis.fetch = real.fetch;
}

function stub_stream(evs: Ev[], signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(ctl) {
      try {
        for (const ev of [...evs, { t: "end" }]) {
          if (signal?.aborted) {
            throw new Error("aborted");
          }
          if (ev.t === "wait") {
            await new Promise<void>((ok, no) => {
              const timer = setTimeout(ok, (ev as any).ms);
              signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                no(new Error("aborted"));
              }, { once: true });
            });
            continue;
          }
          ctl.enqueue(enc.encode("data: " + JSON.stringify(ev) + "\n\n"));
        }
        ctl.close();
      } catch (err) {
        ctl.error(err);
      }
    },
  });
}
