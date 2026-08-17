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
