# Puts an unpacked worker-app artifact live: one worker, version and deployment
# per script, plus the triggers and routes around them.
#
# Takes bindings as resolved objects. Where the databases and buckets behind them
# came from is the caller's business.

terraform {
  required_version = ">= 1.3.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.19.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}

locals {
  # `try` rather than `coalesce`, which evaluates every argument: with an
  # artifact passed in, the file need not exist at all.
  artifact = var.artifact != null ? var.artifact : jsondecode(file("${var.artifact_dir}/worker-app.json"))

  app     = coalesce(var.name, local.artifact.name)
  workers = local.artifact.workers
  names   = [for w in local.workers : w.name]

  # A worker named after the app takes the script name unchanged; every other
  # worker is suffixed. The rule reads only this worker's own name, so adding a
  # second worker to an artifact never renames the first. Making it depend on how
  # many workers there are would, and a Worker rename takes its routes, its
  # domains and its analytics with it.
  script = {
    for w in local.workers : w.name =>
    w.name == local.artifact.name ? local.app : "${local.app}-${w.name}"
  }

  declared  = { for r in try(local.artifact.resources, []) : r.binding => r }
  vars_decl = { for v in try(local.artifact.vars, []) : v.name => v }
  sec_decl  = { for s in try(local.artifact.secrets, []) : s.name => s }

  assets = one([for k, r in local.declared : merge(r, { binding = k }) if r.kind == "assets"])

  # Which bindings each script gets. A worker listing none takes everything the
  # artifact declares, which is the common case. An empty list means none.
  uses = {
    for w in local.workers : w.name => [
      for k in try(w.bindings, keys(local.declared)) : k
      if contains(keys(local.declared), k)
    ]
  }

  # `consumes` accepts a bare binding name or an object carrying the consumer's
  # own settings. Normalised here so the rest reads one shape.
  consumes = {
    for w in local.workers : w.name => [
      for c in try(w.consumes, []) : {
        binding     = try(c.binding, c)
        dead_letter = try(c.dead_letter, false)
        settings = {
          batch_size       = try(c.max_batch_size, null)
          max_wait_time_ms = try(c.max_batch_timeout, null) == null ? null : c.max_batch_timeout * 1000
          max_retries      = try(c.max_retries, null)
          max_concurrency  = try(c.max_concurrency, null)
          retry_delay      = try(c.retry_delay, null)
        }
      }
    ]
  }

  # ── Generated secrets ──────────────────────────────────────────────────────

  # The NAMES of the supplied secrets, unmarked. `var.secrets` is sensitive, and
  # anything derived from it inherits the mark, which would make this unusable as
  # a `for_each` key and would blank out the messages in validate.tf. Names are
  # already in the artifact and in every plan, so unmarking them reveals nothing;
  # the values keep their mark.
  supplied = try(nonsensitive(keys(var.secrets)), keys(var.secrets))

  generated = var.generate_secrets ? {
    for k, s in local.sec_decl : k => s
    if try(s.generate, null) != null
    && !contains(local.supplied, k)
    && !contains(keys(var.secrets_store), k)
  } : {}

  # `random_bytes` rather than `random_password`, and the difference matters.
  # random_password's `length` counts CHARACTERS from a restricted alphabet: with
  # `special = false` that is 62 symbols, so 5.95 bits each. A 16-byte secret
  # meant to carry 128 bits would have carried 95. random_bytes counts bytes and
  # exposes the encodings directly.
  generated_value = {
    for k, s in local.generated : k => (
      try(s.generate.encoding, "base64") == "hex"
      ? random_bytes.generated[k].hex
      : try(s.generate.encoding, "base64") == "base64url"
      ? replace(replace(replace(random_bytes.generated[k].base64, "+", "-"), "/", "_"), "=", "")
      : random_bytes.generated[k].base64
    )
  }

  # ── Bindings ───────────────────────────────────────────────────────────────
  #
  # Assembled as a map so a name can only appear once, then emitted sorted.
  # `bindings` on a version is a list, and an unstable order reads as a diff on a
  # plan where nothing changed.

  vars_effective = merge(
    { for k, v in local.vars_decl : k => v.default if try(v.default, null) != null },
    var.vars,
  )

  # Kinds that carry no deployment input at all, so the caller has nothing to
  # supply and this module can bind them itself.
  self_bound = {
    for k, r in local.declared : k => { type = r.kind, name = k }
    if contains(["ai", "browser", "version_metadata"], r.kind)
  }

  binding_map = {
    for w in local.workers : w.name => merge(
      {
        for k, v in local.vars_effective : k => (
          try(local.vars_decl[k].type, "string") == "json"
          ? { type = "json", name = k, json = v }
          : { type = "plain_text", name = k, text = v }
        )
      },
      { for k, v in var.secrets : k => { type = "secret_text", name = k, text = v } },
      { for k, v in local.generated_value : k => { type = "secret_text", name = k, text = v } },
      { for k, s in var.secrets_store : k => {
        type        = "secrets_store_secret"
        name        = k
        store_id    = s.store_id
        secret_name = coalesce(try(s.secret_name, null), k)
      } },

      { for k in local.uses[w.name] : k => local.self_bound[k] if contains(keys(local.self_bound), k) },

      { for k in local.uses[w.name] : k => var.bindings[k]
      if contains(keys(var.bindings), k) },

      local.assets != null && contains(local.uses[w.name], try(local.assets.binding, ""))
      ? { (local.assets.binding) = { type = "assets", name = local.assets.binding } } : {},

      { for b in try(var.extra_bindings[w.name], []) : b.name => b },
    )
  }

  bindings = {
    for w, m in local.binding_map : w => [for k in sort(keys(m)) : m[k]]
  }

  content_type = {
    js   = "application/javascript+module"
    mjs  = "application/javascript+module"
    cjs  = "application/javascript"
    wasm = "application/wasm"
    json = "application/json"
    txt  = "text/plain"
    bin  = "application/octet-stream"
  }

  # Module names are relative to the ENTRY MODULE's directory, not flattened to a
  # basename. A bundle whose entry imports `./lib/util.js` needs that specifier
  # to still resolve after upload, and two files sharing a basename in different
  # directories would otherwise collide into one name.
  modules = {
    for w in local.workers : w.name => [
      for m in concat([{ path = w.main }], try(w.modules, [])) : {
        name         = trimprefix(replace(m.path, "${dirname(w.main)}/", ""), "./")
        content_type = try(m.content_type, local.content_type[regex("[^.]*$", m.path)], "application/octet-stream")
        content_file = "${var.artifact_dir}/${m.path}"
      }
    ]
  }
}

resource "random_bytes" "generated" {
  for_each = local.generated

  length = each.value.generate.bytes
}

# ── Workers ──────────────────────────────────────────────────────────────────

resource "cloudflare_worker" "this" {
  for_each = local.script

  account_id = var.account_id
  name       = each.value

  # Every one of these is stated rather than left out. They are optional AND
  # computed, and the provider does not read "absent" as "keep what is there": an
  # omitted `observability` plans back to disabled, and an omitted `subdomain`
  # turns the workers.dev URL off. Leaving them out also meant a second resource
  # setting the subdomain fought this one on every apply.
  observability = {
    enabled            = var.observability.enabled
    head_sampling_rate = var.observability.head_sampling_rate
  }

  subdomain = {
    enabled          = var.workers_dev
    previews_enabled = var.workers_dev && var.previews_enabled
  }

  logpush        = var.logpush
  tags           = var.tags
  tail_consumers = var.tail_consumers
}

resource "cloudflare_worker_version" "this" {
  for_each = { for w in local.workers : w.name => w }

  account_id = var.account_id
  worker_id  = cloudflare_worker.this[each.key].id

  compatibility_date = local.artifact.runtime.compatibility_date

  # Omitted when the artifact declares none. Cloudflare returns the EFFECTIVE
  # flag set, which includes what the compatibility date implies, so pinning an
  # empty list here would differ from what comes back and replace the version on
  # every plan.
  compatibility_flags = length(try(local.artifact.runtime.compatibility_flags, [])) > 0 ? local.artifact.runtime.compatibility_flags : null

  main_module = local.modules[each.key][0].name
  modules     = local.modules[each.key]
  bindings    = local.bindings[each.key]

  limits = try(local.artifact.runtime.limits, null)
  placement = try(local.artifact.runtime.placement, null) == null ? null : {
    mode = local.artifact.runtime.placement.mode
  }

  # What the version list in the dashboard shows. The module knows the tag, so
  # there is no reason for every version to be anonymous.
  annotations = {
    workers_message = var.message
    workers_tag     = var.tag
  }

  # An attribute, not a block: the provider takes one object and runs the asset
  # upload session itself.
  assets = local.assets != null && contains(local.uses[each.key], try(local.assets.binding, "")) ? {
    directory = "${var.artifact_dir}/${local.assets.directory}"
    config = {
      not_found_handling = try(local.assets.not_found_handling, null)
      html_handling      = try(local.assets.html_handling, null)
      run_worker_first   = try(local.assets.run_worker_first, null)
    }
  } : null

  lifecycle {
    # Any change to modules, bindings or flags forces replacement. Without this
    # the currently serving version is DESTROYED FIRST, and the gap is real
    # downtime rather than a swap.
    create_before_destroy = true
  }
}

resource "cloudflare_workers_deployment" "this" {
  for_each = local.script

  account_id  = var.account_id
  script_name = each.value
  strategy    = "percentage"

  versions = [{
    percentage = var.rollout_percentage
    version_id = cloudflare_worker_version.this[each.key].id
  }]

  lifecycle {
    create_before_destroy = true
  }
}

# ── Triggers ─────────────────────────────────────────────────────────────────

# Created for EVERY worker, including those with no crons. The provider cannot
# destroy this resource and says so on plan: dropping the `for_each` entry would
# remove it from state while the schedule kept firing against the new code. An
# empty `schedules` list is how a cron is actually cleared.
resource "cloudflare_workers_cron_trigger" "this" {
  for_each = local.script

  account_id  = var.account_id
  script_name = cloudflare_worker.this[each.key].name
  schedules   = [for c in try(local.artifact.workers[index(local.names, each.key)].crons, []) : { cron = c }]

  depends_on = [cloudflare_workers_deployment.this]
}

locals {
  consumers = merge([
    for w in local.workers : {
      for c in local.consumes[w.name] : "${w.name}/${c.binding}" => merge(c, { worker = w.name })
      if contains(keys(var.queue_ids), c.binding)
    }
  ]...)
}

resource "cloudflare_queue_consumer" "this" {
  for_each = local.consumers

  account_id = var.account_id
  queue_id   = var.queue_ids[each.value.binding]
  type       = "worker"

  script_name       = cloudflare_worker.this[each.value.worker].name
  dead_letter_queue = each.value.dead_letter ? try(var.dead_letter_queues[each.value.binding], null) : null

  settings = merge(
    { for k, v in each.value.settings : k => v if v != null },
    try(var.consumer_settings[each.value.binding], {}),
  )

  depends_on = [cloudflare_workers_deployment.this]
}

# ── Routing ──────────────────────────────────────────────────────────────────
#
# After the deployment, because the API rejects a custom domain whose service
# does not exist yet.

locals {
  domain_set = merge([
    for worker, hosts in var.domains : {
      for h in hosts : "${worker}/${h}" => { worker = worker, hostname = h }
    }
  ]...)

  route_set = merge([
    for worker, patterns in var.routes : {
      for p in patterns : "${worker}/${p}" => { worker = worker, pattern = p }
    }
  ]...)
}

resource "cloudflare_workers_custom_domain" "this" {
  for_each = local.domain_set

  account_id = var.account_id
  # Optional and computed: the provider resolves the zone from the hostname when
  # this is null, which is what lets one deployment span two zones.
  zone_id  = var.zone_id
  hostname = each.value.hostname
  service  = cloudflare_worker.this[each.value.worker].name

  depends_on = [cloudflare_workers_deployment.this]

  lifecycle {
    # Changing a hostname is a destroy and create, and the edge certificate goes
    # with it. Ordering it this way keeps the old one answering until the new one
    # is up.
    create_before_destroy = true
  }
}

resource "cloudflare_workers_route" "this" {
  for_each = local.route_set

  zone_id = var.zone_id
  pattern = each.value.pattern
  script  = cloudflare_worker.this[each.value.worker].name

  depends_on = [cloudflare_workers_deployment.this]
}
