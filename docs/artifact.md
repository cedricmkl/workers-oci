# The artifact format

A worker-app artifact is an OCI image manifest. Any registry that stores
container images stores one, and any tool that speaks the OCI distribution spec
can copy, mirror, sign or scan it.

## Layout

```
manifest
  mediaType     application/vnd.oci.image.manifest.v1+json
  artifactType  application/vnd.worker-app.v1+json
  config        application/vnd.worker-app.config.v1+json      the config document
  layers[0]     application/vnd.worker-app.content.v1.tar+gzip  the files
  annotations   org.opencontainers.image.*
```

`artifactType` is the field registries filter on. Registries that predate it read
the type from the config descriptor's `mediaType`, which carries the same value.
Helm charts use the same arrangement, which is why a chart stays browsable in
registries that know nothing about Helm.

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
    { "binding": "EVENTS", "kind": "queue", "dead_letter": true }
  ],
  "vars": [{ "name": "PUBLIC_URL" }],
  "secrets": [
    { "name": "API_KEY" },
    { "name": "COOKIE_SECRET", "generate": { "bytes": 32 } }
  ],
  "workers": [
    { "name": "example", "main": "dist/index.js", "consumes": ["EVENTS"] }
  ],
  "migrations": { "binding": "DB", "directory": "migrations" }
}
```

It covers what the build is and what it needs: a compatibility date, the scripts
and their entry modules, and the bindings, variables and secrets the code reads.
Bindings appear by name and kind. The concrete database, bucket or hostname
behind them comes from the deployment, so the same artifact runs in staging and
in production.

### Versions

`schema_version` versions this document format. The application's version is the
OCI tag, mirrored into `org.opencontainers.image.version`.

Helm puts the chart version inside `Chart.yaml` as well as in the tag, and the
two can disagree. Docker keeps it in the tag alone. worker-app follows Docker.

## The content layer

One gzipped tar with everything the artifact ships:

```
dist/         bundled JavaScript, ready to upload
migrations/   forward-only SQL, when the app has a database
public/       static files, when the app serves any
```

Paths in the config document are relative to this root: `main` is
`dist/index.js`, an assets `directory` is `public`.

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

`created` holds the commit timestamp. Two builds of one commit then produce the
same digest, which is what makes pinning a digest useful. A wall-clock value
would give every rebuild a new digest.

## Reproducibility

`workers-oci build` produces byte-identical output from an identical input tree.
Everything a tar and a gzip stream would otherwise pick up from the machine is
fixed:

- entries sorted by path
- `mtime` set to the commit timestamp
- uid, gid, uname and gname zeroed
- mode normalised to 0644, or 0755 where the source is executable
- gzip written without the optional filename and timestamp header fields

Verify with `workers-oci build --print-digest` on two checkouts of one commit.

## Pulling

```
workers-oci pull ghcr.io/example/app:v1.2.3@sha256:... --into .artifact/v1.2.3
```

A digest in the reference is optional and checked when present. It follows the
tag, in the combined form the OCI reference grammar allows, so one string carries
both the version a human reads and the identity a machine verifies.

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
declares a DO namespace; the versions API answers `403 code 100123`
([cloudflare/terraform-provider-cloudflare#6852](https://github.com/cloudflare/terraform-provider-cloudflare/issues/6852)).
`workers-oci build` rejects an artifact that declares one.

**Containers and Workflow bindings.** Same API path, and neither has a settled
shape in the provider.

**Service and dispatch bindings.** These join two applications. A worker-app
describes one, so a deployment adds them alongside the module.
