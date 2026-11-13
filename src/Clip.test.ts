// Clip test
// =========
// `bun test Clip.test.ts`. A byte stream's lines as its reads cut them:
// a character split across two reads comes whole, and a line cut short
// waits for the read that ends it.

import { expect, test } from "bun:test";
import { stream_lines } from "./Clip.ts";

// a stream that gives `bytes` in reads cut at `cuts`
function stream_of(bytes: Uint8Array, cuts: number[]): ReadableStream<Uint8Array> {
  const ends = [0, ...cuts, bytes.length];
  return new ReadableStream({
    start(c) {
      ends.slice(1).forEach((end, i) => c.enqueue(bytes.slice(ends[i], end)));
      c.close();
    },
  });
}

async function all(stream: ReadableStream<Uint8Array>): Promise<string[][]> {
  const out: string[][] = [];
  for await (const lines of stream_lines(stream)) {
    out.push(lines);
  }
  return out;
}

test("a character split across reads comes whole, in the line it ends", async () => {
  const bytes = new TextEncoder().encode("a€b\nc😀\nd");
  expect(await all(stream_of(bytes, [2, 3, 8, 10]))).toEqual([["a€b"], ["c😀"], ["d"]]);
});

test("a read of several lines gives them together; the stream's last comes last", async () => {
  const bytes = new TextEncoder().encode("one\ntwo\nthr");
  expect(await all(stream_of(bytes, [9]))).toEqual([["one", "two"], ["thr"]]);
  expect(await all(stream_of(new TextEncoder().encode("end\n"), []))).toEqual([["end"], [""]]);
});

test("a character the stream cuts short at its end reads as a replacement", async () => {
  expect(await all(stream_of(new Uint8Array([0x61, 0xe2, 0x82]), []))).toEqual([["a�"]]);
});
