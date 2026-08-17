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

export const build = (options: BuildOptions): BuildResult => {
  const configPath = resolve(options.config);
  const root = resolve(options.root ?? dirname(configPath));

  const app = validate(JSON.parse(readFileSync(configPath, "utf8")));

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

  const seen = new Map<string, Entry>();
  for (const target of targets) {
    for (const entry of collect(root, target)) seen.set(entry.path, entry);
  }
  const entries = [...seen.values()];

  for (const w of app.workers) {
    if (!seen.has(w.main)) throw new Error(`worker ${w.name} names ${w.main} as its entry module, which is not in the artifact`);
  }

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

  const configBlob = new TextEncoder().encode(`${JSON.stringify(app, null, 2)}\n`);
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
    app,
    files: entries.map((e) => e.path).sort(),
  };
};
