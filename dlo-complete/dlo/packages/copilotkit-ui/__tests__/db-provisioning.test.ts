/**
 * __tests__/db-provisioning.test.ts
 * Telling "there is no Docker on this host" apart from "the database broke".
 *
 * From a real run: the fleet had already built module 1 and the pipeline reached
 * DB provisioning, where `docker run` failed with "failed to connect to the
 * docker API at unix:///var/run/docker.sock". That marked the whole pipeline
 * FAILED and discarded everything already built — even though the generated
 * application's tests are required to be hermetic and would still have run.
 */

import { describe, test, expect } from "vitest";
import { isDockerUnavailable } from "../src/lib/orchestrator/phases/finalize";

describe("isDockerUnavailable", () => {
  test.each([
    [
      "the socket is missing (the real observed failure)",
      "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
    ],
    ["the daemon is not running", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"],
    ["the binary is absent", "spawn docker ENOENT"],
    ["the shell cannot find it", "docker: not found"],
    ["command not found", "command not found: docker"],
  ])("treats %s as a missing capability", (_name, message) => {
    expect(isDockerUnavailable(message)).toBe(true);
  });

  test.each([
    ["an image that does not exist", "Unable to find image 'postgres:17-alpine' locally\nErrorpull access denied"],
    ["a port already in use", "Bind for 0.0.0.0:5433 failed: port is already allocated"],
    ["a name collision", "Conflict. The container name \"/dlo-pg-9c897079\" is already in use"],
    ["the disk being full", "no space left on device"],
    ["postgres never becoming ready", "PostgreSQL did not become ready within 60 seconds"],
    ["an empty message", ""],
  ])("still treats %s as a real failure", (_name, message) => {
    expect(isDockerUnavailable(message)).toBe(false);
  });

  test("does not match merely mentioning docker in passing", () => {
    expect(isDockerUnavailable("applied migrations to the docker postgres instance")).toBe(false);
  });
});
