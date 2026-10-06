# Puts an unpacked worker-app artifact live: one worker, version and deployment
# per script, plus the triggers and routes around them.
#
# Takes bindings as resolved objects. Where the databases and buckets behind them
# came from is the caller's business.

terraform {
  required_version = ">= 1.3.0"
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      # 5.26.0 for `deploy` on cloudflare_worker_version, which is how a version
      # carrying a Durable Object migration goes live in the same call that
      # creates it. See the Durable Objects section below.
      version = ">= 5.26.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0"
    }
  }
}

locals {
  # `try` and NOT `? :`. A conditional has to give both branches a consistent
  # type, and it types the branch it will not take. So passing an artifact from
  # anywhere other than this exact file, which is the whole reason `artifact` is
  # a variable, failed the entire plan with "Inconsistent conditional result
  # types" over an attribute of a document nobody was going to read. A remote
  # state output, a document assembled in the calling configuration, or the same
  # artifact carrying one optional key more were all enough to trip it.
  #
  # `coalesce` with the one argument raises when it is null, which is what makes
  # `try` fall through to the file. The file is read only in that case, and a
  # malformed or missing one still raises rather than being swallowed, because
  # there is no third argument to fall through to.
  artifact = try(coalesce(var.artifact), jsondecode(file("${var.artifact_dir}/worker-app.json")))

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
    if contains(["ai", "browser", "version_metadata", "images"], r.kind)
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

      # DECLARED, NOT CARRIED. The binding names the secret and says nothing
      # about its value, so the version can be replaced by something that has
      # never seen it and whatever set it keeps owning it.
      { for k in var.inherit_secrets : k => { type = "inherit", name = k } },
      { for k, s in var.secrets_store : k => {
        type        = "secrets_store_secret"
        name        = k
        store_id    = s.store_id
        secret_name = coalesce(try(s.secret_name, null), k)
      } },

      { for k in local.uses[w.name] : k => local.self_bound[k] if contains(keys(local.self_bound), k) },

      # A Durable Object carries no deployment input either, and is bound on the
      # worker that exports the class and nowhere else.
      { for k in local.uses[w.name] : k => {
        type       = "durable_object_namespace"
        name       = k
        class_name = local.do_resources[k].class_name
      } if contains(keys(local.do_resources), k) && try(local.do_owner[k], null) == w.name },

      { for k in local.uses[w.name] : k => var.bindings[k]
      if contains(keys(var.bindings), k) },

      local.assets != null && contains(local.uses[w.name], try(local.assets.binding, ""))
      ? { (local.assets.binding) = { type = "assets", name = local.assets.binding } } : {},

      { for b in try(var.extra_bindings[w.name], []) : b.name => b },
    )
  }

  # ALWAYS PRINTED AS `(sensitive value)` IN A PLAN, and that is the provider's
  # doing rather than anything here. `cloudflare_worker_version` marks the `text`
  # attribute of a binding sensitive, and `text` is what a `plain_text` binding
  # carries, so one ordinary variable redacts the whole list. Supplying no
  # secrets does not help and neither does `nonsensitive`, because the mark is on
  # elements inside the collection.
  #
  # To read what a deployment will actually bind:
  #
  #   tofu show -json <plan> | jq '.planned_values...'
  #
  # or the `bindings` output below, which lists the names and types with no
  # values in them.
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

  # The directory each entry module sits in. `./dist/index.js` and `dist/index.js`
  # name the same directory, so the leading `./` comes off before `dirname`.
  entry_dir = { for w in local.workers : w.name => dirname(trimprefix(w.main, "./")) }

  # Module names are relative to the ENTRY MODULE's directory, not flattened to a
  # basename. A bundle whose entry imports `./lib/util.js` needs that specifier
  # to still resolve after upload, and two files sharing a basename in different
  # directories would otherwise collide into one name.
  #
  # `trimprefix` and not `replace`: `replace` swaps EVERY occurrence, so under an
  # entry at `dist/index.js` a module at `dist/x/dist/y.js` came out as `x/y.js`,
  # which is the wrong specifier AND collides with a real `dist/x/y.js`. An entry
  # at the layer root has `dirname` == "." and its siblings are already correctly
  # named, so nothing is stripped in that case.
  #
  # `_headers` and `_redirects` are the exception. Cloudflare reads them only
  # when a module is named exactly that, wherever the bundler wrote the file, so
  # they take their basename. Under an entry at `dist/slate/index.js` a rules file
  # at `dist/client/_headers` otherwise went up as `dist/client/_headers`, a plain
  # text module nothing read. The `duplicate_modules` check refuses two of either.
  asset_config_modules = ["_headers", "_redirects"]

  modules = {
    for w in local.workers : w.name => [
      for m in concat([{ path = w.main }], try(w.modules, [])) : {
        name = contains(local.asset_config_modules, basename(m.path)) ? basename(m.path) : trimprefix(
          trimprefix(m.path, "./"),
          local.entry_dir[w.name] == "." ? "" : "${local.entry_dir[w.name]}/",
        )
        content_type = try(m.content_type, local.content_type[regex("[^.]*$", m.path)], "application/octet-stream")
        content_file = "${var.artifact_dir}/${m.path}"
      }
    ]
  }
}

