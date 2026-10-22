// Render
// ======
// The harness's frame on the terminal, in its own scrollback (Tui.ts): the
// frame is every line, the chat's then the editor's and the status's, and
// each render writes only from the first line that changed. Lines that
// scrolled off the top stay in the terminal's scrollback as they were; one
// of those that changed is redrawn only as far as the screen shows it. A
// resize redraws all, the scrollback cleared, at the new width, so no
// line keeps a wrap of the old one. Each write is one synchronized update
// (DEC 2026), so a terminal that knows it never shows half a frame.

// Types
// =====

// out: where the bytes go; w, h: the screen's size; lines: the frame on
// the screen; row: the frame's line the cursor is on; top: the line on the
// screen's first row (those above it are scrollback)
export type Render = {
  out   : (s: string) => void;
  w     : number;
  h     : number;
  lines : string[];
  row   : number;
  top   : number;
  fresh : boolean;
  begun : boolean;
};

// Constants
// =========

const SYNC_ON  = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";

// Render
// ======

export namespace Render {

  export function make(out: (s: string) => void, w: number, h: number): Render {
    return { out, w, h, lines: [], row: 0, top: 0, fresh: true, begun: false };
  }

  export function resize(r: Render, w: number, h: number): void {
    if (w !== r.w || h !== r.h) {
      r.w = w;
      r.h = h;
      r.fresh = true;
    }
  }

  // the frame drawn: all of it if fresh, else from its first change
  export function draw(r: Render, lines: string[]): void {
    if (r.fresh) {
      // the first: what the screen showed pushed into the scrollback; a
      // redraw: the scrollback cleared, as it holds lines of the old width
      const clear = r.begun ? "\x1b[H\x1b[2J\x1b[3J" : "\n".repeat(r.h) + "\x1b[H\x1b[2J";
      r.fresh = false;
      r.begun = true;
      r.out(SYNC_ON + clear + lines.map((l) => "\x1b[2K" + l).join("\r\n") + SYNC_OFF);
      r.lines = lines;
      r.row = Math.max(0, lines.length - 1);
      r.top = Math.max(0, lines.length - r.h);
      return;
    }
    const prev = r.lines;
    let i = 0;
    while (i < lines.length && i < prev.length && lines[i] === prev[i]) {
      i++;
    }
    if (i === lines.length && i === prev.length) {
      return;
    }
    if (lines.length <= r.top) {
      Render.redraw(r);
      Render.draw(r, lines);
      return;
    }
    i = Math.max(i, r.top);
    let s = SYNC_ON;
    if (i >= lines.length) {
      // only lines gone: cleared from the first
      s += move(r.row, i) + "\r\x1b[J";
      r.row = i;
      if (i > 0) {
        s += "\x1b[1A";
        r.row = i - 1;
      }
    } else {
      const to = Math.min(i, Math.max(0, prev.length - 1));
      s += move(r.row, to) + "\r";
      if (i > to) {
        s += "\r\n";
      }
      s += lines.slice(i).map((l) => "\x1b[2K" + l).join("\r\n");
      if (lines.length < prev.length) {
        s += "\x1b[J";
      }
      r.row = lines.length - 1;
      r.top = Math.max(r.top, r.row - r.h + 1);
    }
    r.out(s + SYNC_OFF);
    r.lines = lines;
  }

    // the next draw redraws all (a session changed, the frame shrank)
  export function redraw(r: Render): void {
    r.fresh = true;
  }

  // the screen given back: the cursor past the frame, on a line of its own
  export function end(r: Render): string {
    return move(r.row, Math.max(0, r.lines.length - 1)) + "\r\n";
  }

}

// the cursor moved from frame line `from` to line `to`
function move(from: number, to: number): string {
  if (to < from) {
    return "\x1b[" + (from - to) + "A";
  }
  if (to > from) {
    return "\x1b[" + (to - from) + "B";
  }
  return "";
}
