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
/**
 * Every kind the schema permits, and the list has to stay in step with it.
 *
 * It used to hold the first five. The other seven were unreachable: an artifact
 * declaring one was refused here and never got as far as `terraform/deploy`,
 * which already knew how to bind three of them.
 */
const KINDS = new Set([
  "d1",
  "kv",
  "r2",
  "queue",
  "assets",
  "hyperdrive",
  "vectorize",
  "analytics_engine",
  "ai",
  "browser",
  "version_metadata",
  "ratelimit",
]);

/** `$defs/identifier`. A binding name, and the schema caps it at 64. */
const IDENTIFIER_MAX = 64;
/** `$defs/dnsName`. An app or worker name becomes part of a hostname. */
const DNS_NAME_MAX = 54;
const DESCRIPTION_MAX = 300;
/**
 * Feature names this version implements. Empty, and that is the correct state
 * for a v1 that has no optional behaviour yet: the point of the list is that
 * adding a name here is what makes an artifact using it deployable, so an older
 * tool refuses it instead of deploying most of it.
 */
const FEATURES = new Set<string>([]);
/** `bootstrap.endpoint`. A path with no whitespace in it. */
const ENDPOINT = /^\/[^\s]*$/;

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

/**
 * `additionalProperties: false`, which the schema sets on every object it
 * defines and this file did not check at all.
 *
 * A misspelled key is the failure this catches, and it is a silent one:
 * `descriptionn` on a var, `max_batchsize` on a consumer, `directory` on a d1
 * resource. Nothing reads the key, so nothing complains, and the setting the
 * author believed they had written is simply absent.
 */
const unknownKeys = (
  object: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): string[] => {
  const extra = Object.keys(object).filter((key) => !allowed.includes(key));
  return extra.length === 0 ? [] : [`${at} has ${extra.length === 1 ? "a key" : "keys"} the schema does not define: ${extra.join(", ")}`];
};

/** A list of strings with no repeats, which is `uniqueItems` in the schema. */
const stringList = (value: unknown, at: string, minLength = 0): string[] => {
  if (!Array.isArray(value)) return [`${at} must be a list of strings`];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, item] of value.entries()) {
    if (typeof item !== "string") {
      out.push(`${at}[${i}] must be a string`);
      continue;
    }
    if (item.length < minLength) out.push(`${at}[${i}] must not be empty`);
    if (seen.has(item)) out.push(`${at} lists ${JSON.stringify(item)} twice`);
    seen.add(item);
  }
  return out;
};

/** A whole number inside the schema's bounds. */
const boundedInt = (
  value: unknown,
  at: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): string[] => {
  if (value === undefined) return [];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return [`${at} must be a whole number between ${min} and ${max === Number.MAX_SAFE_INTEGER ? "any" : max}: ${JSON.stringify(value)}`];
  }
  return [];
};

