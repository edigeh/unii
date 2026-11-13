// Editor
// ======
// The message being written (Tui.ts): text over many lines and a cursor
// in it, moved and edited by keys as a shell's line editor does (Ctrl+A,
// E, U, K, W, Alt+B, F), with the messages sent before as history (up on
// the first row, down on the last). Enter sends; Shift+Enter, Alt+Enter
// or Ctrl+J breaks the line; a paste goes in whole. It draws itself
// wrapped to the width, a cursor cell in reverse video, at most ROWS rows
// around the cursor.

import { graphemes, paint, width, type Run } from "./Draw.ts";
import type { Key } from "./Keys.ts";

// Types
// =====

// text and the cursor (a code unit index); history: sent, oldest first;
// back: the entry shown (history.length: the draft); draft: what was
// being written before going back; want: the column up and down keep
export type Editor = { text: string; at: number; history: string[]; back: number; draft: string; want: number | null };

// what a key did: sent the text; changed it; nothing
export type Did = "send" | "edit" | "none";

// a row drawn: its text's range [from, to) and its graphemes
type Row = { from: number; to: number; cells: string[] };

// Constants
// =========

export const ROWS = 10;

const HISTORY = 500;

const PROMPT: Run = ["› ", "36"];
const MORE  : Run = ["  ", ""];

// Editor
// ======

export namespace Editor {

  export function make(history: string[] = []): Editor {
    return { text: "", at: 0, history: history.slice(-HISTORY), back: history.length, draft: "", want: null };
  }

  export function set(ed: Editor, text: string): void {
    ed.text = text;
    ed.at = text.length;
    ed.want = null;
  }

  export function insert(ed: Editor, x: string): void {
    ed.text = ed.text.slice(0, ed.at) + x + ed.text.slice(ed.at);
    ed.at += x.length;
    ed.want = null;
  }

  // the text sent: kept as history, the editor emptied
  export function take(ed: Editor): string {
    const text = ed.text;
    if (text.trim() !== "" && ed.history[ed.history.length - 1] !== text) {
      ed.history.push(text);
      ed.history = ed.history.slice(-HISTORY);
    }
    ed.back = ed.history.length;
    ed.draft = "";
    Editor.set(ed, "");
    return text;
  }

