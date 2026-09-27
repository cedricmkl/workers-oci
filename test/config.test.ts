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

  test("rejects a generate block that is too small", () => {
    expect(problems({ ...base, secrets: [{ name: "K", generate: { bytes: 4 } }] })).toContainEqual(
      expect.stringContaining("between 16 and 512"),
    );
  });

  test("rejects a bootstrap naming a worker that does not exist", () => {
    expect(problems({ ...base, bootstrap: [{ name: "seed", worker: "other", endpoint: "/x" }] })).toContainEqual(
      expect.stringContaining("not one of this artifact's workers"),
    );
  });

  test("rejects a bootstrap endpoint that is not a path", () => {
    expect(problems({ ...base, bootstrap: [{ name: "seed", worker: "example", endpoint: "https://x/y" }] })).toContainEqual(
      expect.stringContaining("beginning with a slash"),
    );
  });

  test("rejects migrations pointing at a binding that does not exist", () => {
    expect(problems({ ...base, migrations: [{ binding: "DB", directory: "migrations" }] })).toContainEqual(
      expect.stringContaining("not a declared resource binding"),
    );
  });

  test("reports every problem at once", () => {
    expect(problems({ schema_version: 9, name: "Not Valid", runtime: {}, workers: [] }).length).toBeGreaterThan(3);
  });
});

/**
 * THE VALIDATOR AND THE SCHEMA ARE ONE SET OF RULES, and for a while they were
 * not. `schema/worker-app.v1.json` is normative; this file existed to say the
 * same things with messages worth reading, and had quietly become a narrower
 * document format: seven of the twelve resource kinds were refused, the object
 * form of `consumes` was refused, and `migrations` was read as a single object.
 * An artifact using any of them passed CI's schema job and could not be built.
 */
describe("agreement with the normative schema", () => {
  const queue = { ...base, resources: [{ binding: "EVENTS", kind: "queue" }] };

  test.each(["hyperdrive", "vectorize", "analytics_engine", "ai", "browser", "version_metadata"])(
    "accepts the %s kind",
    (kind) => {
      expect(problems({ ...base, resources: [{ binding: "THING", kind }] })).toEqual([]);
    },
  );

  test("accepts a ratelimit binding with its two required settings", () => {
    expect(
      problems({ ...base, resources: [{ binding: "THROTTLE", kind: "ratelimit", limit: 100, period: 60 }] }),
    ).toEqual([]);
  });

  test("rejects a ratelimit period the runtime does not offer", () => {
    expect(
      problems({ ...base, resources: [{ binding: "THROTTLE", kind: "ratelimit", limit: 100, period: 30 }] }),
    ).toContainEqual(expect.stringContaining("must be 10 or 60 seconds"));
  });

  test("accepts a consumer as a bare binding name", () => {
    expect(
      problems({ ...queue, workers: [{ name: "example", main: "dist/index.js", consumes: ["EVENTS"] }] }),
    ).toEqual([]);
  });

  test("accepts a consumer as an object carrying its settings", () => {
    expect(
      problems({
        ...queue,
        workers: [
          {
            name: "example",
            main: "dist/index.js",
            consumes: [{ binding: "EVENTS", dead_letter: true, max_batch_size: 10, max_retries: 3 }],
          },
        ],
      }),
    ).toEqual([]);
  });

  test("rejects a consumer object naming a binding that is not a queue", () => {
    expect(
      problems({
        ...base,
        resources: [{ binding: "DB", kind: "d1" }],
        workers: [{ name: "example", main: "dist/index.js", consumes: [{ binding: "DB" }] }],
      }),
    ).toContainEqual(expect.stringContaining("which is a d1 rather than a queue"));
  });

  test("rejects a consumer setting that is not a whole number", () => {
    expect(
      problems({
        ...queue,
        workers: [
          { name: "example", main: "dist/index.js", consumes: [{ binding: "EVENTS", max_batch_size: "ten" }] },
        ],
      }),
    ).toContainEqual(expect.stringContaining("max_batch_size"));
  });

  test("accepts migrations for more than one database", () => {
    expect(
      problems({
        ...base,
        resources: [
          { binding: "MAIN", kind: "d1" },
          { binding: "AUDIT", kind: "d1" },
        ],
        migrations: [
          { binding: "MAIN", directory: "migrations/main" },
          { binding: "AUDIT", directory: "migrations/audit" },
        ],
      }),
    ).toEqual([]);
  });

  test("rejects two migration directories for one database", () => {
    expect(
      problems({
        ...base,
        resources: [{ binding: "MAIN", kind: "d1" }],
        migrations: [
          { binding: "MAIN", directory: "migrations/a" },
          { binding: "MAIN", directory: "migrations/b" },
        ],
      }),
    ).toContainEqual(expect.stringContaining("a second time"));
  });

  test("rejects migrations that are not a list", () => {
    expect(
      problems({ ...base, resources: [{ binding: "DB", kind: "d1" }], migrations: { binding: "DB", directory: "m" } }),
    ).toContainEqual(expect.stringContaining("must be a list"));
  });
})

