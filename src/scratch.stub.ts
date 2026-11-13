// Scratch stub
// ============
// The tests' one dir: UNII_DIR and TMPDIR point into it, so no test reaches
// ~/.unii or leaves a dir behind. bunfig.toml preloads it, for the run or,
// with --isolate, for each file (which also resets the environment), and
// the afterAll here fires as that ends; `process.on("exit")` never does
// under `bun test`. A test file imports it too, first, as bun reads
// bunfig.toml only from the working dir: from elsewhere this still comes
// before Config.ts reads UNII_DIR.

import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

export const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-test-");

process.env.UNII_DIR = DIR;
process.env.TMPDIR = DIR;

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));
