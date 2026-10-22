// Draw
// ====
// The harness's messages as terminal lines (Tui.ts): each a string of
// text and SGR styles, never wider than the width it is drawn for, so a
// line is a row and the renderer (Render.ts) counts rows exactly. A reply
// draws as markdown (Md.ts); a tool call as its name and head (Call.ts);
// its result as a diff (an edit, a write) or its output, folded past a
// few lines unless opened (Ctrl+O); a note dim.

import { call_parse, report_read } from "./Call.ts";
import type { Kind } from "./AskAI.ts";
import * as Md from "./Md.ts";

// Types
// =====

// a piece of text in one style (SGR parameters; "": plain)
export type Run = [string, string];

// Constants
// =========

export const S = {
  none : "",
  bold : "1",
  dim  : "2",
  ital : "2;3",
  und  : "4",
  red  : "31",
  green: "32",
  yell : "33",
  blue : "34",
  mag  : "35",
  cyan : "36",
  head : "1;4",
};

// the lines a result shows folded: a diff's, any other output's
const FOLD_DIFF = 24;
const FOLD_OUT  = 6;

const SEG = new Intl.Segmenter();

// Text
// ====

export function width(s: string): number {
  return Bun.stringWidth(s);
}

// what a terminal can't draw as text out: escapes, other control bytes,
// tabs as spaces
export function clean(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?|\x1b./g, "").replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function graphemes(s: string): string[] {
  return Array.from(SEG.segment(s), (g) => g.segment);
}

export function paint(runs: Run[]): string {
  return runs.map(([x, s]) => (s === "" || x === "" ? x : "\x1b[" + s + "m" + x + "\x1b[0m")).join("");
}

// runs wrapped at w columns, by words (a word too long broken), each
// line after a prefix: `first`'s on the first, `rest`'s on the others. A
// word is what runs between spaces, its styles as many as it changes
// through ("**bold**." is one word)
export function wrap(runs: Run[], w: number, first: Run[] = [], rest: Run[] = first): string[] {
  const lines: Run[][] = [];
  let line: Run[] = [...first];
  let used = width(first.map((r) => r[0]).join(""));
  const pad = width(rest.map((r) => r[0]).join(""));
  const push = () => {
    lines.push(line);
    line = [...rest];
    used = pad;
  };
  const add = (x: string, s: string) => {
    const top = line[line.length - 1];
    if (top !== undefined && top[1] === s && line.length > rest.length) {
      top[0] += x;
    } else {
      line.push([x, s]);
    }
    used += width(x);
  };
  // the words, each its pieces; a space or a break between two
  const tokens: Array<{ $: "word"; x: Run[] } | { $: "space"; x: Run } | { $: "break" }> = [];
  for (const [text, style] of runs) {
    for (const part of text.split(/(\n| +)/).filter((x) => x !== "")) {
      const top = tokens[tokens.length - 1];
      if (part === "\n") {
        tokens.push({ $: "break" });
      } else if (part.startsWith(" ")) {
        tokens.push({ $: "space", x: [part, style] });
      } else if (top?.$ === "word") {
        top.x.push([part, style]);
      } else {
        tokens.push({ $: "word", x: [[part, style]] });
      }
    }
  }
  for (const tok of tokens) {
    if (tok.$ === "break") {
      push();
      continue;
    }
    if (tok.$ === "space") {
      if (used + width(tok.x[0]) <= w) {
        add(tok.x[0], tok.x[1]);
      } else {
        push();
      }
      continue;
    }
    const ww = width(tok.x.map((r) => r[0]).join(""));
    if (used + ww > w && ww <= w - pad && used > pad) {
      push();
    }
    for (const [x, style] of tok.x) {
      if (used + width(x) <= w) {
        add(x, style);
        continue;
      }
      for (const g of graphemes(x)) {
        if (used + width(g) > w) {
          push();
        }
        add(g, style);
      }
    }
  }
  lines.push(line);
  return lines.map((l) => paint(trim_end(l)));
}

