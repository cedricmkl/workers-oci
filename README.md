# workers-oci

A format for shipping a Cloudflare Worker and the resources it binds to as an OCI
artifact, plus the tooling to build, publish and deploy one.

The unit is a **worker-app**: one or more scripts, the D1 databases, KV
namespaces, R2 buckets and queues behind them, and the variables and secrets they
read. A build turns that into a single artifact addressed by digest. Deploying it
is supplying an account, some ids and some values.

```
workers-oci build   --config worker-app.json --out .artifact
workers-oci push    .artifact ghcr.io/example/app:v1.2.3
workers-oci pull    ghcr.io/example/app:v1.2.3@sha256:... --into .artifact/v1
workers-oci inspect ghcr.io/example/app:v1.2.3
```

## Why an artifact

Building on the machine that deploys ties the two together. The bundle that
reaches Cloudflare exists only on that machine, and rolling back means rebuilding
an old commit and hoping the output matches.

An artifact splits them. CI builds once, and every environment deploys that exact
object. A rollback points at a tag that still exists.

Registries already do the surrounding work: replication, mirroring, retention,
signing, access control. A worker-app is an ordinary OCI manifest, so all of it
applies.

## The config document

Each artifact carries a JSON document describing the build: its compatibility
date, its scripts, and the bindings, variables and secrets its code reads.

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
  "secrets": [{ "name": "COOKIE_SECRET", "generate": { "bytes": 32 } }],
  "workers": [
    { "name": "example", "main": "dist/index.js", "consumes": ["EVENTS"] }
  ],
  "migrations": { "binding": "DB", "directory": "migrations" }
}
```

Bindings appear by name and kind. Which database sits behind `DB` is decided at
deploy time, so one artifact runs in staging and in production.

Full reference: [docs/artifact.md](docs/artifact.md), schema at
[schema/worker-app.v1.json](schema/worker-app.v1.json).

## The Terraform modules

Two modules, meeting at a map of binding objects. Take both, take one, or take
neither and read the config document yourself.

**`terraform/resources`** creates what the artifact declares and hands back
binding objects. Names are an argument, so whatever convention your configuration
already uses keeps working.

**`terraform/deploy`** uploads each script as a version, resolves its bindings,
points the live deployment at it, and attaches cron triggers, queue consumers,
custom domains and routes.

```hcl
module "resources" {
  source     = "github.com/cedricmkl/workers-oci//terraform/resources?ref=v0.1.0"
  account_id = var.account_id
  artifact   = local.artifact
  names      = { DB = "example-db", EVENTS = "example-events" }
}

module "deploy" {
  source       = "github.com/cedricmkl/workers-oci//terraform/deploy?ref=v0.1.0"
  account_id   = var.account_id
  artifact_dir = ".artifact/v1"

  bindings = merge(module.resources.bindings, {
    CACHE = { type = "kv_namespace", name = "CACHE", namespace_id = var.cache_id }
  })
  queue_ids = module.resources.queue_ids

  vars    = { PUBLIC_URL = "https://app.example.com" }
  secrets = { API_KEY = var.api_key }

  zone_id = var.zone_id
  domains = { example = ["app.example.com"] }
}
```

Neither module configures a provider, reads a file of its own, or assumes a
directory layout. Credentials, naming and where values come from stay with the
configuration that calls them. A worked example is in
[examples/compose](examples/compose).

During `plan`, `deploy` checks that every binding, variable and secret the
artifact declares has somewhere to come from, and fails naming the ones that do
not.

### Secrets

Three ways to satisfy one, mixable per secret:

| | value in state | notes |
|---|---|---|
| `secrets = { NAME = value }` | yes | value from a tfvars file, `TF_VAR_`, a Vault or Secrets Manager data source, `sops exec-env`, a CI store |
| `secrets_store = { NAME = { store_id, secret_name } }` | no | binding carries the reference; writing the value into the store happens elsewhere |
| `generate` in the artifact | yes | module creates one, for keys whose only property is being unguessable |

Values in the first and third reach state, because the Cloudflare API never
returns a secret and the provider keeps the value to know whether it changed.
Encrypt state, or use the second.

There is no fourth option where a secret is set out of band and left alone. A
worker version lists its bindings exhaustively, so a version created by Terraform
drops any secret it does not name. The `inherit` binding type exists for exactly
this and is unusable here: the API reports the binding resolved to `secret_text`,
which differs from the configured `inherit` on every read, and `bindings` forces
replacement on any difference. The result is a version and a deployment replaced
on every plan.

## Install

```
bun install -g @cedricmkl/workers-oci
```

The CLI speaks the OCI distribution API directly, so `oras`, `docker` and `crane`
are not needed. Credentials come from `~/.docker/config.json`, from
`WORKERS_OCI_REGISTRY_USER` and `WORKERS_OCI_REGISTRY_PASSWORD`, or from
`--username` and `--password-stdin`. Logging in with any of the usual tools is
enough.

## Scope

workers-oci covers one worker-app: the format, the tooling around it, and the
primitives to put it live. Zones, accounts, tokens, naming conventions and the
wiring between separate applications belong to whatever already manages your
account.

Durable Objects are unsupported in v1. The Cloudflare provider cannot create a
worker version that declares one, so `build` rejects an artifact that exports a
DO class. Details in [docs/artifact.md](docs/artifact.md#limits).

## License

MIT.
