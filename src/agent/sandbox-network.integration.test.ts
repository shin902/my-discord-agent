import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestHandler } from "../proxy/credential-proxy-server.js";
import {
  createToolProxyRun,
  initToolProxyServer,
  stopToolProxyServer,
} from "../proxy/tool-proxy-server.js";
import * as runtime from "../runtime/tool-runtime-client.js";
import { createToolRuntimeFixture } from "../runtime/tool-runtime-fixture.js";
import { sandboxNetworkArgs } from "./sandbox-network.js";

const exec = promisify(execFile);
const image = process.env.SANDBOX_NETWORK_TEST_IMAGE ?? "";
const runtimeImage = process.env.TOOL_RUNTIME_TEST_IMAGE;
const servers: Server[] = [];
const containers: string[] = [];
function testContainerName(): string[] {
  const name = `sandbox-network-test-${randomUUID()}`;
  containers.push(name);
  return ["--name", name];
}
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  return (server.address() as { port: number }).port;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    containers.splice(0).map(async (name) => {
      try {
        await exec("docker", ["rm", "-f", name]);
      } catch (error) {
        if (!String(error).includes("No such container")) throw error;
      }
    }),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe.skipIf(!image || !runtimeImage)(
  "Agent sandbox kernel network boundary (Docker)",
  () => {
    it("blocks reachable public/private/loopback addresses for arbitrary programs and cannot be removed", async () => {
      const port = await listen(
        createServer((_req, res) => res.end("allowed")),
      );
      const deniedPort = await listen(
        createServer((_req, res) => res.end("must not reach")),
      );
      // In this test only, put representative addresses on lo and verify they
      // actually accept connections before applying the production entrypoint.
      // No probing real metadata/LAN/Internet services and no dead-target false pass.
      const addresses = [
        "1.1.1.1",
        "127.0.0.1",
        "127.0.0.11",
        "10.0.0.1",
        "172.16.0.1",
        "192.168.0.1",
        "100.64.0.1",
        "169.254.169.254",
      ];
      const ipv6 = ["::1", "2606:4700:4700::1111", "fd00::1"];
      const udpProbe = `
        async function udp(host) {
          return new Promise((resolve, reject) => {
            const socket = require('node:dgram').createSocket('udp4');
            const timer = setTimeout(() => { socket.close(); reject(new Error('timeout')); }, 400);
            socket.on('message', () => { clearTimeout(timer); socket.close(); resolve(); });
            socket.on('error', error => { clearTimeout(timer); socket.close(); reject(error); });
            socket.send('probe', 18080, host);
          });
        }
      `;
      const probe = `
      const assert = require('node:assert/strict');
      const { readFileSync } = require('node:fs');
      const { execFileSync, spawnSync } = require('node:child_process');
      const net = require('node:net');
      const addresses = ${JSON.stringify(addresses)};
      ${udpProbe}
      async function connect(host, port) {
        return new Promise((resolve, reject) => {
          const s = net.connect({host, port});
          s.setTimeout(400, () => s.destroy(new Error('timeout')));
          s.once('connect', () => { s.destroy(); resolve(); });
          s.once('error', reject);
        });
      }
      (async () => {
        assert.notEqual(process.getuid(), 0);
        const status = readFileSync('/proc/self/status', 'utf8');
        for (const cap of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
          assert.match(status, new RegExp(cap + ':\\\\s+0+\\\\n'));
        }
        assert.match(status, /NoNewPrivs:\\s+1/);
        assert.notEqual(spawnSync('iptables', ['-F', 'OUTPUT']).status, 0);
        assert.notEqual(spawnSync('ip', ['addr', 'add', '10.1.2.3/32', 'dev', 'lo']).status, 0);
        await Promise.all([...addresses, ...${JSON.stringify(ipv6)}, '::ffff:127.0.0.1', '::ffff:1.1.1.1'].map(a => assert.rejects(connect(a, 18080))));
        await Promise.all(addresses.map(a => assert.rejects(udp(a))));
        await assert.rejects(connect('host.docker.internal', ${deniedPort}));
        await connect('host.docker.internal', ${port});
        assert.equal(await (await fetch('http://host.docker.internal:${port}')).text(), 'allowed');
        for (const address of addresses) {
          assert.notEqual(spawnSync('curl', ['--noproxy', '*', '--max-time', '0.4', 'http://' + address + ':18080']).status, 0);
          assert.notEqual(spawnSync('python3', ['-c', 'import socket; socket.create_connection((' + JSON.stringify(address) + ',18080), timeout=0.4)']).status, 0);
        }
        assert.notEqual(spawnSync('dig', ['@127.0.0.11', 'example.com', '+time=1', '+tries=1']).status, 0);
        assert.notEqual(spawnSync('dig', ['@1.1.1.1', 'example.com', '+time=1', '+tries=1']).status, 0);
        console.log('boundary verified');
      })().catch(e => { console.error(e); process.exit(1); });
    `;
      const setup = `
      const { execFileSync, spawn } = require('node:child_process');
      const net = require('node:net');
      ${udpProbe}
      (async () => {
        for (const address of ${JSON.stringify(addresses)}.filter(a => !a.startsWith('127.'))) {
          execFileSync('ip', ['addr', 'add', address + '/32', 'dev', 'lo']);
        }
        for (const address of ${JSON.stringify(ipv6.slice(1))}) {
          execFileSync('ip', ['-6', 'addr', 'add', address + '/128', 'dev', 'lo']);
        }
        const server = net.createServer(s => s.end());
        await new Promise(r => server.listen(18080, '::', r));
        await new Promise((resolve, reject) => {
          const s = net.connect({host: 'host.docker.internal', port: ${deniedPort}});
          s.once('connect', () => { s.destroy(); resolve(); }); s.once('error', reject);
        });
        const udpServer = require('node:dgram').createSocket('udp4');
        udpServer.on('message', (message, remote) => udpServer.send(message, remote.port, remote.address));
        await new Promise(r => udpServer.bind(18080, '0.0.0.0', r));
        await Promise.all(${JSON.stringify(addresses)}.map(udp));
        for (const host of [...${JSON.stringify(addresses)}, ...${JSON.stringify(ipv6)}]) {
          await new Promise((resolve, reject) => {
            const s = net.connect({host, port: 18080});
            s.once('connect', () => { s.destroy(); resolve(); }); s.once('error', reject);
          });
        }
        const child = spawn('/bin/sh', ['/app/sandbox-entrypoint.sh', 'node', '-e', ${JSON.stringify(probe)}], {stdio:'inherit'});
        child.on('exit', code => { server.close(); udpServer.close(); process.exit(code ?? 1); });
      })().catch(e => { console.error(e); process.exit(1); });
    `;
      // Pass code as argv rather than shell interpolation or inherited host env.
      const checked = await exec(
        "docker",
        [
          "run",
          "--rm",
          ...testContainerName(),
          ...sandboxNetworkArgs([port]),
          image,
          "-c",
          'exec node -e "$1"',
          "test",
          setup,
        ],
        { timeout: 45000 },
      );
      expect(checked.stdout).toContain("boundary verified");
    }, 60000);

    it("fails closed before starting Node if firewall setup is unavailable", async () => {
      const args = sandboxNetworkArgs([12345]).filter(
        (arg) => arg !== "--cap-add=NET_ADMIN",
      );
      await expect(
        exec(
          "docker",
          [
            "run",
            "--rm",
            ...testContainerName(),
            ...args,
            image,
            "/app/sandbox-entrypoint.sh",
            "node",
            "-e",
            "console.log('UNCONFINED')",
          ],
          { timeout: 10000 },
        ),
      ).rejects.toMatchObject({ stdout: "" });
    });

    it("runs the real Agent loop through Credential Proxy and Tool Proxy → disposable Runtime", async () => {
      const runtimeCalls: string[] = [];
      const fixture = await createToolRuntimeFixture(runtimeImage as string);
      let revoke: (() => void) | undefined;
      try {
        const actualExecute = runtime.executeToolRuntime;
        vi.spyOn(runtime, "executeToolRuntime").mockImplementation(
          (name, args, signal) => {
            runtimeCalls.push((args as { url: string }).url);
            return actualExecute(name, args, signal, fixture.options);
          },
        );
        const toolPort = await initToolProxyServer();
        const run = createToolProxyRun("network-test", ["agent-reach"]);
        if (!run) throw new Error("No test run authority");
        revoke = run.revoke;
        let requests = 0;
        const upstream = await listen(
          createServer(async (req, res) => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            expect(req.headers.authorization).toBe(
              "Bearer upstream-only-secret",
            );
            const toolResult = body.messages.some(
              (m: { role: string }) => m.role === "tool",
            );
            if (toolResult)
              expect(JSON.stringify(body.messages)).toContain(
                "Runtime web fixture",
              );
            requests++;
            res.writeHead(200, { "content-type": "text/event-stream" });
            const delta = toolResult
              ? { role: "assistant", content: "network-ok" }
              : {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_fixture",
                      type: "function",
                      function: {
                        name: "agent-reach",
                        arguments: JSON.stringify({
                          url: "https://example.com/",
                        }),
                      },
                    },
                  ],
                };
            res.write(
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
            );
            res.end(
              `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: toolResult ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
            );
          }),
        );
        vi.stubEnv("NETWORK_TEST_UPSTREAM_KEY", "upstream-only-secret");
        const proxyPort = await listen(
          createServer(
            createRequestHandler(
              [
                {
                  provider: "fixture",
                  baseUrl: `http://127.0.0.1:${upstream}/v1`,
                  envVars: ["NETWORK_TEST_UPSTREAM_KEY"],
                },
              ],
              10000,
            ),
          ),
        );
        const payload = {
          groupName: "network-test",
          sessionId: "fixture",
          content: "Read the page",
          groupConfig: {
            model: { provider: "fixture", modelId: "fixture" },
            tools: ["agent-reach"],
            skills: [],
          },
          toolProxyEndpoint: run,
        };
        const result = await new Promise<{ stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(
              "docker",
              [
                "run",
                "--rm",
                ...testContainerName(),
                "-i",
                ...sandboxNetworkArgs([proxyPort, toolPort]),
                "-e",
                "HOME=/tmp",
                "-e",
                "SESSIONS_DIR=/tmp/sessions",
                "-e",
                `CREDENTIAL_PROXY_JSON=${JSON.stringify([{ provider: "fixture", baseUrl: `http://host.docker.internal:${proxyPort}/fixture` }])}`,
                image,
                "/app/sandbox-entrypoint.sh",
                "node",
                "/app/runner.mjs",
              ],
              { stdio: ["pipe", "pipe", "pipe"] },
            );
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => {
              stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0
                ? resolve({ stdout, stderr })
                : reject(new Error(stderr)),
            );
            child.stdin.end(`${JSON.stringify(payload)}\n`);
          },
        );
        expect(result.stdout).toContain("network-ok");
        expect(result.stderr).toContain("__AGENT_READY__");
        expect(requests).toBe(2);
        expect(runtimeCalls).toEqual(["https://example.com/"]);
        expect(result.stdout + result.stderr).not.toContain(
          "upstream-only-secret",
        );
      } finally {
        revoke?.();
        await stopToolProxyServer();
        await fixture.dispose();
      }
    }, 45000);
  },
);