// a line's spaces at its end dropped
function trim_end(line: Run[]): Run[] {
  const out = line.map(([x, s]): Run => [x, s]);
  while (out.length > 0) {
    const top = out[out.length - 1];
    top[0] = top[0].replace(/ +$/, "");
    if (top[0] !== "" || out.length === 1) {
      break;
    }
    out.pop();
  }
  return out;
}

// a line cut to w columns, an ellipsis at its end if cut
export function cut(s: string, w: number): string {
  if (width(s) <= w) {
    return s;
  }
  let out = "";
  for (const g of graphemes(s)) {
    if (width(out + g) > w - 1) {
      break;
    }
    out += g;
  }
  return out + "…";
}

// Markdown
// ========

export function spans(spans: Md.Span[], base = S.none): Run[] {
  return spans.map((sp): Run => {
    const x = clean(sp.x);
    switch (sp.$) {
      case "Code": return [x, S.cyan];
      case "Bold": return [x, join(base, S.bold)];
      case "Ital": return [x, join(base, "3")];
      case "Link": return [x === sp.k ? x : x + " (" + sp.k + ")", join(base, S.und)];
      case "Name": return ["[" + x + "]", join(base, S.mag)];
      default:     return [x, base];
    }
  });
}

function join(a: string, b: string): string {
  return [a, b].filter((x) => x !== "").join(";");
}

export function blocks(bs: Md.Block[], w: number, pre: Run[] = [], base = S.none): string[] {
  const out: string[] = [];
  for (const [k, b] of bs.entries()) {
    if (k > 0 && b.$ !== "Diff" && b.$ !== "File") {
      out.push(paint(pre));
    }
    out.push(...block(b, w, pre, base));
  }
  return out;
}

function block(b: Md.Block, w: number, pre: Run[], base: string): string[] {
  switch (b.$) {
    case "Para": {
      return b.x.flatMap((line) => wrap(spans(line, base), w, pre));
    }
    case "Head": {
      return wrap(spans(b.x, join(base, b.k <= 2 ? S.head : S.bold)), w, pre);
    }
    case "Code": {
      const label = b.k === "" ? [] : wrap([[b.k, S.dim]], w, pre);
      return [...label, ...clean(b.x).split("\n").flatMap((line) => hard(line, w, [...pre, ["  ", ""]], S.cyan))];
    }
    case "Rule": {
      return [paint([...pre, ["─".repeat(Math.max(1, Math.min(40, w - width(pre.map((r) => r[0]).join(""))))), S.dim]])];
    }
    case "Quot": {
      return blocks(b.x, w, [...pre, ["│ ", S.dim]], join(base, S.dim));
    }
    case "List": {
      return b.x.flatMap((item, k) => wrap(spans(item, base), w, [...pre, [b.k ? k + 1 + ". " : "• ", S.dim]], [...pre, [b.k ? "   " : "  ", ""]]));
    }
    case "Tabl": {
      return b.x.flatMap((row, k) => {
        const cells = row.flatMap((cell, j): Run[] => [...(j > 0 ? [[" │ ", S.dim] as Run] : []), ...spans(cell, k === 0 ? join(base, S.bold) : base)]);
        return wrap(cells, w, pre);
      });
    }
    case "Diff": {
      return diff(b, w, pre);
    }
    case "File": {
      return b.x.flatMap((line) => hard(clean(line), w, pre, S.none));
    }
  }
}

// a line broken at w columns, never by words (code, output)
export function hard(line: string, w: number, pre: Run[], style: string): string[] {
  const out: string[] = [];
  const room = Math.max(1, w - width(pre.map((r) => r[0]).join("")));
  let row = "";
  for (const g of graphemes(line)) {
    if (width(row + g) > room) {
      out.push(paint([...pre, [row, style]]));
      row = "";
    }
    row += g;
  }
  out.push(paint([...pre, [row, style]]));
  return out;
}