# ── Durable Objects ──────────────────────────────────────────────────────────
#
# A class's namespace is created, renamed or deleted by a MIGRATION, and
# Cloudflare applies a migration when the version carrying it is DEPLOYED. So
# the versions API refuses a version that both creates a class and binds it
# (100123, terraform-provider-cloudflare#6852): at upload time the class does
# not exist. The same endpoint called with `deploy=true` creates the version and
# deploys it in one step, which is what `wrangler deploy` does, and accepts both.
#
# Measured against the API, and each one shaped what follows:
#
#   - a version carrying pending steps, created with `deploy = true`: accepted,
#     live at once, the script's tag moves to the new one.
#   - deploying that same version AGAIN, which is what the deployment resource
#     below would do: refused (10079), because its steps start from a tag the
#     script has since left.
#   - a version carrying no migrations, deployed onto a script that has a tag:
#     refused (10210). A version records the tag it was built against.
#   - a version carrying `old_tag = new_tag = <current tag>` and no steps:
#     accepted and deployable any number of times.
#
# Hence two versions per worker that declares migrations:
#
#   `migrate` carries the pending steps and is created with `deploy = true`.
#   Once they are applied the next plan computes different steps for it, and
#   it ignores that, so a re-apply is a no-op. It is still replaced whenever
#   the code changes, because the provider derives each module's checksum from
#   the file at plan time and that forces a replacement past `ignore_changes`.
#   With nothing pending it is then created WITHOUT being deployed: one extra,
#   inert version per release of a worker declaring Durable Objects, which is
#   the price of a plan that settles.
#
#   `this` is the ordinary version, pinned to the last tag with no steps, and
#   is what the deployment resource puts live, exactly as for a worker with no
#   Durable Objects. It waits for `migrate`, because its bindings name classes
#   that exist only once the migration is applied.
#
# Which tag the script is on is read from the account at plan time, so a tag
# applied by something else is respected rather than replayed, and a tag the
# artifact does not list is refused in validate.tf.

locals {
  do_resources = { for k, r in local.declared : k => r if r.kind == "durable_object" }

  # The worker exporting each class. The validator requires `worker` when the
  # artifact ships more than one, so the fallback only ever names the only one.
  do_owner = { for k, r in local.do_resources : k => try(r.worker, local.workers[0].name) }

  do_steps   = { for w in local.workers : w.name => try(w.durable_object_migrations, []) }
  do_workers = [for w, steps in local.do_steps : w if length(steps) > 0]
  do_tags    = { for w in local.do_workers : w => [for step in local.do_steps[w] : step.tag] }
  last_tag   = { for w in local.do_workers : w => local.do_tags[w][length(local.do_tags[w]) - 1] }

  # The tag the live script carries, or null for a script that has never
  # applied one or does not exist yet. Empty means the same as null.
  applied_tag = {
    for w in local.do_workers : w => try(one([
      for s in data.cloudflare_workers_scripts.live[0].result : s.migration_tag
      if s.id == local.script[w] && try(s.migration_tag, null) != null && try(s.migration_tag, "") != ""
    ]), null)
  }

  # -1: nothing applied yet, every step is pending. -2: the script carries a
  # tag this artifact does not declare, which validate.tf refuses.
  applied_index = {
    for w in local.do_workers : w => local.applied_tag[w] == null ? -1 : try(index(local.do_tags[w], local.applied_tag[w]), -2)
  }

  pending = {
    for w in local.do_workers : w => local.applied_index[w] == -2 ? [] : slice(local.do_steps[w], local.applied_index[w] + 1, length(local.do_steps[w]))
  }

  # What `this` carries: the last tag, no steps.
  steady_migrations = { for w in local.do_workers : w => { old_tag = local.last_tag[w], new_tag = local.last_tag[w] } }

  # What `migrate` carries. With nothing pending, which is the case when the
  # tag was applied by something else, it degrades to the steady shape and is
  # created without being deployed.
  pending_migrations = {
    for w in local.do_workers : w => length(local.pending[w]) == 0 ? {
      old_tag = local.last_tag[w]
      new_tag = local.last_tag[w]
      steps   = null
      } : {
      old_tag = local.applied_tag[w]
      new_tag = local.last_tag[w]
      steps = [
        for step in local.pending[w] : {
          new_sqlite_classes  = try(step.new_sqlite_classes, null)
          new_classes         = try(step.new_classes, null)
          deleted_classes     = try(step.deleted_classes, null)
          renamed_classes     = try(step.renamed_classes, null)
          transferred_classes = try(step.transferred_classes, null)
        }
      ]
    }
  }
}