/**
 * A Durable Object is a binding AND a class lifecycle. The binding is a resource
 * like any other; the lifecycle is the worker's `durable_object_migrations`,
 * applied by Cloudflare when the version carrying them is deployed. Each refusal
 * below is a document that would otherwise reach the API and fail there, or
 * worse, deploy without the namespace its code expects.
 */
describe("Durable Objects", () => {
  const live = {
    ...base,
    features: ["durable_objects"],
    resources: [{ binding: "LIVE", kind: "durable_object", class_name: "Live" }],
    workers: [
      { name: "w", main: "dist/i.js", durable_object_migrations: [{ tag: "v1", new_sqlite_classes: ["Live"] }] },
    ],
  };

  test("accepts a binding to a class its worker's migration creates", () => {
    expect(problems(live)).toEqual([]);
  });

  test("accepts a class that a later step renames into existence", () => {
    expect(
      problems({
        ...live,
        workers: [
          {
            name: "w",
            main: "dist/i.js",
            durable_object_migrations: [
              { tag: "v1", new_sqlite_classes: ["Old"] },
              { tag: "v2", renamed_classes: [{ from: "Old", to: "Live" }] },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });

  test("refuses a document that does not name the feature", () => {
    const { features: _, ...without } = live;
    expect(problems(without)).toContainEqual(expect.stringContaining('"durable_objects" feature'));
  });

  test("refuses migrations alone without the feature, since an older deployer would skip them", () => {
    expect(
      problems({
        ...base,
        workers: [{ name: "w", main: "dist/i.js", durable_object_migrations: [{ tag: "v1", new_sqlite_classes: ["A"] }] }],
      }),
    ).toContainEqual(expect.stringContaining('"durable_objects" feature'));
  });

  test("refuses a binding to a class no migration creates", () => {
    expect(
      problems({ ...live, resources: [{ binding: "LIVE", kind: "durable_object", class_name: "Other" }] }),
    ).toContainEqual(expect.stringContaining("no durable_object_migrations entry on worker w creates"));
  });

  test("refuses a binding to a class a later step deletes", () => {
    expect(
      problems({
        ...live,
        workers: [
          {
            name: "w",
            main: "dist/i.js",
            durable_object_migrations: [
              { tag: "v1", new_sqlite_classes: ["Live"] },
              { tag: "v2", deleted_classes: ["Live"] },
            ],
          },
        ],
      }),
    ).toContainEqual(expect.stringContaining("no durable_object_migrations entry"));
  });

  test("refuses a binding without a class name", () => {
    expect(problems({ ...live, resources: [{ binding: "LIVE", kind: "durable_object" }] })).toContainEqual(
      expect.stringContaining("class_name"),
    );
  });

  test("refuses a tag used twice", () => {
    expect(
      problems({
        ...live,
        workers: [
          {
            name: "w",
            main: "dist/i.js",
            durable_object_migrations: [
              { tag: "v1", new_sqlite_classes: ["Live"] },
              { tag: "v1", new_sqlite_classes: ["Other"] },
            ],
          },
        ],
      }),
    ).toContainEqual(expect.stringContaining("used twice"));
  });

  test("refuses a step that changes nothing", () => {
    expect(
      problems({
        ...live,
        workers: [
          { name: "w", main: "dist/i.js", durable_object_migrations: [{ tag: "v1", new_sqlite_classes: ["Live"] }, { tag: "v2" }] },
        ],
      }),
    ).toContainEqual(expect.stringContaining("changes nothing"));
  });

  test("refuses a misspelled step key", () => {
    expect(
      problems({
        ...live,
        workers: [
          {
            name: "w",
            main: "dist/i.js",
            durable_object_migrations: [{ tag: "v1", new_sqlite_classes: ["Live"], new_sqlite_class: ["X"] }],
          },
        ],
      }),
    ).toContainEqual(expect.stringContaining("the schema does not define"));
  });

  test("requires the owning worker when the artifact ships two", () => {
    expect(
      problems({
        ...live,
        workers: [...live.workers, { name: "other", main: "dist/o.js" }],
      }),
    ).toContainEqual(expect.stringContaining(".worker is required"));
  });

  test("refuses a second worker naming the binding", () => {
    expect(
      problems({
        ...live,
        resources: [{ binding: "LIVE", kind: "durable_object", class_name: "Live", worker: "w" }],
        workers: [...live.workers, { name: "other", main: "dist/o.js", bindings: ["LIVE"] }],
      }),
    ).toContainEqual(expect.stringContaining("only deployed on the worker that owns the class"));
  });

  test("refuses class_name on a kind other than durable_object", () => {
    expect(
      problems({ ...base, resources: [{ binding: "DB", kind: "d1", class_name: "X" }] }),
    ).toContainEqual(expect.stringContaining("the schema does not define"));
  });
});
