import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CredentialSource } from "./auth.js";
import { parseReference } from "./reference.js";
import { Registry } from "./registry.js";
import { CONFIG_TYPE, type Manifest, type WorkerApp } from "./types.js";

export type Inspection = {
  /** Null for a pulled directory, which carries the unpacked tree and no manifest. */
  readonly manifest: Manifest | null;
  readonly digest: string | null;
  readonly app: WorkerApp;
};

/**
 * A reference reads from the registry; a path reads a directory on disk.
 *
 * TWO SHAPES, and it only understood one. `build --out` writes `manifest.json`
 * beside `config.json`; `pull --into` writes the unpacked tree with the config
 * document under its published name, `worker-app.json`, and no manifest. So
 * `inspect` on a pulled artifact fell through to the reference parser and
 * reported the directory as a malformed repository name.
 */
export const inspect = async (target: string, credential?: CredentialSource): Promise<Inspection> => {
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

  const local = (() => {
    const dir = resolve(target);
    // The manifest is present for a built directory and absent for a pulled one,
    // which is why it does not decide whether this is a local artifact.
    let manifest: Manifest | null = null;
    try {
      manifest = read(join(dir, "manifest.json")) as Manifest;
    } catch {
      manifest = null;
    }
    for (const name of ["config.json", "worker-app.json"]) {
      try {
        return { manifest, app: read(join(dir, name)) as WorkerApp, digest: null };
      } catch {
        // The next name, or the registry.
      }
    }
    return null;
  })();

  if (local !== null) return local;

  const ref = parseReference(target);
  const registry = new Registry(ref.registry, credential);
  const { manifest, digest } = await registry.pullManifest(ref.repository, ref.digest ?? ref.tag ?? "latest");

  if (manifest.config.mediaType !== CONFIG_TYPE) {
    throw new Error(`not a worker-app: the config blob is ${manifest.config.mediaType}`);
  }

  const blob = await registry.pullBlob(ref.repository, manifest.config.digest);
  return { manifest, digest, app: JSON.parse(new TextDecoder().decode(blob)) as WorkerApp };
};

const bytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;

export const describe = ({ manifest, digest, app }: Inspection): string => {
  const lines: string[] = [];
  const a = manifest?.annotations ?? {};

  lines.push(`${app.name}${a["org.opencontainers.image.version"] ? ` ${a["org.opencontainers.image.version"]}` : ""}`);
  if (app.description !== undefined) lines.push(`  ${app.description}`);
  lines.push("");

  if (digest !== null) lines.push(`  digest       ${digest}`);
  lines.push(`  created      ${a["org.opencontainers.image.created"] ?? "unknown"}`);
  if (a["org.opencontainers.image.revision"] !== undefined) lines.push(`  revision     ${a["org.opencontainers.image.revision"]}`);
  if (a["org.opencontainers.image.source"] !== undefined) lines.push(`  source       ${a["org.opencontainers.image.source"]}`);
  // Not "compressed". The layer is an uncompressed tar on purpose, and calling
  // the number compressed made it read as the smaller of two figures. A pulled
  // directory has no manifest, so it has no size to report either.
  if (manifest !== null) lines.push(`  content      ${bytes(manifest.layers[0]?.size ?? 0)}`);
  lines.push(`  runtime      compatibility date ${app.runtime.compatibility_date}`);
  if ((app.runtime.compatibility_flags ?? []).length > 0) {
    lines.push(`               flags ${(app.runtime.compatibility_flags ?? []).join(", ")}`);
  }
  if (app.runtime.cache !== undefined) {
    const cache = app.runtime.cache;
    // Only what the document actually says. Neither member has a default here,
    // so printing one it left out would report a decision nobody made.
    const stated = [
      cache.enabled === undefined ? null : `edge cache ${cache.enabled ? "on" : "off"}`,
      cache.cross_version_cache === undefined
        ? null
        : `across versions ${cache.cross_version_cache ? "shared" : "not shared"}`,
    ].filter((one): one is string => one !== null);
    if (stated.length > 0) lines.push(`               ${stated.join(", ")}`);
  }
  lines.push("");

  lines.push("  workers");
  for (const w of app.workers) {
    const notes = [
      w.crons !== undefined && w.crons.length > 0 ? `cron ${w.crons.join(", ")}` : null,
      // A consumer is a binding name or an object carrying one, and the screen
      // wants the name either way.
      w.consumes !== undefined && w.consumes.length > 0
        ? `consumes ${w.consumes.map((c) => (typeof c === "string" ? c : c.binding)).join(", ")}`
        : null,
      w.routable === false ? "not routable" : null,
    ].filter((n): n is string => n !== null);
    lines.push(`    ${w.name.padEnd(16)} ${w.main}${notes.length > 0 ? `  (${notes.join("; ")})` : ""}`);
  }

  if ((app.resources ?? []).length > 0) {
    lines.push("");
    lines.push("  resources");
    for (const r of app.resources ?? []) {
      const notes = [
        r.optional === true ? "optional" : null,
        r.rebuildable === true ? "rebuildable" : null,
        r.directory !== undefined ? `from ${r.directory}` : null,
      ].filter((n): n is string => n !== null);
      lines.push(`    ${r.binding.padEnd(16)} ${r.kind}${notes.length > 0 ? `  (${notes.join("; ")})` : ""}`);
    }
  }

  if ((app.vars ?? []).length > 0) {
    lines.push("");
    lines.push("  vars the deployment supplies");
    for (const v of app.vars ?? []) {
      const notes = [v.optional === true ? "optional" : null, v.default !== undefined ? `default ${v.default}` : null]
        .filter((n): n is string => n !== null);
      lines.push(`    ${v.name.padEnd(16)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
    }
  }

  if ((app.secrets ?? []).length > 0) {
    lines.push("");
    lines.push("  secrets the deployment supplies");
    for (const s of app.secrets ?? []) {
      const notes = [
        s.optional === true ? "optional" : null,
        s.generate !== undefined ? `generated, ${s.generate.bytes} bytes` : null,
        s.one_of !== undefined ? `or one of ${s.one_of.join(", ")}` : null,
      ].filter((n): n is string => n !== null);
      lines.push(`    ${s.name.padEnd(16)}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`);
    }
  }

  if ((app.migrations ?? []).length > 0) {
    lines.push("");
    for (const m of app.migrations ?? []) {
      lines.push(`  migrations     ${m.directory}, applied to ${m.binding}`);
    }
  }
  if ((app.bootstrap ?? []).length > 0) {
    lines.push("");
    lines.push("  bootstrap the deployment runs, in order");
    for (const step of app.bootstrap ?? []) {
      // The kind is spelled out rather than implied, because one of them means
      // the deployer executes a program out of this artifact and a reader should
      // see that without opening the document.
      const what =
        step.run !== undefined
          ? `runs ${step.run} on the deploying machine`
          : `POST ${step.endpoint} on ${step.worker}`;
      const needs = [
        (step.env ?? []).length > 0 ? `env ${(step.env ?? []).join(", ")}` : null,
        (step.secrets ?? []).length > 0 ? `secrets ${(step.secrets ?? []).join(", ")}` : null,
      ].filter((n): n is string => n !== null);
      lines.push(`    ${step.name.padEnd(16)} ${(step.phase ?? "post").padEnd(5)} ${what}`);
      if (needs.length > 0) lines.push(`                     ${needs.join("; ")}`);
    }
  }

  return `${lines.join("\n")}\n`;
};
