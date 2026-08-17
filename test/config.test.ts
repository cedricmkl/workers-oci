import { describe, expect, test } from "bun:test";
import { ConfigError, validate } from "../src/config.js";

const base = {
  schema_version: 1,
  name: "example",
  runtime: { compatibility_date: "2026-07-14" },
  workers: [{ name: "example", main: "dist/index.js" }],
};

const problems = (input: unknown): string[] => {
  try {
    validate(input);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return [...error.problems];
    throw error;
  }
};

describe("validate", () => {
  test("accepts a minimal document", () => {
    expect(validate(base).name).toBe("example");
  });

  test("rejects another schema version", () => {
    expect(problems({ ...base, schema_version: 2 })).toContainEqual(expect.stringContaining("schema_version"));
  });

  test("rejects a compatibility date that is not a date", () => {
    expect(problems({ ...base, runtime: { compatibility_date: "soon" } })).toContainEqual(
      expect.stringContaining("compatibility_date"),
    );
  });

  test("rejects a binding declared twice", () => {
    expect(
      problems({
        ...base,
        resources: [
          { binding: "DB", kind: "d1" },
          { binding: "DB", kind: "kv" },
        ],
      }),
    ).toContainEqual(expect.stringContaining("declared twice"));
  });

  test("rejects a var colliding with a binding", () => {
    expect(
      problems({ ...base, resources: [{ binding: "DB", kind: "d1" }], vars: [{ name: "DB" }] }),
    ).toContainEqual(expect.stringContaining("collides"));
  });

  test("rejects a second assets binding", () => {
    expect(
      problems({
        ...base,
        resources: [
          { binding: "A", kind: "assets", directory: "public" },
          { binding: "B", kind: "assets", directory: "static" },
        ],
      }),
    ).toContainEqual(expect.stringContaining("second assets binding"));
  });

  test("rejects a path escaping the content root", () => {
    expect(problems({ ...base, workers: [{ name: "w", main: "../outside.js" }] })).toContainEqual(
      expect.stringContaining(".."),
    );
    expect(problems({ ...base, workers: [{ name: "w", main: "/abs.js" }] })).toContainEqual(
      expect.stringContaining("relative"),
    );
  });

  test("rejects consuming something that is not a queue", () => {
    expect(
      problems({
        ...base,
        resources: [{ binding: "DB", kind: "d1" }],
        workers: [{ name: "w", main: "dist/i.js", consumes: ["DB"] }],
      }),
    ).toContainEqual(expect.stringContaining("rather than a queue"));
  });

  test("rejects a binding reference that does not exist", () => {
    expect(problems({ ...base, workers: [{ name: "w", main: "dist/i.js", bindings: ["NOPE"] }] })).toContainEqual(
      expect.stringContaining("not a declared resource binding"),
    );
  });

  test("rejects Durable Objects with an explanation", () => {
    expect(problems({ ...base, resources: [{ binding: "ROOM", kind: "durable_object" }] })).toContainEqual(
      expect.stringContaining("6852"),
    );
  });

  test("rejects a generate block that is too small", () => {
    expect(problems({ ...base, secrets: [{ name: "K", generate: { bytes: 4 } }] })).toContainEqual(
      expect.stringContaining("between 16 and 512"),
    );
  });

  test("rejects a bootstrap naming a worker that does not exist", () => {
    expect(problems({ ...base, bootstrap: { worker: "other", endpoint: "/x" } })).toContainEqual(
      expect.stringContaining("not one of this artifact's workers"),
    );
  });

  test("rejects a bootstrap endpoint that is not a path", () => {
    expect(problems({ ...base, bootstrap: { worker: "example", endpoint: "https://x/y" } })).toContainEqual(
      expect.stringContaining("beginning with a slash"),
    );
  });

  test("rejects migrations pointing at a binding that does not exist", () => {
    expect(problems({ ...base, migrations: { binding: "DB", directory: "migrations" } })).toContainEqual(
      expect.stringContaining("not a declared resource binding"),
    );
  });

  test("reports every problem at once", () => {
    expect(problems({ schema_version: 9, name: "Not Valid", runtime: {}, workers: [] }).length).toBeGreaterThan(3);
  });
});
