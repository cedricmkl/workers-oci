import type { Resource, SecretDecl, VarDecl, WorkerApp, WorkerDecl } from "./types.js";

/**
 * Checking a config document.
 *
 * schema/worker-app.v1.json is the normative description and is what a CI job
 * should validate against. This is the same set of rules with messages worth
 * reading, so `build` can refuse early and say why.
 */

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the config document has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(["d1", "kv", "r2", "queue", "assets"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Paths inside the content layer. A leading slash or a `..` segment would let an
 * artifact write outside the directory it was unpacked into, so both are refused
 * here rather than at unpack time on somebody else's machine.
 */
const badPath = (path: unknown): string | null => {
  if (typeof path !== "string" || path === "") return "must be a non-empty string";
  if (path.startsWith("/")) return "must be relative to the content root";
  if (path.split("/").includes("..")) return "must not contain a `..` segment";
  if (path.includes("\\")) return "must use forward slashes";
  return null;
};

export const validate = (input: unknown): WorkerApp => {
  const p: string[] = [];
  const bad = (message: string): void => void p.push(message);

  if (!isObject(input)) throw new ConfigError(["the document is not an object"]);

  if (input["schema_version"] !== 1) {
    bad(`schema_version must be 1, found ${JSON.stringify(input["schema_version"])}`);
  }

  const name = input["name"];
  if (typeof name !== "string" || !NAME.test(name)) {
    bad(`name must be lowercase letters, digits and dashes: ${JSON.stringify(name)}`);
  }

  // ── runtime ───────────────────────────────────────────────────────────────

  const runtime = input["runtime"];
  if (!isObject(runtime)) {
    bad("runtime is required and must be an object");
  } else {
    const date = runtime["compatibility_date"];
    if (typeof date !== "string" || !DATE.test(date)) {
      bad(`runtime.compatibility_date must be a YYYY-MM-DD date: ${JSON.stringify(date)}`);
    }
    const flags = runtime["compatibility_flags"];
    if (flags !== undefined && (!Array.isArray(flags) || flags.some((f) => typeof f !== "string"))) {
      bad("runtime.compatibility_flags must be a list of strings");
    }
  }

  // ── resources ─────────────────────────────────────────────────────────────

  const resources = input["resources"] ?? [];
  const bindings = new Set<string>();
  let assetsSeen = false;

  if (!Array.isArray(resources)) {
    bad("resources must be a list");
  } else {
    for (const [i, raw] of resources.entries()) {
      const at = `resources[${i}]`;
      if (!isObject(raw)) {
        bad(`${at} must be an object`);
        continue;
      }
      const binding = raw["binding"];
      if (typeof binding !== "string" || !BINDING.test(binding)) {
        bad(`${at}.binding must be a JavaScript identifier: ${JSON.stringify(binding)}`);
      } else if (bindings.has(binding)) {
        bad(`${at}.binding is declared twice: ${binding}`);
      } else {
        bindings.add(binding);
      }

      const kind = raw["kind"];
      if (typeof kind !== "string" || !KINDS.has(kind)) {
        bad(`${at}.kind must be one of ${[...KINDS].join(", ")}: ${JSON.stringify(kind)}`);
      }

      if (kind === "assets") {
        if (assetsSeen) bad(`${at} is a second assets binding, and a worker-app may declare one`);
        assetsSeen = true;

        const problem = badPath(raw["directory"]);
        if (problem !== null) bad(`${at}.directory ${problem}`);

        const handling = raw["not_found_handling"];
        if (
          handling !== undefined &&
          !["none", "404-page", "single-page-application"].includes(handling as string)
        ) {
          bad(`${at}.not_found_handling is not a known value: ${JSON.stringify(handling)}`);
        }
      }

      if (kind === "durable_object" || raw["class_name"] !== undefined) {
        bad(
          `${at} declares a Durable Object. The Cloudflare provider cannot create a worker version that declares one (terraform-provider-cloudflare#6852), so workers-oci v1 cannot deploy it.`,
        );
      }
    }
  }

  // ── vars and secrets ──────────────────────────────────────────────────────

  const names = new Set<string>();

  const checkNamed = (list: unknown, at: string): void => {
    if (list === undefined) return;
    if (!Array.isArray(list)) {
      bad(`${at} must be a list`);
      return;
    }
    for (const [i, raw] of list.entries()) {
      const where = `${at}[${i}]`;
      if (!isObject(raw)) {
        bad(`${where} must be an object`);
        continue;
      }
      const n = raw["name"];
      if (typeof n !== "string" || !BINDING.test(n)) {
        bad(`${where}.name must be a JavaScript identifier: ${JSON.stringify(n)}`);
        continue;
      }
      if (names.has(n) || bindings.has(n)) {
        bad(`${where}.name collides with another binding: ${n}. One environment key cannot be two things.`);
      }
      names.add(n);
    }
  };

  checkNamed(input["vars"], "vars");
  checkNamed(input["secrets"], "secrets");

  const secrets = input["secrets"];
  if (Array.isArray(secrets)) {
    for (const [i, raw] of secrets.entries()) {
      if (!isObject(raw)) continue;
      const gen = raw["generate"];
      if (gen === undefined) continue;
      if (!isObject(gen)) {
        bad(`secrets[${i}].generate must be an object`);
        continue;
      }
      const bytes = gen["bytes"];
      if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 16 || bytes > 512) {
        bad(`secrets[${i}].generate.bytes must be a whole number between 16 and 512: ${JSON.stringify(bytes)}`);
      }
      const encoding = gen["encoding"];
      if (encoding !== undefined && !["base64", "base64url", "hex"].includes(encoding as string)) {
        bad(`secrets[${i}].generate.encoding is not a known value: ${JSON.stringify(encoding)}`);
      }
    }
  }

  // ── workers ───────────────────────────────────────────────────────────────

  const workers = input["workers"];
  const workerNames = new Set<string>();

  if (!Array.isArray(workers) || workers.length === 0) {
    bad("workers must be a list with at least one entry");
  } else {
    for (const [i, raw] of workers.entries()) {
      const at = `workers[${i}]`;
      if (!isObject(raw)) {
        bad(`${at} must be an object`);
        continue;
      }
      const n = raw["name"];
      if (typeof n !== "string" || !NAME.test(n)) {
        bad(`${at}.name must be lowercase letters, digits and dashes: ${JSON.stringify(n)}`);
      } else if (workerNames.has(n)) {
        bad(`${at}.name is used twice: ${n}`);
      } else {
        workerNames.add(n);
      }

      const problem = badPath(raw["main"]);
      if (problem !== null) bad(`${at}.main ${problem}`);

      for (const key of ["bindings", "consumes"] as const) {
        const list = raw[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          bad(`${at}.${key} must be a list`);
          continue;
        }
        for (const b of list) {
          if (typeof b !== "string" || !bindings.has(b)) {
            bad(`${at}.${key} names ${JSON.stringify(b)}, which is not a declared resource binding`);
          }
        }
      }

      const consumes = raw["consumes"];
      if (Array.isArray(consumes) && Array.isArray(resources)) {
        for (const b of consumes) {
          const found = resources.find((r) => isObject(r) && r["binding"] === b);
          if (isObject(found) && found["kind"] !== "queue") {
            bad(`${at}.consumes names ${String(b)}, which is a ${String(found["kind"])} rather than a queue`);
          }
        }
      }

      const crons = raw["crons"];
      if (crons !== undefined && (!Array.isArray(crons) || crons.some((c) => typeof c !== "string"))) {
        bad(`${at}.crons must be a list of cron expressions`);
      }
    }
  }

  // ── migrations and bootstrap ──────────────────────────────────────────────

  const migrations = input["migrations"];
  if (migrations !== undefined) {
    if (!isObject(migrations)) {
      bad("migrations must be an object");
    } else {
      const binding = migrations["binding"];
      if (typeof binding !== "string" || !bindings.has(binding)) {
        bad(`migrations.binding names ${JSON.stringify(binding)}, which is not a declared resource binding`);
      }
      const problem = badPath(migrations["directory"]);
      if (problem !== null) bad(`migrations.directory ${problem}`);
    }
  }

  const bootstrap = input["bootstrap"];
  if (bootstrap !== undefined) {
    if (!isObject(bootstrap)) {
      bad("bootstrap must be an object");
    } else {
      const worker = bootstrap["worker"];
      if (typeof worker !== "string" || !workerNames.has(worker)) {
        bad(`bootstrap.worker names ${JSON.stringify(worker)}, which is not one of this artifact's workers`);
      }
      const endpoint = bootstrap["endpoint"];
      if (typeof endpoint !== "string" || !endpoint.startsWith("/")) {
        bad(`bootstrap.endpoint must be a path beginning with a slash: ${JSON.stringify(endpoint)}`);
      }
    }
  }

  if (p.length > 0) throw new ConfigError(p);
  return input as unknown as WorkerApp;
};

/** Every file path the document refers to, so `build` can check they are shipped. */
export const referencedPaths = (app: WorkerApp): string[] => {
  const paths: string[] = [];
  for (const w of app.workers as WorkerDecl[]) {
    paths.push(w.main);
    for (const m of w.modules ?? []) paths.push(m.path);
  }
  for (const r of (app.resources ?? []) as Resource[]) {
    if (r.kind === "assets" && r.directory !== undefined) paths.push(r.directory);
  }
  if (app.migrations !== undefined) paths.push(app.migrations.directory);
  return paths;
};

export type { Resource, SecretDecl, VarDecl, WorkerApp, WorkerDecl };
