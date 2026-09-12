import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, startScreenCaptureReceiver } from "./receiver.js";
import { openScreenCaptureDb } from "./store.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1sAAAAASUVORK5CYII=",
  "base64",
);

describe("screen capture HTTP / SQLite boundary", () => {
  let directory: string;
  let dbPath: string;
  let server: Server;
  let endpoint: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-receiver-"));
    dbPath = path.join(directory, "captures.sqlite");
    server = await startScreenCaptureReceiver({ port: 0, dbPath });
    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    endpoint = `http://127.0.0.1:${address.port}/v1/screen-captures`;
  });
  afterEach(async () => {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  function post(id: string = randomUUID(), body = png, headers = {}) {
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-Capture-Id": id, ...headers },
      body,
    });
  }

  it("ACKs durable unread images; retries preserve timestamp, bytes and summary", async () => {
    const id = randomUUID();
    const response = await post(id.toUpperCase());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: id });
    const db = openScreenCaptureDb(dbPath);
    try {
      const row = db.prepare("SELECT * FROM screen_captures").get();
      expect(row).toEqual({
        id,
        image: png,
        received_at: expect.any(String),
        summary: null,
      });
      db.prepare(
        "UPDATE screen_captures SET summary = 'Editor work' WHERE id = ?",
      ).run(id);
      expect((await post(id)).status).toBe(200);
      expect(db.prepare("SELECT * FROM screen_captures").get()).toEqual({
        ...(row as object),
        summary: "Editor work",
      });
      const conflict = await post(
        id,
        Buffer.concat([png, Buffer.from("different")]),
      );
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).not.toHaveProperty("accepted");
      expect((await post()).status).toBe(200); // Identical image at a different instant is a new capture.
    } finally {
      db.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const reopened = openScreenCaptureDb(dbPath);
    try {
      expect(
        reopened
          .prepare("SELECT image, summary FROM screen_captures WHERE id = ?")
          .get(id),
      ).toEqual({ image: png, summary: "Editor work" });
      expect(
        reopened
          .prepare("SELECT id FROM screen_captures WHERE summary IS NULL")
          .all(),
      ).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it("does not acknowledge a failed DB commit and can retry it", async () => {
    const db = openScreenCaptureDb(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER fail_capture BEFORE INSERT ON screen_captures BEGIN SELECT RAISE(ABORT, 'failure'); END",
      );
      const id = randomUUID();
      const response = await post(id);
      expect(response.status).toBe(500);
      expect(await response.json()).not.toHaveProperty("accepted");
      expect(db.prepare("SELECT * FROM screen_captures").all()).toEqual([]);
      db.exec("DROP TRIGGER fail_capture");
      expect((await post(id)).status).toBe(200);
    } finally {
      db.close();
    }
  });

  it("rejects invalid HTTP, browser origins, encoding, IDs and non-PNG payloads without writes", async () => {
    expect((await fetch(endpoint)).status).toBe(405);
    expect((await fetch(`${endpoint}/wrong`)).status).toBe(404);
    expect((await post("../../bad")).status).toBe(400);
    expect(
      (await post(randomUUID(), png, { Origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(
      (await post(randomUUID(), png, { "Content-Type": "image/jpeg" })).status,
    ).toBe(415);
    expect(
      (await post(randomUUID(), png, { "Content-Encoding": "gzip" })).status,
    ).toBe(415);
    expect((await post(randomUUID(), Buffer.from("not an image"))).status).toBe(
      400,
    );
    expect((await post(randomUUID(), Buffer.alloc(0))).status).toBe(400);
    expect(
      (await post(randomUUID(), Buffer.alloc(MAX_IMAGE_BYTES + 1))).status,
    ).toBe(413);
    const db = openScreenCaptureDb(dbPath);
    try {
      expect(db.prepare("SELECT * FROM screen_captures").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