  export function key(ed: Editor, k: Key, w: number): Did {
    if (k.$ === "text" || k.$ === "paste") {
      Editor.insert(ed, k.x.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
      return "edit";
    }
    const { name, ctrl, alt, shift } = k;
    if (name === "enter" && (shift || alt) || name === "j" && ctrl) {
      Editor.insert(ed, "\n");
      return "edit";
    }
    if (name === "enter") {
      return "send";
    }
    const before = ed.text + "\0" + ed.at;
    switch (true) {
      case name === "backspace" && (alt || ctrl):
      case name === "w" && ctrl: {
        Editor.cut(ed, Editor.word_left(ed.text, ed.at), ed.at);
        break;
      }
      case name === "backspace": {
        Editor.cut(ed, prev(ed.text, ed.at), ed.at);
        break;
      }
      case name === "delete":
      case name === "d" && ctrl && ed.text !== "": {
        Editor.cut(ed, ed.at, next(ed.text, ed.at));
        break;
      }
      case name === "left" && (alt || ctrl):
      case name === "b" && alt: {
        ed.at = Editor.word_left(ed.text, ed.at);
        break;
      }
      case name === "right" && (alt || ctrl):
      case name === "f" && alt: {
        ed.at = Editor.word_right(ed.text, ed.at);
        break;
      }
      case name === "left":
      case name === "b" && ctrl: {
        ed.at = prev(ed.text, ed.at);
        break;
      }
      case name === "right":
      case name === "f" && ctrl: {
        ed.at = next(ed.text, ed.at);
        break;
      }
      case name === "home":
      case name === "a" && ctrl: {
        ed.at = line_start(ed.text, ed.at);
        break;
      }
      case name === "end":
      case name === "e" && ctrl: {
        ed.at = line_end(ed.text, ed.at);
        break;
      }
      case name === "u" && ctrl: {
        Editor.cut(ed, line_start(ed.text, ed.at), ed.at);
        break;
      }
      case name === "k" && ctrl: {
        const end = line_end(ed.text, ed.at);
        Editor.cut(ed, ed.at, end === ed.at ? next(ed.text, ed.at) : end);
        break;
      }
      case name === "up": {
        Editor.vertical(ed, -1, w);
        return "edit";
      }
      case name === "down": {
        Editor.vertical(ed, 1, w);
        return "edit";
      }
      default: {
        return "none";
      }
    }
    ed.want = null;
    return before === ed.text + "\0" + ed.at ? "none" : "edit";
  }

  export function cut(ed: Editor, from: number, to: number): void {
    ed.text = ed.text.slice(0, from) + ed.text.slice(to);
    ed.at = from;
    ed.want = null;
  }

  // up or down a row; past the first or last, the history
  export function vertical(ed: Editor, d: number, w: number): void {
    const rows = Editor.rows(ed.text, w);
    const r = row_of(rows, ed.at);
    const want = ed.want ?? width(rows[r].cells.slice(0, cell_of(rows[r], ed.text, ed.at)).join(""));
    const to = r + d;
    if (to < 0 || to >= rows.length) {
      Editor.history(ed, d);
      return;
    }
    const row = rows[to];
    let at = row.from;
    let used = 0;
    for (const cell of row.cells) {
      if (used + width(cell) > want || at + cell.length > row.to || cell === "\n") {
        break;
      }
      used += width(cell);
      at += cell.length;
    }
    ed.at = at;
    ed.want = want;
  }

  export function history(ed: Editor, d: number): void {
    const to = ed.back + d;
    if (to < 0 || to > ed.history.length) {
      return;
    }
    if (ed.back === ed.history.length) {
      ed.draft = ed.text;
    }
    ed.back = to;
    Editor.set(ed, to === ed.history.length ? ed.draft : ed.history[to]);
    if (d < 0) {
      ed.at = Math.min(ed.at, line_end(ed.text, 0));
    }
  }

  export function word_left(s: string, at: number): number {
    let i = at;
    while (i > 0 && /\s/.test(s[i - 1])) {
      i--;
    }
    while (i > 0 && !/\s/.test(s[i - 1])) {
      i--;
    }
    return i;
  }

  export function word_right(s: string, at: number): number {
    let i = at;
    while (i < s.length && /\s/.test(s[i])) {
      i++;
    }
    while (i < s.length && !/\s/.test(s[i])) {
      i++;
    }
    return i;
  }

  // Draw
  // ----

  // the text as rows of at most w - 2 columns (after the prompt), each
  // line's break kept as its row's last cell
  export function rows(text: string, w: number): Row[] {
    const room = Math.max(4, w - 2);
    const rows: Row[] = [];
    let row: Row = { from: 0, to: 0, cells: [] };
    let used = 0;
    let at = 0;
    for (const g of graphemes(text)) {
      if (g === "\n") {
        row.cells.push(g);
        row.to = at + 1;
        rows.push(row);
        row = { from: at + 1, to: at + 1, cells: [] };
        used = 0;
      } else {
        const gw = width(g);
        if (used + gw > room - 1) {
          rows.push(row);
          row = { from: at, to: at, cells: [] };
          used = 0;
        }
        row.cells.push(g);
        used += gw;
        row.to = at + g.length;
      }
      at += g.length;
    }
    rows.push(row);
    return rows;
  }

  // the editor's lines, at most ROWS around the cursor; placeholder:
  // shown dim while empty
  export function draw(ed: Editor, w: number, placeholder = ""): string[] {
    if (ed.text === "") {
      return [paint([PROMPT, ["\x1b[7m \x1b[27m", ""], [placeholder, "2"]])];
    }
    const rows = Editor.rows(ed.text, w);
    const r = row_of(rows, ed.at);
    const top = Math.max(0, Math.min(r - Math.floor(ROWS / 2), rows.length - ROWS));
    const shown = rows.slice(top, top + ROWS);
    const lines = shown.map((row, k) => {
      const cells = row.cells.filter((c) => c !== "\n");
      const pre = top + k === 0 ? PROMPT : MORE;
      if (top + k !== r) {
        return paint([pre, [cells.join(""), ""]]);
      }
      const c = cell_of(row, ed.text, ed.at);
      const under = cells[c] ?? " ";
      return paint([pre, [cells.slice(0, c).join(""), ""], ["\x1b[7m" + under + "\x1b[27m", ""], [cells.slice(c + 1).join(""), ""]]);
    });
    const above = top;
    const below = rows.length - top - shown.length;
    if (above > 0) {
      lines.unshift(paint([MORE, ["↑ " + above + " more lines", "2"]]));
    }
    if (below > 0) {
      lines.push(paint([MORE, ["↓ " + below + " more lines", "2"]]));
    }
    return lines;
  }

}

// Helpers
// =======

function prev(s: string, at: number): number {
  if (at === 0) {
    return 0;
  }
  const gs = graphemes(s.slice(0, at));
  return at - gs[gs.length - 1].length;
}

function next(s: string, at: number): number {
  if (at >= s.length) {
    return s.length;
  }
  return at + graphemes(s.slice(at, at + 16))[0].length;
}

function line_start(s: string, at: number): number {
  return s.lastIndexOf("\n", at - 1) + 1;
}

function line_end(s: string, at: number): number {
  const n = s.indexOf("\n", at);
  return n < 0 ? s.length : n;
}

// the row the cursor is on: the last whose range holds it
function row_of(rows: Row[], at: number): number {
  for (let k = rows.length - 1; k >= 0; k--) {
    if (rows[k].from <= at) {
      if (at === rows[k].to && rows[k].cells[rows[k].cells.length - 1] === "\n") {
        return Math.min(k + 1, rows.length - 1);
      }
      return k;
    }
  }
  return 0;
}

// the cell the cursor is at in its row
function cell_of(row: Row, text: string, at: number): number {
  let i = row.from;
  let c = 0;
  while (i < at && c < row.cells.length) {
    i += row.cells[c].length;
    c++;
  }
  return c;
}
