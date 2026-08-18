import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { validate } from "./config.js";
import { descriptorFor, digestOf } from "./registry.js";
import { tar, type Entry } from "./tar.js";
import {
  ARTIFACT_TYPE,
  CONFIG_TYPE,
  LAYER_TYPE,
  MANIFEST_TYPE,
  type Manifest,
  type WorkerApp,
  type WorkerDecl,
} from "./types.js";

export type BuildOptions = {
  /** Path to the config document. */
  readonly config: string;
  /** Where to write the artifact. */
  readonly out: string;
  /** Root the document's paths are relative to. Defaults to the config's directory. */
  readonly root?: string;
  /** Extra files or directories to ship. */
  readonly include?: readonly string[];
  readonly version?: string;
  readonly revision?: string;
  readonly source?: string;
  /** RFC 3339. Defaults to the commit timestamp. */
  readonly created?: string;
};

export type BuildResult = {
  readonly manifest: Manifest;
  readonly digest: string;
  readonly app: WorkerApp;
  readonly files: readonly string[];
};

const git = (args: readonly string[], cwd: string): string | null => {
  try {
    return execFileSync("git", args as string[], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/** A path below the root, in layer spelling, or null when it is outside. */
const relativePath = (root: string, target: string): string | null => {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`${sep}`)) return null;
  return rel.split(sep).join(posix.sep);
};

/** Every file under a path, or the path itself when it is a file. */
const collect = (root: string, target: string): Entry[] => {
  const absolute = resolve(root, target);
  const stat = statSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined) throw new Error(`the config document refers to ${target}, which does not exist`);

  const entryFor = (file: string): Entry => ({
    path: relative(root, file).split(sep).join(posix.sep),
    data: new Uint8Array(readFileSync(file)),
  });

  if (stat.isFile()) return [entryFor(absolute)];

  const out: Entry[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, item.name);
      if (item.isDirectory()) walk(child);
      else if (item.isFile()) out.push(entryFor(child));
    }
  };
  walk(absolute);
  return out;
};

/**
 * The extensions the runtime has a module type for.
 *
 * Discovery is an ALLOWLIST and not a denylist, which is what keeps a source map
 * out. A bundler writes `index.js.map` next to `index.js`, the runtime has no
 * type for it, and uploading it as `application/octet-stream` costs script size
 * for a file nothing imports.
 */
const MODULE_EXTENSIONS = new Set(["js", "mjs", "cjs", "wasm", "json", "txt", "bin"]);

/**
 * A worker's module list: what the document declares, plus the chunks a bundler
 * emitted beside the entry.
 *
 * WHY THIS IS NOT THE AUTHOR'S JOB. Code splitting names its own output. Give
 * esbuild or rollup one entry and it writes `chunk-QW7T4A3B.js` next to it, with
 * a name that changes whenever the input does, so a document listing them by
 * hand is wrong on the next build. The tar already ships the whole directory for
 * exactly this reason; without this, the deployment then uploaded the entry
 * alone and the worker failed at its first dynamic import, at runtime, in
 * production.
 *
 * WHAT IT WILL NOT PICK UP:
 *
 *   - Another worker's entry module. Two workers built into one directory share
 *     their chunks, and they should, but neither is a module of the other.
 *   - Anything under an assets directory or the migrations directory. Those are
 *     shipped for their own reasons and are files rather than modules.
 *   - Anything the document already declares, whose `content_type` is kept.
 *
 * The result is SORTED, because the config blob is part of the digest and a
 * directory read order that varies by filesystem would make the build
 * irreproducible.
 */
type Module = { readonly path: string; readonly content_type?: string };

const discover = (
  worker: WorkerDecl,
  app: WorkerApp,
  paths: readonly string[],
  never: readonly string[],
): Module[] => {
  const declared = worker.modules ?? [];
  const dir = posix.dirname(worker.main);
  // An entry at the layer root would otherwise sweep the whole artifact.
  const within = (path: string): boolean => dir === "." || path.startsWith(`${dir}/`);

  const excluded = new Set<string>([worker.main, ...declared.map((m) => m.path), ...never]);
  for (const other of app.workers) if (other.name !== worker.name) excluded.add(other.main);

  const prefixes: string[] = [];
  for (const r of app.resources ?? []) {
    if (r.kind === "assets" && r.directory !== undefined) prefixes.push(`${r.directory.replace(/\/$/, "")}/`);
  }
  if (app.migrations !== undefined) prefixes.push(`${app.migrations.directory.replace(/\/$/, "")}/`);

  const found = paths
    .filter(
      (path) =>
        within(path) &&
        !excluded.has(path) &&
        !prefixes.some((prefix) => path.startsWith(prefix)) &&
        MODULE_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1)),
    )
    .sort()
    .map((path) => ({ path }));

  return [...declared, ...found];
};

