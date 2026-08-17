# Puts an unpacked worker-app artifact live: one worker, version and deployment
# per script, plus the triggers and routes around them.
#
# Takes bindings as resolved objects. Where the databases and buckets behind them
# came from is the caller's business.

terraform {
  required_version = ">= 1.6.0"
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
  artifact = coalesce(var.artifact, jsondecode(file("${var.artifact_dir}/worker-app.json")))

  app     = coalesce(var.name, local.artifact.name)
  workers = local.artifact.workers
  names   = [for w in local.workers : w.name]

  script = {
    for w in local.workers : w.name =>
    length(local.workers) > 1 ? "${local.app}-${w.name}" : local.app
  }

  declared  = { for r in try(local.artifact.resources, []) : r.binding => r }
  vars_decl = { for v in try(local.artifact.vars, []) : v.name => v }
  sec_decl  = { for s in try(local.artifact.secrets, []) : s.name => s }

  assets = one([for k, r in local.declared : merge(r, { binding = k }) if r.kind == "assets"])

  # Which bindings each script gets. A worker listing none takes everything the
  # artifact declares, which is the common case.
  uses = {
    for w in local.workers : w.name => [
      for k in try(w.bindings, keys(local.declared)) : k
      if contains(keys(local.declared), k)
    ]
  }

  # ── Generated secrets ──────────────────────────────────────────────────────

  # The NAMES of the supplied secrets, unmarked. `var.secrets` is sensitive, and
  # anything derived from it inherits the mark, which would make this unusable as
  # a `for_each` key and would blank out the error messages in validate.tf. Names
  # are already in the artifact and in every plan, so unmarking them reveals
  # nothing; the values keep their mark.
  supplied = try(nonsensitive(keys(var.secrets)), keys(var.secrets))

  generated = var.generate_secrets ? {
    for k, s in local.sec_decl : k => s
    if try(s.generate, null) != null
    && !contains(local.supplied, k)
    && !contains(keys(var.secrets_store), k)
  } : {}

  generated_value = {
    for k, s in local.generated : k => (
      try(s.generate.encoding, "base64") == "hex"
      ? substr(sha512(random_password.generated[k].result), 0, s.generate.bytes * 2)
      : try(s.generate.encoding, "base64") == "base64url"
      ? replace(replace(replace(base64encode(random_password.generated[k].result), "+", "-"), "/", "_"), "=", "")
      : base64encode(random_password.generated[k].result)
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

  binding_map = {
    for w in local.workers : w.name => merge(
      { for k, v in local.vars_effective : k => { type = "plain_text", name = k, text = v } },
      { for k, v in var.secrets : k => { type = "secret_text", name = k, text = v } },
      { for k, v in local.generated_value : k => { type = "secret_text", name = k, text = v } },
      { for k, s in var.secrets_store : k => {
        type        = "secrets_store_secret"
        name        = k
        store_id    = s.store_id
        secret_name = coalesce(try(s.secret_name, null), k)
      } },

      { for k in local.uses[w.name] : k => var.bindings[k]
      if contains(keys(var.bindings), k) },

      local.assets != null && contains(local.uses[w.name], try(local.assets.binding, ""))
      ? { (local.assets.binding) = { type = "assets", name = local.assets.binding } } : {},
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
  }
}

resource "random_password" "generated" {
  for_each = local.generated

  length  = each.value.generate.bytes
  special = false
}

# ── Workers ──────────────────────────────────────────────────────────────────

resource "cloudflare_worker" "this" {
  for_each = local.script

  account_id = var.account_id
  name       = each.value
}

resource "cloudflare_worker_version" "this" {
  for_each = { for w in local.workers : w.name => w }

  account_id = var.account_id
  worker_id  = cloudflare_worker.this[each.key].id

  compatibility_date  = local.artifact.runtime.compatibility_date
  compatibility_flags = try(local.artifact.runtime.compatibility_flags, [])

  main_module = basename(each.value.main)

  modules = [
    for m in concat([{ path = each.value.main }], try(each.value.modules, [])) : {
      name         = basename(m.path)
      content_type = try(m.content_type, local.content_type[regex("[^.]*$", m.path)], "application/octet-stream")
      content_file = "${var.artifact_dir}/${m.path}"
    }
  ]

  bindings = local.bindings[each.key]

  # An attribute, not a block: the provider takes one object and runs the asset
  # upload session itself.
  assets = local.assets != null && contains(local.uses[each.key], try(local.assets.binding, "")) ? {
    directory = "${var.artifact_dir}/${local.assets.directory}"
    config = {
      not_found_handling = try(local.assets.not_found_handling, null)
      run_worker_first   = try(local.assets.run_worker_first, null)
    }
  } : null

  limits = try(var.limits[each.key], null)
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
}

# ── Triggers ─────────────────────────────────────────────────────────────────

resource "cloudflare_workers_cron_trigger" "this" {
  for_each = { for w in local.workers : w.name => w if length(try(w.crons, [])) > 0 }

  account_id  = var.account_id
  script_name = cloudflare_worker.this[each.key].name
  schedules   = [for c in each.value.crons : { cron = c }]

  depends_on = [cloudflare_workers_deployment.this]
}

locals {
  consumers = merge([
    for w in local.workers : {
      for b in try(w.consumes, []) : "${w.name}/${b}" => { worker = w.name, binding = b }
      if contains(keys(var.queue_ids), b)
    }
  ]...)
}

resource "cloudflare_queue_consumer" "this" {
  for_each = local.consumers

  account_id = var.account_id
  queue_id   = var.queue_ids[each.value.binding]
  type       = "worker"

  script_name       = cloudflare_worker.this[each.value.worker].name
  dead_letter_queue = try(var.dead_letter_queues[each.value.binding], null)
  settings          = try(var.consumer_settings[each.value.binding], null)

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
  zone_id    = var.zone_id
  hostname   = each.value.hostname
  service    = cloudflare_worker.this[each.value.worker].name

  depends_on = [cloudflare_workers_deployment.this]
}

resource "cloudflare_workers_route" "this" {
  for_each = local.route_set

  zone_id = var.zone_id
  pattern = each.value.pattern
  script  = cloudflare_worker.this[each.value.worker].name

  depends_on = [cloudflare_workers_deployment.this]
}

resource "cloudflare_workers_script_subdomain" "this" {
  for_each = var.workers_dev ? local.script : {}

  account_id  = var.account_id
  script_name = each.value
  enabled     = true

  depends_on = [cloudflare_workers_deployment.this]
}
