output "workers" {
  description = "Script name, live version and hostnames, keyed by the worker name in the artifact."
  value = {
    for w in local.workers : w.name => {
      name       = cloudflare_worker.this[w.name].name
      id         = cloudflare_worker.this[w.name].id
      version_id = cloudflare_worker_version.this[w.name].id
      hostnames  = try(var.domains[w.name], [])
      routes     = try(var.routes[w.name], [])
    }
  }
}

output "app" {
  description = "What is running: the deployment name and the workers the artifact ships."
  value = {
    name    = local.app
    workers = local.names
  }
}

output "generated_secrets" {
  description = <<-EOT
    Values created for the artifact's `generate` secrets, by name.

    Exposed so a caller can write them somewhere durable. Losing one costs live
    sessions, which is the only kind of secret that belongs in a `generate`
    block, so keeping a copy is optional.
  EOT
  value       = local.generated_value
  sensitive   = true
}

# What each worker actually binds, names and types only.
#
# A plan cannot show this: the provider marks a binding's `text` attribute
# sensitive and `plain_text` is what an ordinary variable uses, so one variable
# redacts the whole `bindings` list. This is the readable half, and it carries no
# value of any kind.
output "binding_summary" {
  description = "Worker name -> binding name -> type. No values."
  value = {
    for w, m in local.binding_map : w => { for k, b in m : k => b.type }
  }
}
