variable "account_id" {
  type = string
}

variable "artifact_dir" {
  description = <<-EOT
    Directory `workers-oci pull` unpacked an artifact into.

    Read during `plan`. The provider uploads worker modules from a path, so the
    files have to be on disk in any case.
  EOT
  type        = string
}

variable "artifact" {
  description = <<-EOT
    The decoded config document. Defaults to reading worker-app.json out of
    `artifact_dir`.

    Pass it explicitly when it comes from somewhere else: a remote state output,
    a `data` source, a document assembled in the calling configuration.
  EOT
  type        = any
  default     = null
}

variable "name" {
  description = <<-EOT
    Script name.

    A worker whose own name equals the artifact's name is deployed under this
    unchanged; every other worker is deployed as `<name>-<worker name>`. The
    rule reads only that one worker's name and not how many the artifact ships,
    so adding a second worker never renames the first.

    Defaults to the artifact's name. Set it to run two installations of one
    artifact in an account.
  EOT
  type        = string
  default     = null
}

variable "bindings" {
  description = <<-EOT
    Binding object per binding name, for everything the artifact declares as a
    resource.

        bindings = {
          DB    = { type = "d1", name = "DB", id = cloudflare_d1_database.db.id }
          CACHE = { type = "kv_namespace", name = "CACHE", namespace_id = "..." }
        }

    terraform/resources produces this shape, and so does writing it by hand. The
    objects are passed to the provider unchanged, so anything the Cloudflare
    bindings API accepts works here, including kinds this project has no opinion
    about.

    Typed `any` and not `map(any)` for that last sentence to be true. `map(any)`
    unifies every value to ONE type, so a `ratelimit` binding carrying a `simple`
    object next to a `d1` binding carrying a string id was rejected outright with
    "all map elements must have the same type". A kind the artifact schema
    declares could not be deployed at all.
  EOT
  type        = any
  default     = {}
}

