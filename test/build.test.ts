/**
 * Module discovery, which is the half of a build the config document cannot state.
 *
 * A bundler names its own output: give esbuild one entry and it writes
 * `chunk-QW7T4A3B.js` beside it under a name that moves whenever the input does.
 * The tar has always shipped the whole directory for that reason; what was
 * missing was telling the deployment which of those files to upload as modules.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../src/build.js";

/** A tree on disk, written from a path to contents map. */
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "worker-app-"));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
};

const document = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  name: "example",
  runtime: { compatibility_date: "2026-07-14" },
  workers: [{ name: "example", main: "dist/index.js" }],
  ...over,
});

const built = (root: string) =>
  build({
    config: join(root, "worker-app.json"),
    out: join(root, ".out"),
    created: "2026-07-14T00:00:00Z",
  });

const modulesOf = (root: string, name = "example"): string[] => {
  const worker = built(root).app.workers.find((w) => w.name === name);
  return (worker?.modules ?? []).map((m) => m.path);
};

describe("module discovery", () => {
  test("picks up a chunk emitted beside the entry", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "import './chunk-QW7T4A3B.js'",
      "dist/chunk-QW7T4A3B.js": "export const x = 1",
    });
    expect(modulesOf(root)).toEqual(["dist/chunk-QW7T4A3B.js"]);
  });

  test("says nothing when there is nothing to say", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "export default {}",
    });
    // Absent, not empty: a document that declared none and has no chunks
    // serialises exactly as it was written.
    expect(built(root).app.workers[0]).not.toHaveProperty("modules");
  });

  test("leaves a source map alone", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "export default {}",
      "dist/index.js.map": "{}",
    });
    // The allowlist is why: the runtime has no module type for `.map`, and
    // uploading it as an octet stream costs script size for a file nothing
    // imports.
    expect(modulesOf(root)).toEqual([]);
  });

  test("keeps a declared module and its content type", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(
        document({
          workers: [
            {
              name: "example",
              main: "dist/index.js",
              modules: [{ path: "dist/model.bin", content_type: "application/octet-stream" }],
            },
          ],
        }),
      ),
      "dist/index.js": "export default {}",
      "dist/model.bin": " ",
      "dist/chunk-A.js": "export const x = 1",
    });
    expect(built(root).app.workers[0]?.modules).toEqual([
      { path: "dist/model.bin", content_type: "application/octet-stream" },
      { path: "dist/chunk-A.js" },
    ]);
  });

  test("does not make one worker a module of the other", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(
        document({
          workers: [
            { name: "api", main: "dist/api.js" },
            { name: "consumer", main: "dist/consumer.js" },
          ],
        }),
      ),
      "dist/api.js": "export default {}",
      "dist/consumer.js": "export default {}",
      "dist/chunk-shared.js": "export const x = 1",
    });
    // Two workers built into one directory SHARE their chunks, and they should.
    // Neither is a module of the other.
    expect(modulesOf(root, "api")).toEqual(["dist/chunk-shared.js"]);
    expect(modulesOf(root, "consumer")).toEqual(["dist/chunk-shared.js"]);
  });

  test("an entry at the layer root does not sweep the assets and migrations in", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(
        document({
          workers: [{ name: "example", main: "index.js" }],
          resources: [
            { binding: "ASSETS", kind: "assets", directory: "public" },
            { binding: "DB", kind: "d1" },
          ],
          migrations: [{ binding: "DB", directory: "migrations" }],
        }),
      ),
      "index.js": "export default {}",
      "chunk-A.js": "export const x = 1",
      "public/app.js": "console.log(1)",
      "migrations/0001_init.json": "{}",
    });
    // `dirname("index.js")` is the layer root, so without the exclusions this
    // would upload every asset and every migration as a worker module.
    expect(modulesOf(root)).toEqual(["chunk-A.js"]);
  });

  test("is sorted, because the config blob is part of the digest", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "export default {}",
      "dist/z.js": "export const z = 1",
      "dist/a.js": "export const a = 1",
      "dist/m.wasm": " ",
    });
    expect(modulesOf(root)).toEqual(["dist/a.js", "dist/m.wasm", "dist/z.js"]);
  });
});

/**
 * `source` is a provenance annotation, annotations are part of the manifest, and
 * the manifest digest is what a deployment pins. So the way the tree was cloned
 * reached the digest: an ssh checkout and an https checkout of one commit pinned
 * two different digests for byte-identical content, and a downloaded tarball
 * with no remote at all pinned a third.
 */
describe("the remote URL is recorded one way", () => {
  const sourceOf = (remote: string): string | undefined => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "export default {}",
    });
    const result = build({
      config: join(root, "worker-app.json"),
      out: join(root, ".out"),
      created: "2026-07-14T00:00:00Z",
      source: remote,
      revision: "abc",
    });
    return result.manifest.annotations?.["org.opencontainers.image.source"];
  };

  test.each([
    ["scp-like ssh", "git@github.com:owner/repo.git"],
    ["ssh URL", "ssh://git@github.com/owner/repo.git"],
    ["https", "https://github.com/owner/repo.git"],
    ["https without the suffix", "https://github.com/owner/repo"],
  ])("%s", (_label, remote) => {
    expect(sourceOf(remote)).toBe("https://github.com/owner/repo");
  });

  test("a remote it cannot canonicalise is left alone rather than mangled", () => {
    expect(sourceOf("file:///srv/git/repo")).toBe("file:///srv/git/repo");
  });
});

/**
 * The layer ships what is NAMED, which is not the same as everything sitting
 * beside the entry module.
 */
describe("what reaches the layer", () => {
  const filesOf = (root: string): readonly string[] => built(root).files;

  test("a source map does not ship unless asked for", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "export default {}",
      "dist/index.js.map": "{}",
      "dist/README.md": "written by the bundler",
    });
    // The version uploads `main` plus `modules`, so a file that is neither was
    // paid for on every pull and used by nothing. A source map is commonly three
    // times the size of the bundle it maps.
    expect(filesOf(root)).toEqual(["dist/index.js"]);
  });

  test("--include ships one on purpose", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "export default {}",
      "dist/index.js.map": "{}",
    });
    const result = build({
      config: join(root, "worker-app.json"),
      out: join(root, ".out"),
      created: "2026-07-14T00:00:00Z",
      include: ["dist/index.js.map"],
    });
    expect(result.files).toEqual(["dist/index.js", "dist/index.js.map"]);
    // Shipped, and still not a module: nothing imports it.
    expect(result.app.workers[0]).not.toHaveProperty("modules");
  });

  test("a discovered chunk ships, because something imports it", () => {
    const root = tree({
      "worker-app.json": JSON.stringify(document()),
      "dist/index.js": "import './chunk-A.js'",
      "dist/chunk-A.js": "export const x = 1",
      "dist/index.js.map": "{}",
    });
    expect(filesOf(root)).toEqual(["dist/chunk-A.js", "dist/index.js"]);
  });
});
