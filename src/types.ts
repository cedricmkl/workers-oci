/** The config document carried as an artifact's config blob. */
export type WorkerApp = {
  readonly schema_version: 1;
  readonly name: string;
  readonly description?: string;
  readonly runtime: Runtime;
  readonly resources?: readonly Resource[];
  readonly vars?: readonly VarDecl[];
  readonly secrets?: readonly SecretDecl[];
  readonly workers: readonly WorkerDecl[];
  readonly migrations?: readonly Migration[];
  readonly bootstrap?: readonly BootstrapStep[];
};

export type Runtime = {
  readonly compatibility_date: string;
  readonly compatibility_flags?: readonly string[];
  readonly cache?: RuntimeCache;
};

/**
 * The platform edge cache in front of the Worker, which is a fact about the
 * BUILD rather than about a deployment: a response is only ever cached because
 * the code asked for it, and code that never calls the Cache API is unaffected
 * by the switch being on.
 *
 * `cross_version_cache` is the dangerous half and defaults to the platform's
 * own value rather than to anything here. With it off, the worker version is
 * part of the cache key, so a deploy starts from a cold cache and can never
 * serve a response produced by earlier code. Turning it on is what makes a long
 * stale-while-revalidate window survive a deploy, and it is also what makes a
 * deploy able to serve the previous build.
 */
export type RuntimeCache = {
  readonly enabled?: boolean;
  readonly cross_version_cache?: boolean;
};

export type Migration = { readonly binding: string; readonly directory: string };

export type ResourceKind =
  | "d1"
  | "kv"
  | "r2"
  | "queue"
  | "assets"
  | "hyperdrive"
  | "vectorize"
  | "analytics_engine"
  | "ai"
  | "browser"
  | "version_metadata"
  | "images"
  | "ratelimit";

export type Resource = {
  readonly binding: string;
  readonly kind: ResourceKind;
  readonly optional?: boolean;
  readonly rebuildable?: boolean;
  /** queue. NOT `dead_letter`: that is per CONSUMER, on `workers[].consumes`. */
  readonly produces?: boolean;
  /** ratelimit */
  readonly limit?: number;
  readonly period?: number;
  /** assets */
  readonly directory?: string;
  readonly not_found_handling?: "none" | "404-page" | "single-page-application";
  readonly html_handling?: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none";
  readonly run_worker_first?: boolean | readonly string[];
};

export type VarDecl = {
  readonly name: string;
  readonly description?: string;
  readonly optional?: boolean;
  readonly default?: string;
};

export type SecretDecl = {
  readonly name: string;
  readonly description?: string;
  readonly optional?: boolean;
  readonly generate?: { readonly bytes: number; readonly encoding?: "base64" | "base64url" | "hex" };
  readonly one_of?: readonly string[];
};

export type WorkerDecl = {
  readonly name: string;
  readonly main: string;
  readonly modules?: readonly { readonly path: string; readonly content_type?: string }[];
  readonly bindings?: readonly string[];
  readonly consumes?: readonly (string | Consumer)[];
  readonly crons?: readonly string[];
  readonly routable?: boolean;
};

/**
 * A queue subscription. The bare string form is the same thing with every
 * setting left to the platform.
 *
 * `dead_letter` is per CONSUMER and not per queue, because two scripts reading
 * one queue can legitimately send their failures to different places.
 */
export type Consumer = {
  readonly binding: string;
  readonly dead_letter?: boolean;
  readonly max_batch_size?: number;
  readonly max_batch_timeout?: number;
  readonly max_retries?: number;
  readonly max_concurrency?: number;
  readonly retry_delay?: number;
};

/**
 * One piece of installation work the artifact declares.
 *
 * A DECLARATION, not a promise that anything runs it. `endpoint` asks the
 * deployment to POST to a path on one of this artifact's own workers, so the work
 * happens on Cloudflare with bindings the Worker already holds and nothing from
 * the artifact executes on the machine holding the credentials. `run` names a
 * program the artifact SHIPS, which means the deployer executing code it pulled
 * from a registry; a deployer unwilling to do that must refuse the artifact
 * rather than skip the step. It exists because seeding the database a Worker is
 * about to be deployed against has no Worker to talk to yet.
 *
 * Exactly one of the two, and every step has to be idempotent: a deployment runs
 * them on every version bump.
 */
export type BootstrapStep = {
  readonly name: string;
  readonly phase?: "pre" | "post";
  /** `endpoint` only: which of this artifact's workers serves it. */
  readonly worker?: string;
  readonly endpoint?: string;
  readonly run?: string;
  readonly env?: readonly string[];
  readonly secrets?: readonly string[];
};

// ── OCI ─────────────────────────────────────────────────────────────────────

export const ARTIFACT_TYPE = "application/vnd.worker-app.v1+json";
export const CONFIG_TYPE = "application/vnd.worker-app.config.v1+json";
export const LAYER_TYPE = "application/vnd.worker-app.content.v1.tar";
export const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
export const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";

export type Descriptor = {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly annotations?: Readonly<Record<string, string>>;
};

export type Manifest = {
  readonly schemaVersion: 2;
  readonly mediaType: typeof MANIFEST_TYPE;
  readonly artifactType: string;
  readonly config: Descriptor;
  readonly layers: readonly Descriptor[];
  readonly annotations?: Readonly<Record<string, string>>;
};