export function diff(b: Extract<Md.Block, { $: "Diff" }>, w: number, pre: Run[]): string[] {
  const top = Math.max(...b.x.flat().map((l) => l.n), 1);
  const nw = String(top).length;
  const out = wrap([[b.k, S.bold]], w, pre);
  for (const [k, hunk] of b.x.entries()) {
    if (k > 0) {
      out.push(paint([...pre, [" ".repeat(nw) + " ⋮", S.dim]]));
    }
    for (const line of hunk) {
      const style = line.s === "+" ? S.green : line.s === "-" ? S.red : S.dim;
      const num: Run = [String(line.n).padStart(nw) + " ", S.dim];
      out.push(...hard(line.s + " " + clean(line.x), w, [...pre, num], style));
    }
  }
  return out;
}

// Messages
// ========

// a message as lines at width w; open: a result shown whole
export function message(kind: Kind | "ai", text: string, w: number, open: boolean): string[] {
  switch (kind) {
    case "user": {
      return text_lines(text, w, [["▌ ", S.blue]], S.none);
    }
    case "unii":
    case "ai": {
      return blocks(Md.md_parse(text), w);
    }
    case "tool": {
      return tool(text, w, open, "running");
    }
    case "echo": {
      return echo(text, w, open);
    }
    case "work": {
      const report = report_read(text);
      return [paint([["◆ ", S.mag], [report?.name ?? "Report", S.bold]]), ...blocks(Md.md_parse(report?.text ?? text), w, [["  ", ""]])];
    }
    case "note": {
      return text_lines(text, w, [["· ", S.dim]], S.ital);
    }
    case "mind": {
      return text_lines(text, w, [["  ", ""]], S.ital);
    }
  }
}

function text_lines(text: string, w: number, pre: Run[], style: string): string[] {
  const rest: Run[] = pre.map(([x, s]) => (s === S.blue ? [x, s] : [" ".repeat(width(x)), ""]));
  return clean(text.replace(/\r\n?/g, "\n")).split("\n").flatMap((line, k) => wrap([[line, style]], w, k === 0 ? pre : rest, rest));
}

// a tool call: its mark (state: running, done, failed), name and head
export function tool(text: string, w: number, open: boolean, state: "running" | "done" | "failed"): string[] {
  const call = call_parse(text);
  const mark: Run = ["● ", state === "failed" ? S.red : state === "done" ? S.green : S.yell];
  const name = call.name || "tool";
  const head = clean(call.head).split("\n");
  const first = wrap([[name, S.bold], [" " + head[0], S.none]], w, [mark], [["  ", ""]]);
  const more = head.slice(1).flatMap((line) => wrap([[line, S.none]], w, [["  ", ""]]));
  const blocks = open ? call.blocks.flatMap((b) => clean(b.x).split("\n").flatMap((line) => hard(line, w, [["    ", ""]], S.dim))) : [];
  return [...first, ...(open ? more : more.slice(0, 2)), ...blocks];
}

// a tool's result under its call: a diff, or its output; folded unless
// open
export function echo(text: string, w: number, open: boolean): string[] {
  const failed = text.startsWith("error: ");
  const body = failed ? text.slice(7) : text;
  const bs = Md.md_output(body);
  const pre: Run[] = [["  ", ""]];
  const lines = bs.length === 0 ? [paint([...pre, ["(no output)", S.dim]])] : blocks(bs, w, pre, failed ? S.red : S.none).map((l) => (failed ? l : l));
  const fold = bs.some((b) => b.$ === "Diff") ? FOLD_DIFF : FOLD_OUT;
  if (open || lines.length <= fold + 1) {
    return lines;
  }
  const head = lines.slice(0, fold);
  return [...head, paint([...pre, ["… " + (lines.length - fold) + " more lines (ctrl+o to open)", S.dim]])];
}
