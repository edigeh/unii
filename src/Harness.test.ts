// Harness test
// ============
// `bun test Harness.test.ts`. The harness's import graph, walked from
// unii.ts by every import (static, dynamic, type-only too, as Bun's own
// scanner reads them): it holds none of UniiChat's server modules (Server,
// Cloud, Billing, Mail, Tools' MCP server, the web client's View, Paint,
// Screen, Term), and none of its files opens a port or a socket.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = import.meta.dir;

export const BANNED = ["Server.ts", "Cloud.ts", "Billing.ts", "Mail.ts", "Tools.ts", "View.ts", "Paint.ts", "Screen.ts", "Term.ts", "Import.ts"];

// what opens a port or a socket
export const LISTEN = [/Bun\.serve\s*\(/, /new\s+WebSocket\b/, /\bWebSocketServer\b/, /\.listen\s*\(/, /createServer\s*\(/, /Bun\.listen\s*\(/, /node:net\b/, /node:http\b/];

const scan = new Bun.Transpiler({ loader: "ts" });

// the local files reachable from `entry`, each with what it imports
export function graph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file)) {
      return;
    }
    const src = fs.readFileSync(file, "utf8");
    const local = scan.scanImports(src).map((i) => i.path).filter((p) => p.startsWith("."));
    const files = local.map((p) => path.resolve(path.dirname(file), p)).filter((p) => /\.(ts|tsx|js)$/.test(p));
    seen.set(file, files.map((f) => path.relative(ROOT, f)));
    files.forEach(walk);
  };
  walk(path.resolve(ROOT, entry));
  return seen;
}

test("the harness graph holds no server module", () => {
  const files = [...graph("unii.ts").keys()].map((f) => path.relative(ROOT, f));
  expect(files).toContain("Local.ts");
  expect(files).toContain("Tui.ts");
  expect(files).toContain("Agent.ts");
  expect(files.filter((f) => BANNED.includes(f))).toEqual([]);
  expect(files.filter((f) => f.startsWith("web/"))).toEqual([]);
});

test("no file of the harness opens a port or a socket", () => {
  const hits = [...graph("unii.ts").keys()].flatMap((file) => {
    const src = fs.readFileSync(file, "utf8");
    return LISTEN.filter((re) => re.test(src)).map((re) => path.relative(ROOT, file) + ": " + re.source);
  });
  expect(hits).toEqual([]);
});
