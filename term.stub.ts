// Terminal stub
// =============
// A terminal for render tests: w by h cells and a scrollback, fed the
// bytes the harness writes (Render.ts, Tui.ts). It keeps the text only
// (styles dropped) and does what the harness asks of a terminal: text,
// CR, LF (scrolling the top row into the scrollback at the bottom), the
// cursor up and down (held on the screen), erase line, erase below,
// clear screen, clear scrollback, home; it wraps a line too long, as a
// terminal does, so a line drawn too wide shows as a broken one.

import { graphemes, width } from "./Draw.ts";

export type Term = { w: number; h: number; rows: string[][]; back: string[]; row: number; col: number };

export function term_make(w: number, h: number): Term {
  return { w, h, rows: Array.from({ length: h }, () => []), back: [], row: 0, col: 0 };
}

export function term_write(t: Term, s: string): void {
  const re = /\x1b\[([0-9;?<>=]*)([ -/]*)([@-~])|\x1b[^[]|([\r\n])|([^\x1b\r\n]+)/g;
  for (const m of s.matchAll(re)) {
    if (m[3] !== undefined) {
      csi(t, m[1], m[3]);
    } else if (m[4] === "\r") {
      t.col = 0;
    } else if (m[4] === "\n") {
      down(t);
    } else if (m[5] !== undefined) {
      for (const g of graphemes(m[5])) {
        const gw = width(g);
        if (t.col + gw > t.w) {
          t.col = 0;
          down(t);
        }
        const row = t.rows[t.row];
        while (row.length < t.col) {
          row.push(" ");
        }
        row[t.col] = g;
        for (let k = 1; k < gw; k++) {
          row[t.col + k] = "";
        }
        t.col += gw;
      }
    }
  }
}

function down(t: Term): void {
  if (t.row === t.h - 1) {
    t.back.push(text(t.rows.shift()!));
    t.rows.push([]);
  } else {
    t.row++;
  }
}

function csi(t: Term, params: string, fin: string): void {
  if (/^[?<>=]/.test(params)) {
    return;
  }
  const n = Number(params.split(";")[0] || "1");
  switch (fin) {
    case "A": t.row = Math.max(0, t.row - n); break;
    case "B": t.row = Math.min(t.h - 1, t.row + n); break;
    case "H": t.row = 0; t.col = 0; break;
    case "K": {
      if (params === "2") {
        t.rows[t.row] = [];
      } else {
        t.rows[t.row] = t.rows[t.row].slice(0, t.col);
      }
      break;
    }
    case "J": {
      if (params === "2") {
        t.rows = Array.from({ length: t.h }, () => []);
      } else if (params === "3") {
        t.back = [];
      } else {
        t.rows[t.row] = t.rows[t.row].slice(0, t.col);
        for (let r = t.row + 1; r < t.h; r++) {
          t.rows[r] = [];
        }
      }
      break;
    }
  }
}

function text(row: string[]): string {
  return row.join("").replace(/\s+$/, "");
}

// the screen's rows as text
export function term_screen(t: Term): string[] {
  return t.rows.map(text);
}

// the scrollback and the screen, the empty rows at the end dropped
export function term_all(t: Term): string[] {
  const all = [...t.back, ...term_screen(t)];
  while (all.length > 0 && all[all.length - 1] === "") {
    all.pop();
  }
  return all;
}

export function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\s+$/, "");
}
