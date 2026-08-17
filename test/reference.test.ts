import { describe, expect, test } from "bun:test";
import { formatReference, parseReference, schemeFor } from "../src/reference.js";

const DIGEST = "sha256:b39eada0f4f2e6c2bd4e5bd8f4e34cb5b1a2d0c9e8f7a6b5c4d3e2f1a0b9c8d7";

describe("parseReference", () => {
  test("registry, repository and tag", () => {
    const ref = parseReference("ghcr.io/example/app:v1.2.3");
    expect(ref).toMatchObject({ registry: "ghcr.io", repository: "example/app", tag: "v1.2.3" });
    expect(ref.digest).toBeUndefined();
  });

  test("tag and digest together", () => {
    const ref = parseReference(`ghcr.io/example/app:v1.2.3@${DIGEST}`);
    expect(ref.tag).toBe("v1.2.3");
    expect(ref.digest).toBe(DIGEST);
  });

  test("digest alone", () => {
    const ref = parseReference(`ghcr.io/example/app@${DIGEST}`);
    expect(ref.tag).toBeUndefined();
    expect(ref.digest).toBe(DIGEST);
  });

  test("a port is not a tag", () => {
    const ref = parseReference("localhost:5000/app:v1");
    expect(ref).toMatchObject({ registry: "localhost:5000", repository: "app", tag: "v1" });
  });

  test("a port with no tag", () => {
    expect(parseReference("localhost:5000/app")).toMatchObject({
      registry: "localhost:5000",
      repository: "app",
      tag: "latest",
    });
  });

  test("a nested repository path", () => {
    expect(parseReference("123.dkr.ecr.eu-central-1.amazonaws.com/team/app:v1")).toMatchObject({
      registry: "123.dkr.ecr.eu-central-1.amazonaws.com",
      repository: "team/app",
    });
  });

  test("a bare name is a Docker Hub library image", () => {
    expect(parseReference("alpine")).toMatchObject({
      registry: "registry-1.docker.io",
      repository: "library/alpine",
      tag: "latest",
    });
  });

  test("a namespaced name without a host is Docker Hub", () => {
    expect(parseReference("someuser/app:v2")).toMatchObject({
      registry: "registry-1.docker.io",
      repository: "someuser/app",
    });
  });

  test("no tag and no digest defaults to latest", () => {
    expect(parseReference("ghcr.io/example/app").tag).toBe("latest");
  });

  test("rejects a malformed digest", () => {
    expect(() => parseReference("ghcr.io/example/app@sha256:nope!")).toThrow(/not a digest/);
  });

  test("rejects an empty reference", () => {
    expect(() => parseReference("   ")).toThrow(/empty reference/);
  });

  test("formats back to what was given", () => {
    const input = `ghcr.io/example/app:v1.2.3@${DIGEST}`;
    expect(formatReference(parseReference(input))).toBe(input);
  });
});

describe("schemeFor", () => {
  test("https for a real registry", () => {
    expect(schemeFor("ghcr.io")).toBe("https");
  });

  test("http for loopback", () => {
    expect(schemeFor("localhost:5000")).toBe("http");
    expect(schemeFor("127.0.0.1:5000")).toBe("http");
  });
});
