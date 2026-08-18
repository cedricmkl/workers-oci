#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { build } from "./build.js";
import { ConfigError, validate } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { describe, inspect } from "./inspect.js";
import { pull, push } from "./push.js";

const USAGE = `workers-oci — package a Cloudflare Worker and its resources as an OCI artifact

  workers-oci build   --config <file> --out <dir> [options]
  workers-oci push    <dir> <reference> [--tag <extra>]...
  workers-oci pull    <reference> --into <dir>
  workers-oci inspect <reference|dir> [--json]
  workers-oci verify  <file>
  workers-oci bootstrap --dir <dir> --url <origin> [--token-stdin] [--env K=V]...

build
  --config <file>     the config document
  --out <dir>         where to write the artifact
  --root <dir>        root its paths are relative to (default: the config's directory)
  --include <path>    ship an extra file or directory, repeatable
  --version <tag>     recorded as org.opencontainers.image.version
  --revision <sha>    default: git rev-parse HEAD
  --source <url>      default: the origin remote
  --created <rfc3339> default: the commit timestamp
  --print-digest      print only the manifest digest

registry
  --username <user>       default: ~/.docker/config.json, then a credential helper
  --password-stdin        read the password from stdin
  Or set WORKERS_OCI_REGISTRY_USER and WORKERS_OCI_REGISTRY_PASSWORD.

  --password and --token also work and warn: a secret in the process arguments
  is readable by every user on the machine.

  Documentation: https://github.com/cedricmkl/workers-oci
`;

type Args = { positional: string[]; flags: Map<string, string[]> };

const parse = (argv: readonly string[]): Args => {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const item = argv[i] ?? "";
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    const key = eq === -1 ? item.slice(2) : item.slice(2, eq);
    const next = argv[i + 1];
    const value =
      eq !== -1 ? item.slice(eq + 1) : next !== undefined && !next.startsWith("--") ? (i++, next) : "true";

    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { positional, flags };
};

const one = (args: Args, key: string): string | undefined => args.flags.get(key)?.at(-1);
const many = (args: Args, key: string): string[] => args.flags.get(key) ?? [];
const has = (args: Args, key: string): boolean => args.flags.has(key);

const required = (args: Args, key: string): string => {
  const value = one(args, key);
  if (value === undefined) throw new Error(`--${key} is required`);
  return value;
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
};

/**
 * A secret on the command line is readable by every user on the machine.
 *
 * `ps aux` and the process's own cmdline show it while it runs, the shell
 * writes it to history, and CI echoes it whenever the command is printed.
 * `docker login --password` warns for the same reason. The flags still work,
 * because taking them away breaks a script that is otherwise correct, but they
 * say so on stderr and the stdin form is what the docs show.
 */
const warnArgvSecret = (flag: string): void => {
  process.stderr.write(
    `warning: ${flag} puts a secret in the process arguments, where anyone on this machine can read it. Use ${flag}-stdin.\n`,
  );
};

const credentialFrom = async (args: Args) => {
  const username = one(args, "username");
  if (username === undefined) return undefined;
  if (has(args, "password-stdin")) return { username, password: await readStdin() };
  const password = one(args, "password");
  if (password !== undefined) warnArgvSecret("--password");
  return { username, password };
};

const run = async (argv: readonly string[]): Promise<number> => {
  const command = argv[0];
  const args = parse(argv.slice(1));

  if (command === undefined || command === "help" || has(args, "help")) {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  switch (command) {
    case "build": {
      const result = build({
        config: required(args, "config"),
        out: required(args, "out"),
        ...(one(args, "root") !== undefined ? { root: one(args, "root") as string } : {}),
        ...(one(args, "version") !== undefined ? { version: one(args, "version") as string } : {}),
        ...(one(args, "revision") !== undefined ? { revision: one(args, "revision") as string } : {}),
        ...(one(args, "source") !== undefined ? { source: one(args, "source") as string } : {}),
        ...(one(args, "created") !== undefined ? { created: one(args, "created") as string } : {}),
        include: many(args, "include"),
      });

      if (has(args, "print-digest")) {
        process.stdout.write(`${result.digest}\n`);
        return 0;
      }

      process.stderr.write(`${result.app.name}: ${result.files.length} files\n`);
      for (const file of result.files) process.stderr.write(`  ${file}\n`);
      process.stderr.write(`\nmanifest ${result.digest}\n`);
      return 0;
    }

    case "push": {
      const [dir, reference] = args.positional;
      if (dir === undefined || reference === undefined) throw new Error("usage: workers-oci push <dir> <reference>");

      const credential = await credentialFrom(args);
      const result = await push({
        dir,
        reference,
        also: many(args, "tag"),
        ...(credential !== undefined ? { credential } : {}),
      });

      process.stderr.write(`pushed ${result.reference}\n`);
      process.stdout.write(`${result.digest}\n`);
      return 0;
    }

    case "pull": {
      const reference = args.positional[0];
      if (reference === undefined) throw new Error("usage: workers-oci pull <reference> --into <dir>");

      const credential = await credentialFrom(args);
      const result = await pull({
        reference,
        into: required(args, "into"),
        ...(credential !== undefined ? { credential } : {}),
      });

      process.stderr.write(`${result.reference}\n  ${result.files.length} files into ${required(args, "into")}\n`);
      return 0;
    }

    case "inspect": {
      const target = args.positional[0];
      if (target === undefined) throw new Error("usage: workers-oci inspect <reference|dir>");

      const credential = await credentialFrom(args);
      const result = await inspect(target, credential);

      process.stdout.write(has(args, "json") ? `${JSON.stringify(result, null, 2)}\n` : describe(result));
      return 0;
    }

    case "verify": {
      const file = args.positional[0];
      if (file === undefined) throw new Error("usage: workers-oci verify <file>");

      const app = validate(JSON.parse(readFileSync(file, "utf8")));
      process.stderr.write(`${file} is a valid worker-app config document for ${app.name}\n`);
      return 0;
    }

    case "bootstrap": {
      const env: Record<string, string> = {};
      for (const pair of many(args, "env")) {
        const eq = pair.indexOf("=");
        if (eq === -1) throw new Error(`--env takes KEY=VALUE, found: ${pair}`);
        env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }

      // A bearer token for an installation endpoint, same reasoning as
      // `--password` above.
      const token = has(args, "token-stdin") ? await readStdin() : one(args, "token");
      if (!has(args, "token-stdin") && token !== undefined) warnArgvSecret("--token");

      const result = await bootstrap({
        dir: required(args, "dir"),
        url: required(args, "url"),
        ...(token !== undefined ? { token } : {}),
        env,
      });

      if (result === null) process.stderr.write("the artifact declares no bootstrap endpoint\n");
      else process.stderr.write(`bootstrap ${result.endpoint} answered ${result.status}\n`);
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
};

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof ConfigError) process.stderr.write(`${error.message}\n`);
    else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
