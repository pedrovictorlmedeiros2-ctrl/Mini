import { test } from "node:test";
import assert from "node:assert/strict";
import { docker, createContainer, deleteContainer, startContainer } from "../src/docker.js";

// These tests exercise the real local Docker daemon (same as the rest of
// this agent) rather than mocking it -- container isolation is exactly the
// kind of property that's easy to get wrong in a way a mock would hide.
// Regression coverage for a real finding from a security pass: two
// containers belonging to different tenants, both on Docker's *default*
// bridge network, could reach each other directly over the network and
// read each other's data -- completely bypassing the application's
// ownership checks. Fixed by putting every managed container on a
// dedicated network with inter-container communication (ICC) disabled.

test("managed containers land on the dedicated atlantic-tenants network with ICC disabled", async () => {
  const { containerId } = await createContainer({
    serverId: "test-isolation-a",
    slug: `isolation-test-a-${Date.now()}`,
    image: "node:20-alpine",
    startCommand: "sleep 30",
    ramMb: 128,
    cpuPercent: 25,
    pidsLimit: 32,
  });

  try {
    const info = await docker.getContainer(containerId).inspect();
    const networks = Object.keys(info.NetworkSettings.Networks);
    assert.deepEqual(networks, ["atlantic-tenants"], "container must be attached to the isolated tenant network, not the default bridge");

    const netInfo = await docker.getNetwork("atlantic-tenants").inspect();
    assert.equal(
      netInfo.Options?.["com.docker.network.bridge.enable_icc"],
      "false",
      "tenant network must have inter-container communication disabled"
    );
  } finally {
    await deleteContainer(containerId);
  }
});

test("two tenant containers on the shared network cannot reach each other, even though the network itself is shared", async () => {
  const victim = await createContainer({
    serverId: "test-isolation-victim",
    slug: `isolation-victim-${Date.now()}`,
    image: "node:20-alpine",
    startCommand: "node -e \"require('http').createServer((q,r)=>r.end('should-not-be-readable')).listen(8080)\"",
    ramMb: 128,
    cpuPercent: 25,
    pidsLimit: 32,
  });
  const attacker = await createContainer({
    serverId: "test-isolation-attacker",
    slug: `isolation-attacker-${Date.now()}`,
    image: "node:20-alpine",
    startCommand: "sleep 30",
    ramMb: 128,
    cpuPercent: 25,
    pidsLimit: 32,
  });

  try {
    await startContainer(victim.containerId);
    await startContainer(attacker.containerId);
    // Give the victim's Node http server a moment to actually start
    // listening -- generous on purpose since this shares the Docker daemon
    // with whatever else is running on the machine, and a flaky "victim
    // wasn't up yet" would make the isolation check pass for the wrong
    // reason (nothing to reach) rather than the right one (reachable but
    // blocked).
    await new Promise((r) => setTimeout(r, 3000));

    const victimInfo = await docker.getContainer(victim.containerId).inspect();
    const victimIp = victimInfo.NetworkSettings.Networks["atlantic-tenants"].IPAddress;

    // Sanity check first: confirm the victim's server is actually up (from
    // inside its own container) so a later "attacker can't reach it" result
    // means the network blocked it, not that there was nothing to reach.
    const selfCheck = await docker.getContainer(victim.containerId).exec({
      Cmd: ["wget", "-T", "2", "-O", "-", "http://127.0.0.1:8080"],
      AttachStdout: true,
      AttachStderr: true,
    });
    const selfStream = await selfCheck.start({});
    const selfChunks = [];
    await new Promise((resolve) => {
      selfStream.on("data", (c) => selfChunks.push(c));
      selfStream.on("end", resolve);
    });
    assert.ok(
      Buffer.concat(selfChunks).toString("utf8").includes("should-not-be-readable"),
      "sanity check failed: victim's own server never came up, so the cross-container result below would be meaningless"
    );

    const exec = await docker.getContainer(attacker.containerId).exec({
      Cmd: ["wget", "-T", "2", "-O", "-", `http://${victimIp}:8080`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({});
    const chunks = [];
    await new Promise((resolve) => {
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", resolve);
    });
    const output = Buffer.concat(chunks).toString("utf8");

    assert.ok(
      !output.includes("should-not-be-readable"),
      `attacker container must NOT be able to read victim's data over the network; got: ${output}`
    );
  } finally {
    await deleteContainer(victim.containerId);
    await deleteContainer(attacker.containerId);
  }
});
