import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { sendMessage } from "../../agent/manager.js";
import { startScreenCaptureReceiver } from "../../integrations/screen-capture/receiver.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-summary.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      callback: (...args: unknown[]) => void,
    ) => callback(null, "", ""),
  ),
}));
vi.mock("../../agent/manager.js", () => ({ sendMessage: vi.fn() }));

it("uploads every PNG, exposes them to the group agent, then completes the rows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "screen-pipeline-"));
  const groupName = `screen-integration-${randomUUID()}`;
  const groupDirectory = path.join(process.cwd(), "groups", groupName);
  let receiver: Server | undefined;
  vi.stubEnv("SCREEN_CAPTURE_DB_PATH", path.join(directory, "captures.sqlite"));
  try {
    const observed: Buffer[] = [];
    vi.mocked(sendMessage).mockImplementation(
      async (group, _session, prompt) => {
        expect(group).toBe(groupName);
        for (const filename of prompt.matchAll(
          /\/workspace\/(\.screen-captures\/[^\s]+\.png)/g,
        ))
          observed.push(await readFile(path.join(groupDirectory, filename[1])));
        await writeFile(path.join(groupDirectory, "agent-ran"), "ok");
        return "updated";
      },
    );

    receiver = await startScreenCaptureReceiver({ port: 0 });
    const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/screen-captures`;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1sAAAAASUVORK5CYII=",
      "base64",
    );
    const pngs = [png, png];
    for (const png of pngs) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Capture-Id": randomUUID(),
        },
        body: png,
      });
      expect(response.status).toBe(200);
    }

    const model = { provider: "llama-cpp", modelId: "vision-model" };
    await handler({
      id: "screen-capture-summary",
      schedule: "5m",
      enabled: true,
      groupName,
      handler: "jobs/screen-capture-summary.ts",
      model,
    } as CronContext);

    expect(observed).toEqual(pngs);
    expect(sendMessage).toHaveBeenCalledWith(
      groupName,
      expect.stringMatching(/^cron-screen-capture-summary-/),
      expect.stringContaining("memory/system/screen-activity-memory.md"),
      expect.objectContaining({ configOverride: { model } }),
    );
    expect(await readFile(path.join(groupDirectory, "agent-ran"), "utf8")).toBe(
      "ok",
    );
    const db = openScreenCaptureDb();
    try {
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM screen_captures WHERE completed_at IS NOT NULL",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  } finally {
    receiver?.closeAllConnections();
    if (receiver)
      await new Promise<void>((resolve) => receiver?.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
    await rm(groupDirectory, { recursive: true, force: true });
  }
});
