// Keys
// ====
// The terminal's input, raw, as keys (Tui.ts): text typed, a key with its
// modifiers, a paste whole. Bytes come in chunks that may cut a sequence,
// so what doesn't end yet waits for the next chunk; a lone Esc is told
// apart from a sequence's start by a pause (WAIT). Read: the legacy
// sequences (CSI, SS3, Alt as Esc then the key), xterm's modifyOtherKeys
// (CSI 27;mod;code ~) and kitty's (CSI code;mod u). A bracketed paste
// (CSI 200~ … CSI 201~) is one event, however many chunks it spans, its
// line ends made \n; keys tmux re-encodes inside it (CSI code;mod u, CSI
// 27;mod;code ~) are read back to their text.

// Types
// =====

export type Key =
  | { $: "text"; x: string }
  | { $: "paste"; x: string }
  | { $: "key"; name: string; ctrl: boolean; alt: boolean; shift: boolean };

// a reader: bytes not read yet; paste: the paste coming, if one
export type Keys = { buf: string; paste: string | null };

// Constants
// =========

// the pause after a lone Esc that makes it a key, not a sequence's start
export const WAIT = 30;

// the most a paste holds; past it, the rest is dropped
const PASTE_MAX = 64 * 1024 * 1024;

const PASTE_ON  = "\x1b[200~";
const PASTE_OFF = "\x1b[201~";

// CSI's final letters and ~ codes, as keys
const LETTER: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab", P: "f1", Q: "f2", R: "f3", S: "f4",
};
const TILDE: Record<number, string> = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
};
const CODE: Record<number, string> = {
  9: "tab", 13: "enter", 27: "escape", 127: "backspace", 8: "backspace", 32: "space",
};

// Keys
// ====

export namespace Keys {

  export function make(): Keys {
    return { buf: "", paste: null };
  }

  // a chunk's keys; what may go on in the next chunk waits
  export function feed(keys: Keys, chunk: string): Key[] {
    keys.buf += chunk;
    const out: Key[] = [];
    while (keys.buf !== "") {
      if (keys.paste !== null) {
        const end = keys.buf.indexOf(PASTE_OFF);
        if (end < 0) {
          const keep = tail_of(keys.buf, PASTE_OFF);
          Keys.paste_add(keys, keys.buf.slice(0, keys.buf.length - keep));
          keys.buf = keys.buf.slice(keys.buf.length - keep);
          break;
        }
        Keys.paste_add(keys, keys.buf.slice(0, end));
        keys.buf = keys.buf.slice(end + PASTE_OFF.length);
        out.push({ $: "paste", x: paste_text(keys.paste) });
        keys.paste = null;
        continue;
      }
      if (keys.buf.startsWith(PASTE_ON)) {
        keys.buf = keys.buf.slice(PASTE_ON.length);
        keys.paste = "";
        continue;
      }
      const [key, n] = Keys.read(keys.buf);
      if (n === 0) {
        break;
      }
      keys.buf = keys.buf.slice(n);
      if (key !== null) {
        const top = out[out.length - 1];
        if (key.$ === "text" && top?.$ === "text") {
          top.x += key.x;
        } else {
          out.push(key);
        }
      }
    }
    return out;
  }

  // what waits after a pause: a lone Esc, or a sequence cut that won't go
  // on, read as its keys
  export function flush(keys: Keys): Key[] {
    if (keys.paste !== null || keys.buf === "") {
      return [];
    }
    const buf = keys.buf;
    keys.buf = "";
    if (buf === "\x1b") {
      return [key("escape")];
    }
    return [key("escape"), ...Keys.feed(keys, buf.slice(1))];
  }

  export function waiting(keys: Keys): boolean {
    return keys.paste === null && keys.buf !== "";
  }

  export function paste_add(keys: Keys, x: string): void {
    if (keys.paste!.length < PASTE_MAX) {
      keys.paste += x.slice(0, PASTE_MAX - keys.paste!.length);
    }
  }

