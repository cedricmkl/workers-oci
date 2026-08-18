# Deploying

Two Terraform modules, meeting at a map of binding objects. Take both, take one,
or read the config document yourself and write the resources by hand.

## Pull first

```
workers-oci pull ghcr.io/example/app:v1.2.3@sha256:... --into .artifact/v1
```

Terraform reads `worker-app.json` during `plan`, and the provider uploads worker
modules from a path, so the artifact is on disk before the plan runs. Put the
pull in whatever wraps your `plan` and `apply`.

## terraform/resources

Creates the d1, kv, r2 and queue bindings you list in `names`, and hands back
binding objects for them.

```hcl
module "resources" {
  source = "github.com/cedricmkl/workers-oci//terraform/resources?ref=v0.1.0"

  account_id = var.account_id
  artifact   = jsondecode(file(".artifact/v1/worker-app.json"))

  names = {
    DB     = "example-db"
    EVENTS = "example-events"
  }
}
```

| variable | |
|---|---|
| `account_id` | |
| `artifact` | the decoded config document |
| `names` | binding -> resource name, for the bindings this module should create |
| `d1` | per D1 binding: `read_replication`, default `disabled`, and `primary_location_hint` |
| `r2` | per R2 binding: `location`, `storage_class` and `jurisdiction`, all fixed at creation |
| `queues` | per queue binding: `message_retention_period` and `delivery_delay`, in seconds |

`names` decides what gets created. A binding the artifact declares and `names`
omits is left alone: create it elsewhere and pass it straight to `deploy`. Naming
a binding of any other kind fails the plan with `names covers bindings with no
resource to create`, since an assets binding is part of the worker version and
the remaining kinds carry no account-level resource. A name the artifact never
declared fails it as well.

For each queue it creates that a consumer marks `dead_letter`, the module also
creates `<queue name>-dlq`.

| output | |
|---|---|
| `bindings` | binding objects, ready to merge |
| `queue_ids` | queue id per binding, which `deploy` needs to attach a consumer |
| `dead_letter_queues` | dead letter queue name per binding |
| `resources` | kind, name and id per binding |

Every resource here carries `prevent_destroy`, unconditionally, and there is no
variable for it. `prevent_destroy` takes a literal only, so a variable would mean
two copies of every resource at two addresses and a flip that moves the resource
between them: switching the flag on destroys the database it claims to protect,
and switching it off afterwards is refused. To take a resource down on purpose,
remove it from `names`, run `tofu state rm` on the address, then delete it by
hand.

## terraform/deploy

Uploads each script as a version and puts it live.

```hcl
module "deploy" {
  source = "github.com/cedricmkl/workers-oci//terraform/deploy?ref=v0.1.0"

  account_id   = var.account_id
  artifact_dir = ".artifact/v1"

  bindings           = module.resources.bindings
  queue_ids          = module.resources.queue_ids
  dead_letter_queues = module.resources.dead_letter_queues

  vars    = { PUBLIC_URL = "https://app.example.com" }
  secrets = { API_KEY = var.api_key }

  zone_id = var.zone_id
  domains = { api = ["app.example.com"] }
}
```

| variable | |
|---|---|
| `account_id`, `artifact_dir` | |
| `artifact` | the decoded document; read from `artifact_dir` when omitted |
| `name` | script name, defaulting to the artifact's name |
| `bindings` | binding object per binding name |
| `extra_bindings` | worker name -> binding objects the artifact does not declare |
| `vars` | plain values by name |
| `secrets` | secret values by name, sensitive |
| `secrets_store` | Secrets Store references by name |
| `inherit_secrets` | secrets this deployment declares but does not carry: the binding names one and says nothing about its value |
| `generate_secrets` | create values for `generate` secrets, default true |
| `zone_id`, `domains`, `routes`, `workers_dev` | routing |
| `previews_enabled` | per-version preview URLs, with `workers_dev` on. Default false. |
| `queue_ids`, `dead_letter_queues`, `consumer_settings` | queues |
| `rollout_percentage` | share of traffic the new version takes, default 100 |
| `observability` | Workers Logs: `enabled` and `head_sampling_rate`. Off by default, matching the platform. |
| `logpush` | default false |
| `tags` | Cloudflare-side tags on each worker |
| `tail_consumers` | workers receiving this worker's trace events, as `[{ name = "..." }]` |
| `message` | shown against the version in the dashboard: a release note, or what triggered the deploy |
| `tag` | stamped on the version. Pass the artifact's OCI tag, so a version traces back to what produced it. |

`observability`, `workers_dev`, `previews_enabled`, `logpush`, `tags` and
`tail_consumers` are written on every apply. The provider does not read an absent
value as "keep what is there", so leaving one out turns it off.

A worker whose own name equals the artifact's `name` is deployed as `name`
unchanged. Every other worker is deployed as `<name>-<worker name>`. The rule
reads that one worker's name and nothing else, so adding a second worker to an
artifact never renames the first, and a Worker rename takes its routes, its
domains and its analytics with it.