export const build = (options: BuildOptions): BuildResult => {
  const configPath = resolve(options.config);
  const root = resolve(options.root ?? dirname(configPath));

  const app = validate(JSON.parse(readFileSync(configPath, "utf8")));

  // Both matter only when a worker's entry sits at the layer root, because then
  // `dirname(main)` is the whole tree. The config document is already the config
  // BLOB, and the output directory is a previous build: a second run would
  // otherwise ship its own artifact inside the next one, and it would ship a
  // different one each time, which is the end of a reproducible digest.
  const configName = relativePath(root, configPath);
  const outName = relativePath(root, resolve(options.out));

  // ── What ships ────────────────────────────────────────────────────────────
  //
  // The whole directory holding an entry module, because a bundler splits its
  // output into chunks the document never names. Assets and migrations come from
  // the paths the document does name.

  const targets = new Set<string>();
  for (const w of app.workers) {
    targets.add(dirname(w.main));
    for (const m of w.modules ?? []) targets.add(m.path);
  }
  for (const r of app.resources ?? []) {
    if (r.kind === "assets" && r.directory !== undefined) targets.add(r.directory);
  }
  if (app.migrations !== undefined) targets.add(app.migrations.directory);
  for (const extra of options.include ?? []) targets.add(extra);

  const excludedFromLayer = (path: string): boolean =>
    path === configName || path === outName || (outName !== null && path.startsWith(`${outName}/`));

  const seen = new Map<string, Entry>();
  for (const target of targets) {
    for (const entry of collect(root, target)) if (!excludedFromLayer(entry.path)) seen.set(entry.path, entry);
  }
  const entries = [...seen.values()];

  for (const w of app.workers) {
    if (!seen.has(w.main)) throw new Error(`worker ${w.name} names ${w.main} as its entry module, which is not in the artifact`);
  }

  // `modules` is left OFF when there is nothing to say, so a document that
  // declared none and has no chunks serialises exactly as it was written.
  const workers = app.workers.map((w) => {
    const modules = discover(w, app, [...seen.keys()], configName === null ? [] : [configName]);
    return modules.length === 0 ? w : { ...w, modules };
  });

  // The document that SHIPS, which is the one a deployment reads.
  const complete: WorkerApp = { ...app, workers };

  // ── Provenance ────────────────────────────────────────────────────────────

  const revision = options.revision ?? git(["rev-parse", "HEAD"], root) ?? undefined;
  const source = options.source ?? git(["remote", "get-url", "origin"], root) ?? undefined;

  // The COMMIT timestamp, so two builds of one commit agree. A wall clock would
  // give every rebuild a different digest.
  const epoch = process.env["SOURCE_DATE_EPOCH"];
  const created =
    options.created ??
    (epoch !== undefined ? new Date(Number(epoch) * 1000).toISOString() : undefined) ??
    (revision !== undefined ? (git(["show", "-s", "--format=%cI", revision], root) ?? undefined) : undefined) ??
    "1970-01-01T00:00:00Z";

  const mtime = Math.floor(Date.parse(created) / 1000);
  if (!Number.isFinite(mtime)) throw new Error(`created is not a date: ${created}`);

  const version = options.version?.replace(/^v/, "");

  const annotations: Record<string, string> = {
    "org.opencontainers.image.title": app.name,
    "org.opencontainers.image.created": created,
    ...(app.description !== undefined ? { "org.opencontainers.image.description": app.description } : {}),
    ...(version !== undefined ? { "org.opencontainers.image.version": version } : {}),
    ...(revision !== undefined ? { "org.opencontainers.image.revision": revision } : {}),
    ...(source !== undefined ? { "org.opencontainers.image.source": source } : {}),
  };

  // ── Assemble ──────────────────────────────────────────────────────────────

  const configBlob = new TextEncoder().encode(`${JSON.stringify(complete, null, 2)}\n`);
  const layerBlob = tar(entries, mtime);

  const manifest: Manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    artifactType: ARTIFACT_TYPE,
    config: descriptorFor(CONFIG_TYPE, configBlob),
    layers: [descriptorFor(LAYER_TYPE, layerBlob)],
    annotations,
  };

  // Written as the exact bytes that get pushed, so `sha256sum manifest.json`
  // reproduces the digest a deployment pins.
  const manifestBlob = new TextEncoder().encode(JSON.stringify(manifest));

  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "config.json"), configBlob);
  writeFileSync(join(out, "content.tar"), layerBlob);
  writeFileSync(join(out, "manifest.json"), manifestBlob);

  return {
    manifest,
    digest: digestOf(manifestBlob),
    app: complete,
    files: entries.map((e) => e.path).sort(),
  };
};
