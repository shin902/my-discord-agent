import { beforeEach, describe, expect, it, vi } from "vitest";

type LlmMutexModule = typeof import("./llm-mutex.js");

let acquireLlmLock: LlmMutexModule["acquireLlmLock"];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  vi.resetModules();
  ({ acquireLlmLock } = await import("./llm-mutex.js"));
});

describe("acquireLlmLock", () => {
  it("parallel provider は同時に複数取得できる", async () => {
    const release1 = await acquireLlmLock("provider-a", "parallel");
    const release2 = await acquireLlmLock("provider-a", "parallel");
    release1();
    release2();
  });

  it("同じ serial provider は release まで待機する", async () => {
    const release1 = await acquireLlmLock("provider-a", "serial");
    let acquired2 = false;
    const second = acquireLlmLock("provider-a", "serial").then((release) => {
      acquired2 = true;
      release();
    });

    await tick();
    expect(acquired2).toBe(false);

    release1();
    await second;
    expect(acquired2).toBe(true);
  });

  it("同じ serial provider の待機タスクは FIFO 順で取得する", async () => {
    const release1 = await acquireLlmLock("provider-a", "serial");
    const order: string[] = [];
    const second = acquireLlmLock("provider-a", "serial").then((release) => {
      order.push("second");
      release();
    });
    const third = acquireLlmLock("provider-a", "serial").then((release) => {
      order.push("third");
      release();
    });

    await tick();
    expect(order).toEqual([]);

    release1();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("異なる serial provider は同時に取得できる", async () => {
    const releaseA = await acquireLlmLock("provider-a", "serial");
    const releaseB = await acquireLlmLock("provider-b", "serial");
    releaseA();
    releaseB();
  });

  it("release は複数回呼んでも次の待機タスクを飛ばさない", async () => {
    const release1 = await acquireLlmLock("provider-a", "serial");
    const order: string[] = [];
    const second = acquireLlmLock("provider-a", "serial").then((release) => {
      order.push("second");
      release();
    });
    const third = acquireLlmLock("provider-a", "serial").then((release) => {
      order.push("third");
      release();
    });

    release1();
    release1();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("idle 後に同じ provider の mutex を再作成できる", async () => {
    const release1 = await acquireLlmLock("provider-a", "serial");
    release1();

    const release2 = await acquireLlmLock("provider-a", "serial");
    release2();
  });
});
