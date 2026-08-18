# The artifact format

A worker-app artifact is an OCI image manifest. Any registry that stores
container images stores one, and any tool that speaks the OCI distribution spec
can copy, mirror, sign or scan it.

## Layout

```
manifest
  mediaType     application/vnd.oci.image.manifest.v1+json
  artifactType  application/vnd.worker-app.v1+json
  config        application/vnd.worker-app.config.v1+json   the config document
  layers[0]     application/vnd.worker-app.content.v1.tar    the files
  annotations   org.opencontainers.image.*
```

`artifactType` is the field registries filter on. Registries that predate it read
the config descriptor's `mediaType` instead, which is a different string,
`application/vnd.worker-app.config.v1+json`, and identifies a worker-app just as
well. Helm charts use the same arrangement.

## The config document

The config blob describes the build. It is JSON, validated against
[`schema/worker-app.v1.json`](../schema/worker-app.v1.json), and small enough
that `workers-oci inspect` prints it in full.

```json
{
  "schema_version": 1,
  "name": "example",
  "runtime": { "compatibility_date": "2026-07-14" },
  "resources": [
    { "binding": "DB", "kind": "d1" },
    { "binding": "EVENTS", "kind": "queue" }
  ],
  "vars": [{ "name": "PUBLIC_URL" }],
  "secrets": [
    { "name": "API_KEY" },
    { "name": "COOKIE_SECRET", "generate": { "bytes": 32 } }
  ],
  "workers": [
    {
      "name": "example",
      "main": "dist/index.js",
      "consumes": [{ "binding": "EVENTS", "dead_letter": true }]
    }
  ],
  "migrations": [{ "binding": "DB", "directory": "migrations" }]
}
```

It covers what the build is and what it needs: a compatibility date, the scripts
and their entry modules, and the bindings, variables and secrets the code reads.
Bindings appear by name and kind. The concrete database, bucket or hostname
behind them comes from the deployment, so the same artifact runs in staging and
in production.

The top-level keys are `schema_version`, `name`, `description`, `features`,
`runtime`, `resources`, `vars`, `secrets`, `workers`, `migrations` and
`bootstrap`. `features` names extensions this artifact relies on, so a deployer
that does not recognise one refuses rather than deploying a partial
configuration. The CLI and the Terraform modules in this repository do not read
it yet. Field-by-field rules are in [building.md](building.md).

`migrations` is a list, one entry per database, so an artifact carrying a schema
for two D1 bindings can name both. `dead_letter` sits on `workers[].consumes[]`
rather than on the queue, because two scripts reading one queue can send their
failures to different places.

### Versions

`schema_version` versions this document format. The application's version is the
OCI tag, mirrored into `org.opencontainers.image.version`. Keeping it in the tag
alone leaves nowhere for a second copy to disagree with it.

The layer carries `org.opencontainers.image.title`, so `oras pull` writes it to
disk as `content.tar`. A descriptor without one is skipped silently, which would
leave the artifact readable by this tool and by nothing else.

The config descriptor deliberately carries none. Amazon ECR refuses a whole
manifest whose config descriptor has annotations, with `405 UNSUPPORTED: Invalid
parameter at 'ImageManifest' ... Invalid JSON syntax`, and oras does not put them
there either. The config has its own command:

```
oras pull ghcr.io/example/app:v1.2.3                 # content.tar
oras manifest fetch-config ghcr.io/example/app:v1.2.3 # the document
```

## The content layer

One uncompressed tar with everything the artifact ships:

```
dist/         bundled JavaScript, ready to upload
migrations/   forward-only SQL, when the app has a database
public/       static files, when the app serves any
```

Paths in the config document are relative to this root: `main` is
`dist/index.js`, an assets `directory` is `public`.

The layer is uncompressed on purpose. zlib, zlib-ng and libdeflate produce
different streams at the same level, and zlib's own output has changed between
versions, so the digest of a compressed layer would depend on which deflate
implementation built it. Registries compress in transport, and a Worker bundle is
a few megabytes.

It is one layer rather than several. A bundler rewrites its whole output on every
build, so layer reuse between versions would be near zero and splitting would add
descriptors for nothing.

## Annotations

```
org.opencontainers.image.title         the app name
org.opencontainers.image.version       the tag, leading v removed
org.opencontainers.image.revision      the git commit
org.opencontainers.image.source        the repository URL
org.opencontainers.image.created       the commit timestamp
org.opencontainers.image.description   one line
```

`created` holds the commit timestamp, so two builds of one commit produce one
digest. A wall-clock value gives every rebuild a new one.

## Reproducibility

`workers-oci build` produces byte-identical output from an identical input tree.
The tar comes from this project rather than from the system `tar`, so nothing
about the machine reaches the digest:

- ustar format, regular files only. Directory, symlink, hardlink and device
  entries are never written.
- entries sorted by the bytes of their path, ahead of any locale-aware collation
- `mtime` the same `created` timestamp on every entry
- uid, gid, uname and gname zeroed
- mode a constant 0644. The executable bit is dropped rather than read off the
  filesystem, where it survives neither a zip download nor a Windows checkout nor
  a clone with `core.fileMode=false`.
- a path too long for a ustar header is rejected rather than promoted to a PAX or
  GNU extension, which would change the header format for one deep file

The timestamp comes from `--created`, then `SOURCE_DATE_EPOCH`, then the commit,
then the Unix epoch.

Verify with `workers-oci build --print-digest` on two checkouts of one commit.

## Pulling

```
workers-oci pull ghcr.io/example/app:v1.2.3@sha256:... --into .artifact/v1.2.3
```

A digest in the reference is optional and checked when present. It follows the
tag, in the combined form the OCI reference grammar allows, so one string carries
both the version a human reads and the identity a machine verifies. The manifest
is fetched by tag and then compared, so a tag that moved is reported rather than
quietly resolved to the pinned digest.

Unpacking writes:

```
.artifact/v1.2.3/
  worker-app.json     the config document, verbatim
  dist/ migrations/ public/
```

Terraform reads `worker-app.json` during `plan`, so the pull runs before the
plan. The bundle has to be on disk anyway, since the provider uploads worker
modules from a path.

## Limits

**Durable Objects.** The Cloudflare provider cannot create a worker version that
declares a DO namespace, and the versions API answers `403 code 100123`
([cloudflare/terraform-provider-cloudflare#6852](https://github.com/cloudflare/terraform-provider-cloudflare/issues/6852)).
`workers-oci build` rejects a config document that declares a `durable_object`
kind or carries a `class_name` key, and `terraform/deploy` refuses the same
document at plan time.

**Containers and Workflow bindings.** Same API path, and neither has a settled
shape in the provider.

**Service and dispatch bindings.** These join two applications. A worker-app
describes one, so a deployment passes them through `terraform/deploy`'s
`extra_bindings`, keyed by worker name.
