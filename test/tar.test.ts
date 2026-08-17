import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tar, untar, type Entry } from "../src/tar.js";

const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

const sample: Entry[] = [
  { path: "dist/index.js", data: bytes("export default {}\n") },
  { path: "migrations/0001_init.sql", data: bytes("create table t (id integer);\n") },
  { path: "public/index.html", data: bytes("<!doctype html>\n") },
];

describe("tar", () => {
  test("is byte-identical across calls", () => {
    expect(sha(tar(sample, 1_700_000_000))).toBe(sha(tar(sample, 1_700_000_000)));
  });

  test("ignores the order entries are given in", () => {
    const shuffled = [sample[2]!, sample[0]!, sample[1]!];
    expect(sha(tar(shuffled, 1_700_000_000))).toBe(sha(tar(sample, 1_700_000_000)));
  });

  test("changes when a timestamp changes", () => {
    expect(sha(tar(sample, 1))).not.toBe(sha(tar(sample, 2)));
  });

  test("round-trips through untar", () => {
    const back = untar(tar(sample, 1_700_000_000));
    expect(back.map((e) => e.path).sort()).toEqual(sample.map((e) => e.path).sort());
    for (const entry of back) {
      const original = sample.find((e) => e.path === entry.path)!;
      expect(new TextDecoder().decode(entry.data)).toBe(new TextDecoder().decode(original.data));
    }
  });

  test("writes every file at the same mode", () => {
    const archive = tar([{ path: "bin/run.sh", data: bytes("#!/bin/sh\n") }], 0);
    // Mode field is bytes 100..108 of the first header.
    expect(new TextDecoder().decode(archive.subarray(100, 107))).toBe("0000644");
  });

  test("sorts by path bytes rather than by locale", () => {
    const entries = [
      { path: "a_b.js", data: bytes("1") },
      { path: "a-b.js", data: bytes("2") },
      { path: "aB.js", data: bytes("3") },
    ];
    // "-" (0x2d) < "B" (0x42) < "_" (0x5f). A locale-aware sort reorders these.
    expect(untar(tar(entries, 0)).map((e) => e.path)).toEqual(["a-b.js", "aB.js", "a_b.js"]);
  });

  test("refuses a duplicate path", () => {
    const dup = [sample[0]!, { ...sample[0]!, data: bytes("other") }];
    expect(() => tar(dup, 0)).toThrow(/duplicate path/);
  });

  test("splits a long path across the ustar prefix", () => {
    const path = `${"a".repeat(80)}/${"b".repeat(80)}/c.js`;
    const [entry] = untar(tar([{ path, data: bytes("x") }], 0));
    expect(entry?.path).toBe(path);
  });

  test("refuses a path that cannot be split", () => {
    expect(() => tar([{ path: "x".repeat(200), data: bytes("x") }], 0)).toThrow(/too long/);
  });

  test("pads to a whole 20-block record", () => {
    expect(tar(sample, 0).length % (512 * 20)).toBe(0);
  });
});