CPU limits and placement come from the artifact, as `runtime.limits.cpu_ms` and
`runtime.placement.mode`. Both describe the code rather than the deployment.

| output | |
|---|---|
| `workers` | per worker name: the script `name`, the worker `id`, the live `version_id`, and its `hostnames` and `routes` |
| `app` | the deployment name and the worker names the artifact ships |
| `generated_secrets` | values created for the artifact's `generate` secrets, by name. Sensitive. |

### Binding objects

A binding object is passed to the provider unchanged, so anything the Cloudflare
bindings API accepts works, including kinds workers-oci has no opinion about.

```hcl
bindings = {
  DB      = { type = "d1", name = "DB", id = cloudflare_d1_database.db.id }
  CACHE   = { type = "kv_namespace", name = "CACHE", namespace_id = "..." }
  UPLOADS = { type = "r2_bucket", name = "UPLOADS", bucket_name = "example-uploads" }
  EVENTS  = { type = "queue", name = "EVENTS", queue_name = "example-events" }
}
```

`bindings` is checked against the artifact, so a typo is an error rather than a
silent extra binding. Bindings joining this app to another go in
`extra_bindings`, keyed by worker name and unchecked:

```hcl
extra_bindings = {
  api = [{ type = "service", name = "AUTH", service = "auth-worker" }]
}
```

### Checks at plan time

`deploy` refuses to plan when the artifact declares something the deployment does
not supply, and names it:

```
The artifact needs secrets with nowhere to come from: API_KEY.
Each needs an entry in `secrets`, an entry in `secrets_store`, or a `generate`
block in the artifact.
```

It also refuses:

- an artifact whose `schema_version` is not 1
- a binding or a variable the artifact declares with nowhere to come from
- a `bindings` entry the artifact never declared
- `domains` or `routes` without a `zone_id`
- routing configured for a worker the artifact does not ship
- a hostname pointed at a worker marked `routable: false`
- a worker consuming a queue with no id in `queue_ids`
- an artifact declaring Durable Objects

## Secrets

| | value in state | |
|---|---|---|
| `secrets` | yes | from a tfvars file, `TF_VAR_`, a Vault or Secrets Manager data source, `sops exec-env`, a CI store |
| `secrets_store` | no | the binding carries a reference; writing the value into the store happens elsewhere |
| `generate` in the artifact | yes | the module creates one |

```hcl
secrets_store = {
  API_KEY = { store_id = var.store_id, secret_name = "prod_api_key" }
}
```

`secret_name` defaults to the binding name. An account has one Secrets Store, so
set it when the store serves several applications.

Values under `secrets` and `generate` reach state, because the Cloudflare API
never returns a secret and the provider keeps the value to know whether it
changed. Encrypt state, or use `secrets_store`.

### Why a secret cannot be left out of Terraform

A worker version lists its bindings exhaustively. A version created by Terraform
drops any secret it does not name, silently: the secret is absent from the
new version, with nothing in the plan to say so.

The `inherit` binding type exists for this, and is unusable from Terraform. The
API reports the binding resolved to `secret_text`, which differs from the
configured `inherit` on every read, and `bindings` forces replacement on any
difference. The result is a version and a deployment replaced on every plan, with
a real traffic event each time.

## Providers

Neither module configures a provider. The `cloudflare` provider is inherited from
the calling configuration, so the API token comes from wherever that
configuration already gets it.

```hcl
provider "cloudflare" {}                        # CLOUDFLARE_API_TOKEN
provider "cloudflare" { api_token = var.token }  # or anywhere else
```

## Rollout

`rollout_percentage` below 100 leaves the previous version serving the rest,
which is useful when something is watching and able to change it back. Terraform
has nothing watching, so leave it at 100 unless a separate process owns the
decision.

## A worked example

[examples/compose](../examples/compose) composes both modules and binds one
resource the modules do not own. CI plans it with `CLOUDFLARE_API_TOKEN` set to a
dummy value, checking that every binding, variable and secret resolves.

### Three places a secret can come from, and a fourth that carries nothing

`secrets` is a value this configuration holds. It reaches state, because the
Cloudflare API never returns a secret and the provider keeps it to know whether
it changed. Encrypt state if this is the right one.

`secrets_store` is a reference to a Cloudflare Secrets Store entry. No value in
state, and a second place to provision.

The artifact's own `generate` block covers keys whose only property is being
unguessable and stable. Those are created here and are in state.

`inherit_secrets` carries nothing at all. The binding names the secret and says
it exists, and whatever set it keeps owning it: `wrangler secret put`, the
dashboard, a person years ago. It is still a declaration, so a secret nothing
sets any more surfaces as a version that fails rather than as a binding that
quietly disappeared.

```hcl
inherit_secrets = ["COOKIE_SECRET", "DASHBOARD_PRIVATE_KEY"]
```

A name in both `inherit_secrets` and one of the other two is refused at plan
time: they disagree about who owns the value.