  // the key at the start of s and its length; 0: it doesn't end in s
  export function read(s: string): [Key | null, number] {
    const c = s.charCodeAt(0);
    if (c === 0x1b) {
      return Keys.escape(s);
    }
    if (c === 0x0d) {
      return [key("enter"), 1];
    }
    if (c === 0x0a) {
      return [key("j", { ctrl: true }), 1];
    }
    if (c === 0x09) {
      return [key("tab"), 1];
    }
    if (c === 0x7f || c === 0x08) {
      return [key("backspace"), 1];
    }
    if (c === 0x00) {
      return [key("space", { ctrl: true }), 1];
    }
    if (c < 0x20) {
      return [key(String.fromCharCode(c + 96), { ctrl: true }), 1];
    }
    let n = 1;
    while (n < s.length && s.charCodeAt(n) >= 0x20 && s.charCodeAt(n) !== 0x7f && s.charCodeAt(n) !== 0x1b) {
      n++;
    }
    return [{ $: "text", x: s.slice(0, n) }, n];
  }

  export function escape(s: string): [Key | null, number] {
    if (s.length === 1) {
      return [null, 0];
    }
    const next = s[1];
    if (next === "[") {
      return Keys.csi(s);
    }
    if (next === "O") {
      if (s.length < 3) {
        return [null, 0];
      }
      const name = LETTER[s[2]];
      return [name === undefined ? null : key(name), 3];
    }
    if (next === "\x1b") {
      return [key("escape"), 1];
    }
    const [inner, n] = Keys.read(s.slice(1));
    if (n === 0) {
      return [null, 0];
    }
    if (inner?.$ === "key") {
      return [{ ...inner, alt: true }, n + 1];
    }
    if (inner?.$ === "text") {
      const first = Array.from(inner.x)[0];
      return [key(first, { alt: true }), 1 + first.length];
    }
    return [null, n + 1];
  }

  // CSI: its parameters, then its final byte; an OSC or other string the
  // terminal answers is skipped whole by the caller's next read
  export function csi(s: string): [Key | null, number] {
    let i = 2;
    while (i < s.length && s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x3f) {
      i++;
    }
    while (i < s.length && s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x2f) {
      i++;
    }
    if (i >= s.length) {
      return [null, 0];
    }
    const fin = s[i];
    const params = s.slice(2, i);
    const n = i + 1;
    if (params.startsWith("<") || params.startsWith("?") || params.startsWith(">")) {
      return [null, n];
    }
    const nums = params.split(";").map((p) => Number(p.split(":")[0] || "1"));
    const mod = mods(nums[1] ?? 1);
    if (fin === "u") {
      return [code_key(nums[0], mod), n];
    }
    if (fin === "~") {
      if (nums[0] === 27 && nums.length >= 3) {
        return [code_key(nums[2], mods(nums[1])), n];
      }
      const name = TILDE[nums[0]];
      return [name === undefined ? null : key(name, mod), n];
    }
    if (fin === "Z") {
      return [key("tab", { ...mod, shift: true }), n];
    }
    const name = LETTER[fin];
    return [name === undefined ? null : key(name, mod), n];
  }

}

// Helpers
// =======

function key(name: string, mod: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}): Key {
  return { $: "key", name, ctrl: mod.ctrl ?? false, alt: mod.alt ?? false, shift: mod.shift ?? false };
}

// a sequence's modifier parameter: 1 + shift 1, alt 2, ctrl 4
function mods(m: number): { ctrl: boolean; alt: boolean; shift: boolean } {
  const bits = Math.max(0, m - 1);
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

// a key by its code (kitty's, modifyOtherKeys'): a named key, a letter
// with ctrl or alt, or text
function code_key(code: number, mod: { ctrl: boolean; alt: boolean; shift: boolean }): Key {
  const name = CODE[code];
  if (name !== undefined) {
    return key(name, mod);
  }
  const ch = String.fromCodePoint(code);
  if (mod.ctrl || mod.alt) {
    return key(ch.toLowerCase(), mod);
  }
  return { $: "text", x: mod.shift ? ch.toUpperCase() : ch };
}

// how much of s's end may be the start of `mark`
function tail_of(s: string, mark: string): number {
  for (let n = Math.min(mark.length - 1, s.length); n > 0; n--) {
    if (mark.startsWith(s.slice(s.length - n))) {
      return n;
    }
  }
  return 0;
}

// a paste's text: keys a terminal re-encoded read back, line ends as \n
function paste_text(x: string): string {
  return x
    .replace(/\x1b\[27;\d+;(\d+)~/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/\x1b\[(\d+)(?:;\d+)?u/g, (_, c) => String.fromCodePoint(Number(c)))
    .replace(/\r\n?/g, "\n");
}