variable "vars" {
  description = "Plain text values, by name. The artifact declares which names it reads."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = <<-EOT
    Secret values, by name.

    Values reach state: the Cloudflare API never returns a secret, so the
    provider keeps the value to know whether it changed. `inherit_secrets` keeps
    a value out of state entirely, `secrets_store` moves it to a store, and
    encrypting state covers the case where this variable is the right one.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "secrets_store" {
  description = <<-EOT
    Secrets held in a Cloudflare Secrets Store, referenced rather than carried.

        secrets_store = {
          API_KEY = { store_id = "...", secret_name = "prod_api_key" }
        }

    The binding holds the reference alone, so no value reaches state or a plan
    file. Writing the value into the store happens elsewhere.

    `secret_name` defaults to the binding name.
  EOT
  type = map(object({
    store_id    = string
    secret_name = optional(string)
  }))
  default = {}
}

variable "inherit_secrets" {
  description = <<-EOT
    Secrets this deployment DECLARES but does not carry, by name.

    The binding says the secret exists and says nothing about its value, so a
    version can be replaced without the value being known to anything that plans
    it. Whatever set the secret keeps owning it: `wrangler secret put`, the
    dashboard, a person years ago.

    THIS IS THE ONLY PATH THAT KEEPS A VALUE OUT OF STATE AND OUT OF A SECRET
    STORE. `secrets` puts it in state, because the API never returns a secret and
    the provider has to keep it to know whether it changed. `secrets_store` keeps
    it out of state and puts it in a store, which is a second place to provision.

    It is still a declaration: the version lists which secrets exist, so one that
    nothing sets any more shows up as a version that fails rather than as a
    binding that quietly disappeared.

    Verified against a live account: a secret written by `wrangler secret put`
    survives a Terraform-created version that names it here and nothing else.

    A name in both this and `secrets` is refused, because the two disagree about
    who owns the value.
  EOT
  type        = set(string)
  default     = []
}

variable "generate_secrets" {
  description = <<-EOT
    Create values for the secrets the artifact marks `generate`, for keys whose
    only property is being unguessable and stable.

    Turn it off to supply them through `secrets` or `secrets_store` instead.
  EOT
  type        = bool
  default     = true
}

# ── Routing ──────────────────────────────────────────────────────────────────

variable "zone_id" {
  type    = string
  default = null
}

variable "domains" {
  description = "Worker name from the artifact -> custom hostnames. Requires `zone_id`."
  type        = map(list(string))
  default     = {}
}

variable "routes" {
  description = "Worker name -> route patterns, for a zone already fronted by something else."
  type        = map(list(string))
  default     = {}
}

variable "workers_dev" {
  description = "Give each worker a workers.dev subdomain."
  type        = bool
  default     = false
}

# ── Queues ───────────────────────────────────────────────────────────────────

variable "queue_ids" {
  description = <<-EOT
    Queue id per binding, needed to attach a consumer. terraform/resources
    outputs this.

    A queue binding a worker only produces to needs no entry.
  EOT
  type        = map(string)
  default     = {}
}

variable "dead_letter_queues" {
  description = "Dead letter queue name per queue binding."
  type        = map(string)
  default     = {}
}

variable "consumer_settings" {
  description = <<-EOT
    Per queue binding, passed to the consumer as given: batch_size, max_retries,
    max_wait_time_ms, retry_delay.

    `any` rather than `map(any)`, which would force every queue's entry to carry
    the same keys as every other queue's.
  EOT
  type        = any
  default     = {}
}

# ── Rollout ──────────────────────────────────────────────────────────────────

variable "rollout_percentage" {
  description = <<-EOT
    Share of traffic the new version takes. Below 100 leaves the previous version
    serving the rest, which is useful when something is watching and able to
    change it back.
  EOT
  type        = number
  default     = 100

  validation {
    condition     = var.rollout_percentage > 0 && var.rollout_percentage <= 100
    error_message = "A share of traffic between 1 and 100."
  }
}

variable "extra_bindings" {
  description = <<-EOT
    Bindings the artifact does not declare, per worker name. Service bindings,
    dispatch namespaces, anything joining this app to another.

    Separate from `bindings`, which is checked against the artifact so a typo in a
    resource name is an error rather than a silent extra binding. These are
    passed to the provider unchanged, so anything the Cloudflare bindings API
    accepts works.

    `any` for the same reason as `bindings`: `map(list(any))` made every entry in
    one worker's list unify to a single type, which rejected a service binding
    and a dispatch namespace binding in the same list.
  EOT
  type        = any
  default     = {}
}

# ── Worker settings ──────────────────────────────────────────────────────────
#
# Every one of these is set on `cloudflare_worker` unconditionally. They are
# optional AND computed, and the provider does not read "absent" as "keep what is
# there", so leaving one out turns it off on the next apply.

variable "observability" {
  description = "Workers Logs. Off by default, matching the platform."
  type = object({
    enabled            = optional(bool, false)
    head_sampling_rate = optional(number, 1)
  })
  default = {}
}

variable "previews_enabled" {
  description = "Per-version preview URLs, when `workers_dev` is on."
  type        = bool
  default     = false
}

variable "logpush" {
  type    = bool
  default = false
}

variable "tags" {
  description = "Cloudflare-side tags on each worker."
  type        = list(string)
  default     = []
}

variable "tail_consumers" {
  description = "Workers receiving this worker's trace events, as [{ name = \"...\" }]."
  type        = list(any)
  default     = []
}

# ── Version annotations ──────────────────────────────────────────────────────

variable "message" {
  description = "Shown against the version in the dashboard. A release note, or what triggered the deploy."
  type        = string
  default     = null
}

variable "tag" {
  description = <<-EOT
    Stamped on the version. Pass the artifact's OCI tag, so a version in the
    dashboard can be traced back to what produced it.
  EOT
  type        = string
  default     = null
}
