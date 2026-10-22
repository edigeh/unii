// Plans
// =====
// The wires of the vendors a subscription pays for, signed in through omp
// (Omp.ts): codex, a ChatGPT plan's Responses API (its Codex backend), and
// opencode-go, OpenCode Go's Responses and Messages APIs. Each speaks as
// openai-api or claude-api does (OpenAI.ts, Anthropic.ts), less what its
// backend refuses. Codex takes the system prompt as `instructions`, caches
// by a prompt_cache_key, not breakpoints, sets no output cap and no
// tool-call limit, and names the fast tier "priority"; its response's end
// may list no output, so the items are kept as each one is done. OpenCode
// Go routes by a stable session id (x-opencode-session) and a client's
// own user agent. A chat's session id is its system prompt and the start of its
// view, which stay the same from call to call (Memory.ts).

import { createHash } from "node:crypto";
import type { Ask } from "./AskAI.ts";
import type { Emit, Wire } from "./Agent.ts";
import { Anthropic } from "./Anthropic.ts";
import { OpenAI } from "./OpenAI.ts";
import { Omp } from "./Omp.ts";

// Constants
// =========

const CODEX_TIERS: Record<string, string> = { slow: "default", fast: "priority", ultrafast: "ultrafast" };

const AGENT = "uniichat/1.0";

const GO = "https://opencode.ai/inference/go/v1";

// Plans
// =====

export namespace Plans {

  // a chat's id, for the backend's routing and cache
  export function session(ask: Ask): string {
    const head = ask.system + "\n" + (ask.blocks[0]?.text ?? "").slice(0, 4096);
    return createHash("sha256").update(head).digest("hex").slice(0, 32);
  }

  export function codex_body(ask: Ask, ...rest: [any, any, number]): unknown {
    const body: any = OpenAI.body({ ...ask, speed: "slow" }, ...rest);
    const [system, ...input] = body.input;
    for (const item of input) {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        delete part.prompt_cache_breakpoint;
      }
    }
    delete body.max_output_tokens;
    delete body.max_tool_calls;
    delete body.prompt_cache_options;
    return {
      ...body,
      instructions     : system.content[0].text,
      input,
      service_tier     : CODEX_TIERS[ask.speed] ?? "default",
      include          : ["reasoning.encrypted_content"],
      prompt_cache_key : Plans.session(ask),
    };
  }

  // one stream event (OpenAI.read), the items done kept for an end that
  // lists none
  export function codex_read(st: any, ev: any, on: Emit): boolean {
    if (ev.type === "response.output_item.done") {
      (st.items ??= []).push(ev.item);
    }
    const last = OpenAI.read(st, ev, on);
    if (last && st.res && !(st.res.output?.length > 0)) {
      st.res.output = st.items ?? [];
    }
    return last;
  }

  export const codex: Wire<any> = {
    ...OpenAI.wire,
    read    : Plans.codex_read,
    key     : "codex",
    auth    : () => Omp.codex(),
    url     : "https://chatgpt.com/backend-api/codex/responses",
    headers : (key, ask) => ({
      authorization        : "Bearer " + key,
      "chatgpt-account-id" : Omp.account(key),
      "OpenAI-Beta"        : "responses=experimental",
      originator           : "codex_cli_rs",
      version              : "0.159.0",
      session_id           : Plans.session(ask),
      "content-type"       : "application/json",
    }),
    body    : Plans.codex_body,
  };

  const go = (key: string, ask: Ask) => ({ "user-agent": AGENT, "x-opencode-session": Plans.session(ask) });

  export const go_responses: Wire<any> = {
    ...OpenAI.wire,
    key     : "opencode-go",
    auth    : async () => Omp.key("opencode-go"),
    url     : GO + "/responses",
    headers : (key, ask) => ({ ...OpenAI.wire.headers(key, ask), ...go(key, ask) }),
  };

  export const go_messages: Wire<any> = {
    ...Anthropic.wire,
    key     : "opencode-go",
    auth    : async () => Omp.key("opencode-go"),
    url     : GO + "/messages",
    headers : (key, ask) => ({ ...Anthropic.wire.headers(key, ask), ...go(key, ask) }),
    count   : async () => null,
  };

}
