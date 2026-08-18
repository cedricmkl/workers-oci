-- The migrations the artifact carries, run against the D1 database named by
-- `migrations.binding` before the new version is deployed.
create table if not exists items (
  id text primary key,
  created_at integer not null
);