# Read only when the artifact declares Durable Object migrations, so an artifact
# without any plans exactly as it did before.
data "cloudflare_workers_scripts" "live" {
  count = length(local.do_workers) > 0 ? 1 : 0

  account_id = var.account_id
}

resource "random_bytes" "generated" {
  for_each = local.generated

  length = each.value.generate.bytes
}

# What a version is made of, shared by `this` and `migrate` so the two cannot
# upload different code.
locals {
  # Omitted when the artifact declares none. Cloudflare returns the EFFECTIVE
  # flag set, which includes what the compatibility date implies, so pinning an
  # empty list here would differ from what comes back and replace the version on
  # every plan.
  compatibility_flags = length(try(local.artifact.runtime.compatibility_flags, [])) > 0 ? local.artifact.runtime.compatibility_flags : null

  # Tri-state, and `null` is the third state rather than a missing value: the
  # attribute is Optional AND Computed, so omitting it keeps whatever the
  # platform holds. An artifact that says nothing about caching therefore does
  # not turn it off, which is what an artifact saying nothing should mean.
  cache_options = try(local.artifact.runtime.cache, null) == null ? null : {
    enabled             = try(local.artifact.runtime.cache.enabled, null)
    cross_version_cache = try(local.artifact.runtime.cache.cross_version_cache, null)
  }

  placement = try(local.artifact.runtime.placement, null) == null ? null : {
    mode = local.artifact.runtime.placement.mode
  }

  # An attribute, not a block: the provider takes one object and runs the asset
  # upload session itself.
  version_assets = {
    for w in local.workers : w.name => local.assets != null && contains(local.uses[w.name], try(local.assets.binding, "")) ? {
      directory = "${var.artifact_dir}/${local.assets.directory}"
      config = {
        not_found_handling = try(local.assets.not_found_handling, null)
        html_handling      = try(local.assets.html_handling, null)
        run_worker_first   = try(local.assets.run_worker_first, null)
      }
    } : null
  }
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

  compatibility_date  = local.artifact.runtime.compatibility_date
  compatibility_flags = local.compatibility_flags

  main_module = local.modules[each.key][0].name
  modules     = local.modules[each.key]
  bindings    = local.bindings[each.key]

  cache_options = local.cache_options
  limits        = try(local.artifact.runtime.limits, null)
  placement     = local.placement
  assets        = local.version_assets[each.key]

  # What the version list in the dashboard shows. The module knows the tag, so
  # there is no reason for every version to be anonymous.
  annotations = {
    workers_message = var.message
    workers_tag     = var.tag
  }

  # Pinned to the last tag with no steps, for a worker with Durable Object
  # migrations, and null for every other, which is every artifact that
  # predates them. See the Durable Objects section above.
  migrations = try(local.steady_migrations[each.key], null)

  # Its bindings name classes that exist only once `migrate` is live.
  depends_on = [cloudflare_worker_version.migrate]

  lifecycle {
    # Any change to modules, bindings or flags forces replacement. Without this
    # the currently serving version is DESTROYED FIRST, and the gap is real
    # downtime rather than a swap.
    create_before_destroy = true
  }
}

# The version that applies Durable Object migrations, one per worker declaring
# any. Created and deployed in one call when steps are pending, and created
# without being deployed otherwise. See the Durable Objects section above.
resource "cloudflare_worker_version" "migrate" {
  for_each = toset(local.do_workers)

  account_id = var.account_id
  worker_id  = cloudflare_worker.this[each.key].id

  compatibility_date  = local.artifact.runtime.compatibility_date
  compatibility_flags = local.compatibility_flags

  main_module = local.modules[each.key][0].name
  modules     = local.modules[each.key]
  bindings    = local.bindings[each.key]

  cache_options = local.cache_options
  limits        = try(local.artifact.runtime.limits, null)
  placement     = local.placement
  assets        = local.version_assets[each.key]

  # Says in the dashboard why this version exists, and moves exactly when the
  # artifact adds a step, which makes a new `migrate` version even for a
  # release whose code is unchanged. No release tag in it, which would make a
  # new one for a release that changed only a binding.
  annotations = {
    workers_message = "Durable Object migrations to ${local.last_tag[each.key]}"
  }

  migrations = local.pending_migrations[each.key]
  deploy     = length(local.pending[each.key]) > 0 ? true : null

  lifecycle {
    create_before_destroy = true

    # A version is immutable and every one of these forces a replacement.
    # `migrations` and `deploy` describe the tag the script was on when this
    # was created and differ on the very next plan, so without this a
    # migration would cost a second version on the apply after it. `modules`
    # is listed and does not hold: see the Durable Objects section above. When
    # the version is replaced for any reason it takes the current values of
    # all of them, so pending steps always ride on the new one.
    ignore_changes = [
      compatibility_date, compatibility_flags, main_module, modules, bindings,
      cache_options, limits, placement, assets, migrations, deploy,
    ]
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
