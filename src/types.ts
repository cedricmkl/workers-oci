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
  readonly migrations?: { readonly binding: string; readonly directory: string };
  readonly bootstrap?: Bootstrap;
};

export type Runtime = {
  readonly compatibility_date: string;
  readonly compatibility_flags?: readonly string[];
};

export type ResourceKind = "d1" | "kv" | "r2" | "queue" | "assets";

export type Resource = {
  readonly binding: string;
  readonly kind: ResourceKind;
  readonly optional?: boolean;
  readonly rebuildable?: boolean;
  /** queue */
  readonly dead_letter?: boolean;
  /** assets */
  readonly directory?: string;
  readonly not_found_handling?: "none" | "404-page" | "single-page-application";
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
  readonly consumes?: readonly string[];
  readonly crons?: readonly string[];
  readonly routable?: boolean;
};

export type Bootstrap = {
  readonly worker: string;
  readonly endpoint: string;
  readonly env?: readonly string[];
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
