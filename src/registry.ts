import { createHash } from "node:crypto";
import { credentialFor, type CredentialSource } from "./auth.js";
import { schemeFor, type Reference } from "./reference.js";
import { INDEX_TYPE, MANIFEST_TYPE, type Descriptor, type Manifest } from "./types.js";

export const digestOf = (data: Uint8Array): string =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

export const descriptorFor = (mediaType: string, data: Uint8Array): Descriptor => ({
  mediaType,
  digest: digestOf(data),
  size: data.length,
});

/**
 * An OCI distribution client, over fetch alone.
 *
 * Enough of the spec to push and pull a single-manifest artifact: the token
 * challenge, monolithic and chunked-free blob upload, and manifest put and get.
 * Everything a registry needs beyond that is something this project has no
 * reason to do.
 */
export class Registry {
  readonly #base: string;
  readonly #registry: string;
  readonly #explicit: CredentialSource | undefined;
  #token: string | null = null;
  #basic: string | null = null;

  constructor(registry: string, credential?: CredentialSource) {
    this.#registry = registry;
    this.#base = `${schemeFor(registry)}://${registry}`;
    this.#explicit = credential;
  }

  /**
   * A request, retried once after answering an auth challenge.
   *
   * Registries hand out a token per scope, so the challenge can arrive on any
   * request rather than only on the first, and caching one token for the session
   * is enough for a push that touches one repository.
   */
  async #fetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#token !== null) headers.set("authorization", `Bearer ${this.#token}`);
    else if (this.#basic !== null) headers.set("authorization", `Basic ${this.#basic}`);
    headers.set("user-agent", "workers-oci");

    const url = path.startsWith("http") ? path : `${this.#base}${path}`;
    const response = await fetch(url, { ...init, headers, redirect: "follow" });

    if (response.status === 401 && retry) {
      const challenge = response.headers.get("www-authenticate");
      if (challenge !== null && (await this.#authenticate(challenge))) {
        return this.#fetch(path, init, false);
      }
    }
    return response;
  }

  async #authenticate(challenge: string): Promise<boolean> {
    const credential = credentialFor(this.#registry, this.#explicit);

    if (/^basic/i.test(challenge)) {
      if (credential === null) return false;
      this.#basic = Buffer.from(`${credential.username}:${credential.password}`).toString("base64");
      return true;
    }
    if (!/^bearer/i.test(challenge)) return false;

    const params = new Map<string, string>();
    for (const [, key, value] of challenge.matchAll(/(\w+)="([^"]*)"/g)) {
      if (key !== undefined && value !== undefined) params.set(key, value);
    }
    const realm = params.get("realm");
    if (realm === undefined) return false;

    const url = new URL(realm);
    for (const key of ["service", "scope"]) {
      const value = params.get(key);
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers = new Headers({ "user-agent": "workers-oci" });
    if (credential !== null) {
      const basic = Buffer.from(`${credential.username}:${credential.password}`).toString("base64");
      headers.set("authorization", `Basic ${basic}`);
    }

    // An anonymous pull from a public repository still goes through the token
    // endpoint, so a missing credential is not a failure here.
    const response = await fetch(url, { headers });
    if (!response.ok) return false;

    const body = (await response.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    if (token === undefined) return false;

    this.#token = token;
    return true;
  }

  async #fail(response: Response, what: string): Promise<never> {
    const body = await response.text().catch(() => "");
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as { errors?: { code?: string; message?: string }[] };
      if (parsed.errors !== undefined) {
        detail = parsed.errors.map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ");
      }
    } catch {
      // Not every registry answers with the spec's error document.
    }
    throw new Error(`${what} failed: ${response.status} ${response.statusText}${detail ? ` (${detail})` : ""}`);
  }

  // ── Blobs ─────────────────────────────────────────────────────────────────

  async hasBlob(repository: string, digest: string): Promise<boolean> {
    const response = await this.#fetch(`/v2/${repository}/blobs/${digest}`, { method: "HEAD" });
    return response.ok;
  }

  async pushBlob(repository: string, data: Uint8Array, mediaType: string): Promise<Descriptor> {
    const descriptor = descriptorFor(mediaType, data);
    if (await this.hasBlob(repository, descriptor.digest)) return descriptor;

    const start = await this.#fetch(`/v2/${repository}/blobs/uploads/`, { method: "POST" });
    if (start.status !== 202) await this.#fail(start, "starting a blob upload");

    const location = start.headers.get("location");
    if (location === null) throw new Error("registry accepted an upload but sent no Location");

    // Relative on some registries, absolute on others, and either may already
    // carry query parameters that have to survive.
    const url = new URL(location, this.#base);
    url.searchParams.set("digest", descriptor.digest);

    const done = await this.#fetch(url.toString(), {
      method: "PUT",
      body: data,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(data.length),
      },
    });
    if (!done.ok) await this.#fail(done, `uploading blob ${descriptor.digest}`);

    return descriptor;
  }

  async pullBlob(repository: string, digest: string): Promise<Uint8Array> {
    const response = await this.#fetch(`/v2/${repository}/blobs/${digest}`);
    if (!response.ok) await this.#fail(response, `fetching blob ${digest}`);

    const data = new Uint8Array(await response.arrayBuffer());
    const actual = digestOf(data);
    if (actual !== digest) {
      throw new Error(`blob digest mismatch\n  asked for : ${digest}\n  received  : ${actual}`);
    }
    return data;
  }

  // ── Manifests ─────────────────────────────────────────────────────────────

  async pushManifest(repository: string, reference: string, manifest: Manifest): Promise<string> {
    const body = new TextEncoder().encode(JSON.stringify(manifest));
    const response = await this.#fetch(`/v2/${repository}/manifests/${reference}`, {
      method: "PUT",
      body,
      headers: { "content-type": manifest.mediaType },
    });
    if (!response.ok) await this.#fail(response, `pushing manifest ${reference}`);

    return response.headers.get("docker-content-digest") ?? digestOf(body);
  }

  async pullManifest(
    repository: string,
    reference: string,
  ): Promise<{ manifest: Manifest; digest: string }> {
    const response = await this.#fetch(`/v2/${repository}/manifests/${reference}`, {
      headers: { accept: [MANIFEST_TYPE, INDEX_TYPE].join(", ") },
    });
    if (!response.ok) await this.#fail(response, `fetching manifest ${reference}`);

    const raw = new Uint8Array(await response.arrayBuffer());
    const digest = digestOf(raw);

    if (reference.startsWith("sha256:") && digest !== reference) {
      throw new Error(`manifest digest mismatch\n  asked for : ${reference}\n  received  : ${digest}`);
    }

    // Parsed loosely first: what came back is whatever the registry holds, and
    // an index has to be recognised before it is treated as a manifest.
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as {
      mediaType?: string;
      manifests?: unknown[];
    };
    if (parsed.mediaType === INDEX_TYPE || Array.isArray(parsed.manifests)) {
      throw new Error(
        `${repository}:${reference} is an index, not a worker-app manifest. A worker-app is one artifact with no platform variants.`,
      );
    }

    return { manifest: parsed as unknown as Manifest, digest };
  }
}

export const registryFor = (ref: Reference, credential?: CredentialSource): Registry =>
  new Registry(ref.registry, credential);