const oneOf = (value: unknown, at: string, allowed: readonly string[]): string[] =>
  value === undefined || allowed.includes(value as string)
    ? []
    : [`${at} must be one of ${allowed.join(", ")}: ${JSON.stringify(value)}`];

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
  } else if (name.length > DNS_NAME_MAX) {
    // It becomes part of a hostname, and a worker's name is derived from it.
    bad(`name must be at most ${DNS_NAME_MAX} characters, found ${name.length}`);
  }

  const description = input["description"];
  if (description !== undefined) {
    if (typeof description !== "string") {
      // It reaches the manifest as an OCI annotation, and annotations are
      // map[string]string. A number here builds cleanly and is refused by any
      // registry that validates the manifest, after the push has begun.
      bad(`description must be a string: ${JSON.stringify(description)}`);
    } else if (description.length > DESCRIPTION_MAX) {
      bad(`description must be at most ${DESCRIPTION_MAX} characters, found ${description.length}`);
    }
  }

  /*
   * `features` is the format's ONLY forward-compatibility mechanism and nothing
   * read it. The schema's contract is that a deployer which does not recognise
   * a feature must refuse rather than deploy a partial configuration, so an
   * artifact naming one has to fail here and not somewhere quieter.
   */
  const features = input["features"];
  if (features !== undefined) {
    for (const message of stringList(features, "features", 1)) bad(message);
    if (Array.isArray(features)) {
      const unknown = features.filter((f) => typeof f === "string" && !FEATURES.has(f));
      if (unknown.length > 0) {
        bad(
          `features names ${unknown.join(", ")}, which this version does not implement. A document naming a feature the tool does not know is refused rather than deployed with that part missing.`,
        );
      }
    }
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
    if (flags !== undefined) for (const message of stringList(flags, "runtime.compatibility_flags", 1)) bad(message);

    const limits = runtime["limits"];
    if (limits !== undefined) {
      if (!isObject(limits)) bad("runtime.limits must be an object");
      else {
        for (const message of boundedInt(limits["cpu_ms"], "runtime.limits.cpu_ms", 1)) bad(message);
        for (const message of unknownKeys(limits, ["cpu_ms"], "runtime.limits")) bad(message);
      }
    }

    const placement = runtime["placement"];
    if (placement !== undefined) {
      if (!isObject(placement)) bad("runtime.placement must be an object");
      else {
        for (const message of oneOf(placement["mode"], "runtime.placement.mode", ["smart"])) bad(message);
        for (const message of unknownKeys(placement, ["mode"], "runtime.placement")) bad(message);
      }
    }

    for (const message of unknownKeys(
      runtime,
      ["compatibility_date", "compatibility_flags", "limits", "placement"],
      "runtime",
    )) {
      bad(message);
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
      } else if (binding.length > IDENTIFIER_MAX) {
        bad(`${at}.binding must be at most ${IDENTIFIER_MAX} characters, found ${binding.length}`);
      } else if (bindings.has(binding)) {
        bad(`${at}.binding is declared twice: ${binding}`);
      } else {
        bindings.add(binding);
      }

      const kind = raw["kind"];
      if (typeof kind !== "string" || !KINDS.has(kind)) {
        bad(`${at}.kind must be one of ${[...KINDS].join(", ")}: ${JSON.stringify(kind)}`);
      }

      // Every kind carries these; the branches below add their own.
      const common = ["binding", "kind", "description", "optional", "rebuildable"];

      if (kind === "assets") {
        if (assetsSeen) bad(`${at} is a second assets binding, and a worker-app may declare one`);
        assetsSeen = true;

        const problem = badPath(raw["directory"]);
        if (problem !== null) bad(`${at}.directory ${problem}`);

        for (const message of oneOf(raw["not_found_handling"], `${at}.not_found_handling`, [
          "none",
          "404-page",
          "single-page-application",
        ])) {
          bad(message);
        }
        for (const message of oneOf(raw["html_handling"], `${at}.html_handling`, [
          "auto-trailing-slash",
          "force-trailing-slash",
          "drop-trailing-slash",
          "none",
        ])) {
          bad(message);
        }
        const first = raw["run_worker_first"];
        if (first !== undefined && typeof first !== "boolean") {
          if (!Array.isArray(first) || first.length === 0) {
            bad(`${at}.run_worker_first must be true, false, or a non-empty list of path globs`);
          } else {
            for (const message of stringList(first, `${at}.run_worker_first`, 1)) bad(message);
          }
        }
        for (const message of unknownKeys(
          raw,
          [...common, "directory", "not_found_handling", "html_handling", "run_worker_first"],
          at,
        )) {
          bad(message);
        }
      } else if (kind === "queue") {
        if (raw["produces"] !== undefined && typeof raw["produces"] !== "boolean") {
          bad(`${at}.produces must be true or false`);
        }
        // NOT `dead_letter`. That is per consumer, on `workers[].consumes`,
        // because two scripts reading one queue can send failures to different
        // places. Here it read as a setting and was never applied.
        for (const message of unknownKeys(raw, [...common, "produces"], at)) bad(message);
      } else if (kind === "ratelimit") {
        for (const message of boundedInt(raw["limit"], `${at}.limit`, 1)) bad(message);
        if (raw["limit"] === undefined) bad(`${at}.limit is required for a ratelimit binding`);
        if (raw["period"] === undefined) bad(`${at}.period is required for a ratelimit binding`);
        else if (raw["period"] !== 10 && raw["period"] !== 60) {
          bad(`${at}.period must be 10 or 60 seconds, which is what the runtime offers: ${JSON.stringify(raw["period"])}`);
        }
        for (const message of unknownKeys(raw, [...common, "limit", "period"], at)) bad(message);
      } else if (typeof kind === "string" && KINDS.has(kind)) {
        for (const message of unknownKeys(raw, common, at)) bad(message);
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
      if (n.length > IDENTIFIER_MAX) {
        bad(`${where}.name must be at most ${IDENTIFIER_MAX} characters, found ${n.length}`);
      }
      if (names.has(n) || bindings.has(n)) {
        bad(`${where}.name collides with another binding: ${n}. One environment key cannot be two things.`);
      }
      names.add(n);

      const d = raw["description"];
      if (d !== undefined && (typeof d !== "string" || d.length > DESCRIPTION_MAX)) {
        bad(`${where}.description must be a string of at most ${DESCRIPTION_MAX} characters`);
      }

      if (at === "vars") {
        for (const message of oneOf(raw["type"], `${where}.type`, ["string", "json"])) bad(message);
        for (const message of unknownKeys(raw, ["name", "description", "optional", "default", "type"], where)) {
          bad(message);
        }
      } else {
        if (raw["one_of"] !== undefined) {
          for (const message of stringList(raw["one_of"], `${where}.one_of`, 1)) bad(message);
        }
        for (const message of unknownKeys(raw, ["name", "description", "optional", "generate", "one_of"], where)) {
          bad(message);
        }
      }
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
      } else if (n.length > DNS_NAME_MAX) {
        // A worker's script name is derived from it, so it is a hostname part too.
        bad(`${at}.name must be at most ${DNS_NAME_MAX} characters, found ${n.length}`);
      } else if (workerNames.has(n)) {
        bad(`${at}.name is used twice: ${n}`);
      } else {
        workerNames.add(n);
      }

      const problem = badPath(raw["main"]);
      if (problem !== null) bad(`${at}.main ${problem}`);

      /*
       * `modules[].path` GOES THROUGH THE SAME CHECK, and it did not.
       * `build` feeds every module path straight to `collect`, which resolves it
       * against the build root, so a document carrying
       * `modules: [{ path: "../secret/creds.txt" }]` pulled that file into the
       * pushed layer. The schema has always constrained it; only this side was
       * missing, and this is the produce side, so nothing downstream could catch
       * it: `pull` refuses a `..` on unpack, long after the bytes were published.
       */
      const modules = raw["modules"];
      if (modules !== undefined) {
        if (!Array.isArray(modules)) bad(`${at}.modules must be a list`);
        else
          for (const [j, m] of modules.entries()) {
            const where = `${at}.modules[${j}]`;
            if (!isObject(m)) {
              bad(`${where} must be an object`);
              continue;
            }
            const bad_ = badPath(m["path"]);
            if (bad_ !== null) bad(`${where}.path ${bad_}`);
            if (m["content_type"] !== undefined && typeof m["content_type"] !== "string") {
              bad(`${where}.content_type must be a string`);
            }
            unknownKeys(m, ["path", "content_type"], where);
          }
      }

      const bindingList = raw["bindings"];
      if (bindingList !== undefined) {
        for (const message of stringList(bindingList, `${at}.bindings`, 1)) bad(message);
        if (Array.isArray(bindingList))
          for (const b of bindingList) {
            if (typeof b === "string" && !bindings.has(b)) {
              bad(`${at}.bindings names ${JSON.stringify(b)}, which is not a declared resource binding`);
            }
          }
      }

      /*
       * A consumer is a binding name OR an object carrying that name and the
       * subscription's settings. The object form is what the schema has always
       * defined and what `terraform/deploy` normalises; this refused it, so a
       * document that set `max_batch_size` could not be built.
       */
      const consumes = raw["consumes"];
      if (consumes !== undefined) {
        if (!Array.isArray(consumes)) bad(`${at}.consumes must be a list`);
        else
          for (const [j, entry] of consumes.entries()) {
            const where = `${at}.consumes[${j}]`;
            const binding = typeof entry === "string" ? entry : isObject(entry) ? entry["binding"] : undefined;
            if (typeof binding !== "string") {
              bad(`${where} must be a binding name or an object carrying one`);
              continue;
            }
            if (!bindings.has(binding)) {
              bad(`${where} names ${JSON.stringify(binding)}, which is not a declared resource binding`);
              continue;
            }
            const found = Array.isArray(resources)
              ? resources.find((r) => isObject(r) && r["binding"] === binding)
              : undefined;
            if (isObject(found) && found["kind"] !== "queue") {
              bad(`${where} names ${binding}, which is a ${String(found["kind"])} rather than a queue`);
            }
            if (isObject(entry)) {
              // The bounds are the platform's, not this tool's: a batch of 5000
              // or a concurrency of zero is refused by the API, and refusing it
              // here costs one plan rather than one failed apply.
              const bounds: [string, number, number][] = [
                ["max_batch_size", 1, 100],
                ["max_batch_timeout", 0, 60],
                ["max_retries", 0, 100],
                ["max_concurrency", 1, Number.MAX_SAFE_INTEGER],
                ["retry_delay", 0, Number.MAX_SAFE_INTEGER],
              ];
              for (const [key, min, max] of bounds) {
                for (const message of boundedInt(entry[key], `${where}.${key}`, min, max)) bad(message);
              }
              if (entry["dead_letter"] !== undefined && typeof entry["dead_letter"] !== "boolean") {
                bad(`${where}.dead_letter must be true or false`);
              }
              for (const message of unknownKeys(
                entry,
                ["binding", "dead_letter", ...bounds.map(([key]) => key)],
                where,
              )) {
                bad(message);
              }
            }
          }
      }

      const crons = raw["crons"];
      if (crons !== undefined) for (const message of stringList(crons, `${at}.crons`, 1)) bad(message);

      if (raw["routable"] !== undefined && typeof raw["routable"] !== "boolean") {
        bad(`${at}.routable must be true or false`);
      }

      for (const message of unknownKeys(
        raw,
        ["name", "main", "modules", "bindings", "consumes", "crons", "routable", "description"],
        at,
      )) {
        bad(message);
      }
    }
  }

  // ── migrations and bootstrap ──────────────────────────────────────────────

  /*
   * A LIST, one entry per database. This read a single object, which is the
   * whole of what an artifact with one database needs and is not what the
   * schema says: an artifact may carry a schema for more than one D1 binding,
   * and there is no reason for the document to be able to name only the first.
   */
  const migrations = input["migrations"];
  if (migrations !== undefined) {
    if (!Array.isArray(migrations)) {
      bad("migrations must be a list, one entry per database");
    } else {
      const seenBinding = new Set<string>();
      for (const [i, entry] of migrations.entries()) {
        const at = `migrations[${i}]`;
        if (!isObject(entry)) {
          bad(`${at} must be an object`);
          continue;
        }
        const binding = entry["binding"];
        if (typeof binding !== "string" || !bindings.has(binding)) {
          bad(`${at}.binding names ${JSON.stringify(binding)}, which is not a declared resource binding`);
        } else if (seenBinding.has(binding)) {
          bad(`${at}.binding names ${binding} a second time, and one database has one migrations directory`);
        } else {
          seenBinding.add(binding);
        }
        const problem = badPath(entry["directory"]);
        if (problem !== null) bad(`${at}.directory ${problem}`);
        for (const message of unknownKeys(entry, ["binding", "directory"], at)) bad(message);
      }
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
      if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint)) {
        bad(`bootstrap.endpoint must be a path beginning with a slash and holding no whitespace: ${JSON.stringify(endpoint)}`);
      }
      if (bootstrap["env"] !== undefined) {
        for (const message of stringList(bootstrap["env"], "bootstrap.env", 1)) bad(message);
      }
      for (const message of unknownKeys(bootstrap, ["worker", "endpoint", "env"], "bootstrap")) bad(message);
    }
  }

  for (const message of unknownKeys(
    input,
    [
      "schema_version",
      "name",
      "description",
      "features",
      "runtime",
      "resources",
      "vars",
      "secrets",
      "workers",
      "migrations",
      "bootstrap",
    ],
    "the document",
  )) {
    bad(message);
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
  for (const m of app.migrations ?? []) paths.push(m.directory);
  return paths;
};

export type { Resource, SecretDecl, VarDecl, WorkerApp, WorkerDecl };
