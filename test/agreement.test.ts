/**
 * The validator and the schema, checked against each other on the same inputs.
 *
 * `schema/worker-app.v1.json` is normative and `src/config.ts` exists to say the
 * same things with messages worth reading. They drifted: for a while the
 * validator refused seven resource kinds the schema permits, and separately let
 * through 22 documents the schema rejects. Each row below is a document that was
 * accepted by one side and refused by the other.
 *
 * The five cross-references at the bottom go the other way on purpose. JSON
 * Schema cannot express "this name refers to a binding declared elsewhere in the
 * document", so the validator is stricter there and the schema's prose says so.
 */
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

const refused = (label: string, document: unknown, expected: string): void => {
  test(label, () => {
    expect(problems(document)).toContainEqual(expect.stringContaining(expected));
  });
};

describe("constraints the schema states and the validator now enforces", () => {
  refused("a binding longer than 64 characters", { ...base, resources: [{ binding: "B".repeat(80), kind: "d1" }] }, "at most 64 characters");

  refused("an app name longer than 54 characters", { ...base, name: "a".repeat(60) }, "at most 54 characters");

  refused(
    "a worker name longer than 54 characters",
    { ...base, workers: [{ name: "a".repeat(60), main: "dist/index.js" }] },
    "at most 54 characters",
  );

  // It reaches the manifest as an OCI annotation, and annotations are
  // map[string]string. A number here used to build cleanly.
  refused("a description that is not a string", { ...base, description: 42 }, "description must be a string");

  refused("a description longer than 300 characters", { ...base, description: "x".repeat(400) }, "at most 300 characters");

  refused(
    "a misspelled key on a var",
    { ...base, vars: [{ name: "PUBLIC_URL", descriptionn: "typo" }] },
    "the schema does not define",
  );

  refused(
    "a directory on a d1 resource, which only assets carries",
    { ...base, resources: [{ binding: "DB", kind: "d1", directory: "public" }] },
    "the schema does not define",
  );

  refused("a ratelimit with neither of its required settings", { ...base, resources: [{ binding: "R", kind: "ratelimit" }] }, "is required");

  refused("a var type outside the enum", { ...base, vars: [{ name: "V", type: "yaml" }] }, "must be one of string, json");

  // `inspect` calls `.join` on it, so a string reaches a runtime error rather
  // than a message.
  refused("one_of given as a string", { ...base, secrets: [{ name: "K", one_of: "B" }] }, "must be a list of strings");

  refused(
    "a module path that climbs out of the content root",
    { ...base, workers: [{ name: "example", main: "dist/index.js", modules: [{ path: "../secret/creds.txt" }] }] },
    "must not contain a `..` segment",
  );

  refused(
    "a module with no path",
    { ...base, workers: [{ name: "example", main: "dist/index.js", modules: [{}] }] },
    "must be a non-empty string",
  );

  refused(
    "an absolute module path",
    { ...base, workers: [{ name: "example", main: "dist/index.js", modules: [{ path: "/etc/passwd" }] }] },
    "must be relative to the content root",
  );

  refused(
    "a bootstrap endpoint holding whitespace",
    { ...base, bootstrap: { worker: "example", endpoint: "/a b" } },
    "no whitespace",
  );

  const queue = { ...base, resources: [{ binding: "EVENTS", kind: "queue" }] };
  const consumer = (over: Record<string, unknown>) => ({
    ...queue,
    workers: [{ name: "example", main: "dist/index.js", consumes: [{ binding: "EVENTS", ...over }] }],
  });

  refused("a batch larger than the platform allows", consumer({ max_batch_size: 5000 }), "max_batch_size");
  refused("a concurrency of zero", consumer({ max_concurrency: 0 }), "max_concurrency");
  refused("a misspelled consumer setting", consumer({ max_batchsize: 5 }), "the schema does not define");

  refused(
    "a binding listed twice on one worker",
    {
      ...base,
      resources: [{ binding: "DB", kind: "d1" }],
      workers: [{ name: "example", main: "dist/index.js", bindings: ["DB", "DB"] }],
    },
    "twice",
  );

  refused(
    "an empty cron expression",
    { ...base, workers: [{ name: "example", main: "dist/index.js", crons: [""] }] },
    "must not be empty",
  );

  refused(
    "a compatibility flag listed twice",
    { ...base, runtime: { compatibility_date: "2026-07-14", compatibility_flags: ["a", "a"] } },
    "twice",
  );

  refused(
    "an html_handling outside the enum",
    { ...base, resources: [{ binding: "ASSETS", kind: "assets", directory: "public", html_handling: "nope" }] },
    "must be one of",
  );

  refused(
    "an empty run_worker_first list",
    { ...base, resources: [{ binding: "ASSETS", kind: "assets", directory: "public", run_worker_first: [] }] },
    "non-empty list",
  );

  refused("a cpu_ms of zero", { ...base, runtime: { compatibility_date: "2026-07-14", limits: { cpu_ms: 0 } } }, "cpu_ms");

  refused(
    "a placement mode outside the enum",
    { ...base, runtime: { compatibility_date: "2026-07-14", placement: { mode: "dumb" } } },
    "must be one of smart",
  );
});

/**
 * `features` is the format's only forward-compatibility mechanism, and the
 * schema's contract is that a deployer which does not recognise one refuses
 * rather than deploying a partial configuration. Nothing read it.
 */
describe("features", () => {
  test("an empty list is fine", () => {
    expect(problems({ ...base, features: [] })).toEqual([]);
  });

  refused("a feature this version does not implement", { ...base, features: ["something-new"] }, "does not implement");
});

/**
 * Cross-references JSON Schema cannot express, so the validator is stricter than
 * the schema here on purpose. A third-party tool validating against the schema
 * alone accepts these; this one does not, and the schema's prose says so.
 */
describe("cross-references the schema cannot state", () => {
  refused(
    "a binding declared twice",
    {
      ...base,
      resources: [
        { binding: "DB", kind: "d1" },
        { binding: "DB", kind: "kv" },
      ],
    },
    "declared twice",
  );

  refused(
    "a var whose name collides with a binding",
    { ...base, resources: [{ binding: "DB", kind: "d1" }], vars: [{ name: "DB" }] },
    "collides with another binding",
  );

  refused(
    "a worker binding that is not declared",
    { ...base, workers: [{ name: "example", main: "dist/index.js", bindings: ["NOPE"] }] },
    "not a declared resource binding",
  );

  refused(
    "a second assets resource",
    {
      ...base,
      resources: [
        { binding: "A", kind: "assets", directory: "a" },
        { binding: "B", kind: "assets", directory: "b" },
      ],
    },
    "second assets binding",
  );

  refused("a bootstrap naming a worker this artifact does not ship", { ...base, bootstrap: { worker: "other", endpoint: "/x" } }, "not one of this artifact's workers");
});
