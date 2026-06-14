import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

type LlmSemaphoreModule = typeof import("./llm-semaphore.js");

let acquireLlmLock: LlmSemaphoreModule["acquireLlmLock"];

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

beforeEach(async () => {
  vi.resetModules();
  ({ acquireLlmLock } = await import("./llm-semaphore.js"));
});

describe("acquireLlmLock - parallel-session モード", () => {
  it("即座に release を返す（待機なし）", async () => {
    const release1 = await acquireLlmLock("parallel-session");
    const release2 = await acquireLlmLock("parallel-session");

    expect(typeof release1).toBe("function");
    expect(typeof release2).toBe("function");
    release1();
    release2();
  });

  it("同時に複数取得しても待機しない", async () => {
    const order: number[] = [];

    const release1 = await acquireLlmLock("parallel-session");
    order.push(1);
    const release2 = await acquireLlmLock("parallel-session");
    order.push(2);

    expect(order).toEqual([1, 2]);
    release1();
    release2();
  });
});

describe("acquireLlmLock - serial モード", () => {
  it("1つ目が release されるまで2つ目は待機する", async () => {
    const order: number[] = [];

    const release1 = await acquireLlmLock("serial");
    order.push("acquired-1" as unknown as number);

    let release2Resolved = false;
    const p2 = acquireLlmLock("serial").then((release2) => {
      release2Resolved = true;
      order.push("acquired-2" as unknown as number);
      release2();
    });

    await tick();
    expect(release2Resolved).toBe(false);

    release1();
    await p2;
    expect(release2Resolved).toBe(true);
  });

  it("待機中の複数タスクは FIFO 順で acquire される", async () => {
    const order: string[] = [];

    const release1 = await acquireLlmLock("serial");

    const p2 = acquireLlmLock("serial").then((release) => {
      order.push("s2");
      release();
    });
    const p3 = acquireLlmLock("serial").then((release) => {
      order.push("s3");
      release();
    });

    await tick();
    expect(order).toEqual([]);

    release1();
    await Promise.all([p2, p3]);
    expect(order).toEqual(["s2", "s3"]);
  });

  it("異なる sessionId でも concurrency=1 で直列化される", async () => {
    const order: number[] = [];
    let resolveSlow!: () => void;
    const slow = new Promise<void>((r) => {
      resolveSlow = r;
    });

    const release1 = await acquireLlmLock("serial");
    const task1 = (async () => {
      await slow;
      order.push(1);
      release1();
    })();

    let started2 = false;
    const task2 = acquireLlmLock("serial").then((release2) => {
      started2 = true;
      order.push(2);
      release2();
    });

    await tick();
    expect(started2).toBe(false);

    resolveSlow();
    await Promise.all([task1, task2]);
    expect(order).toEqual([1, 2]);
  });
});
