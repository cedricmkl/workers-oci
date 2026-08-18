import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { validate } from "./config.js";
import { parseReference, formatReference } from "./reference.js";
import { Registry, digestOf } from "./registry.js";
import { untar } from "./tar.js";
import type { CredentialSource } from "./auth.js";
import { CONFIG_TYPE, LAYER_TYPE, type Manifest, type WorkerApp } from "./types.js";

export type PushOptions = {
  /** Directory `build` wrote. */
  readonly dir: string;
  readonly reference: string;
  readonly credential?: CredentialSource;
  /** Extra tags for the same manifest. */
  readonly also?: readonly string[];
};

export const push = async (options: PushOptions): Promise<{ digest: string; reference: string }> => {
  const dir = resolve(options.dir);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const config = new Uint8Array(readFileSync(join(dir, "config.json")));
  const layer = new Uint8Array(readFileSync(join(dir, "content.tar")));

  // The manifest on disk was written by `build` and could have been edited since.
  // A descriptor that disagrees with the blob beside it produces an artifact no
  // registry will serve, so it is caught here instead.
  if (digestOf(config) !== manifest.config.digest) {
    throw new Error("config.json does not match the digest in manifest.json. Run build again.");
  }
  const layerDescriptor = manifest.layers[0];
  if (layerDescriptor === undefined || digestOf(layer) !== layerDescriptor.digest) {
    throw new Error("content.tar does not match the digest in manifest.json. Run build again.");
  }

  const ref = parseReference(options.reference);
  const registry = new Registry(ref.registry, options.credential);

  // Blobs before the manifest: a registry rejects a manifest whose descriptors
  // it cannot resolve.
  await registry.pushBlob(ref.repository, config, CONFIG_TYPE);
  await registry.pushBlob(ref.repository, layer, LAYER_TYPE);

  const primary = ref.tag ?? ref.digest;
  if (primary === undefined) throw new Error("nothing to push to: the reference has neither a tag nor a digest");

  const digest = await registry.pushManifest(ref.repository, primary, manifest);

  for (const tag of options.also ?? []) {
    // Checked like the primary tag rather than trusted. An extra tag goes
    // straight into a URL path segment, and `parseReference` never sees it.
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error(`not a tag: ${tag}`);
    await registry.pushManifest(ref.repository, tag, manifest);
  }

  return {
    digest,
    reference: formatReference({ ...ref, digest }),
  };
};

export type PullOptions = {
  readonly reference: string;
  readonly into: string;
  readonly credential?: CredentialSource;
};

export type PullResult = {
  readonly app: WorkerApp;
  readonly digest: string;
  readonly reference: string;
  readonly files: readonly string[];
};

/**
 * Fetch an artifact and unpack it.
 *
 * Writes worker-app.json beside the files it refers to, which is what Terraform
 * reads during a plan.
 */
export const pull = async (options: PullOptions): Promise<PullResult> => {
  const ref = parseReference(options.reference);
  const registry = new Registry(ref.registry, options.credential);

  // A reference carrying both is fetched BY TAG and then checked, so a moved tag
  // is reported as a mismatch rather than quietly resolving to the pinned digest
  // and hiding that the tag moved.
  const { manifest, digest } = await registry.pullManifest(ref.repository, ref.tag ?? ref.digest ?? "latest");

  if (ref.digest !== undefined && ref.digest !== digest) {
    throw new Error(
      `digest mismatch for ${ref.registry}/${ref.repository}:${ref.tag ?? ""}\n` +
        `  pinned   : ${ref.digest}\n` +
        `  registry : ${digest}\n` +
        "A moved tag is the usual cause.",
    );
  }

  if (manifest.artifactType !== undefined && manifest.artifactType !== "application/vnd.worker-app.v1+json") {
    throw new Error(`not a worker-app: artifactType is ${manifest.artifactType}`);
  }
  if (manifest.config.mediaType !== CONFIG_TYPE) {
    throw new Error(`not a worker-app: the config blob is ${manifest.config.mediaType}`);
  }

  const configBlob = await registry.pullBlob(ref.repository, manifest.config.digest);
  const app = validate(JSON.parse(new TextDecoder().decode(configBlob)));

  const into = resolve(options.into);
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, "worker-app.json"), configBlob);

  const files: string[] = [];
  for (const descriptor of manifest.layers) {
    if (descriptor.mediaType !== LAYER_TYPE) continue;
    const blob = await registry.pullBlob(ref.repository, descriptor.digest);

    for (const entry of untar(blob)) {
      // Refused at build time too, and checked again because this artifact may
      // have been produced by something else.
      if (entry.path.startsWith("/") || entry.path.split("/").includes("..")) {
        throw new Error(`artifact contains a path that escapes the output directory: ${entry.path}`);
      }
      const target = join(into, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entry.data, { mode: 0o644 });
      files.push(entry.path);
    }
  }

  return { app, digest, reference: formatReference({ ...ref, digest }), files: files.sort() };
};
