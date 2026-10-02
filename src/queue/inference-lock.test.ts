import { beforeEach, describe, expect, it, vi } from "vitest";

type InferenceLockModule = typeof import("./inference-lock.js");

let createHeldInferenceResource: InferenceLockModule["createHeldInferenceResource"];
let acquireInferenceLock: InferenceLockModule["acquireInferenceLock"];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
  vi.resetModules();
  ({ acquireInferenceLock, createHeldInferenceResource } = await import(
    "./inference-lock.js"
  ));
});

describe("acquireInferenceLock", () => {
  it("parallel provider は同時に複数取得できる", async () => {
    const release1 = await acquireInferenceLock("provider-a", "parallel");
    const release2 = await acquireInferenceLock("provider-a", "parallel");

    expect(typeof release1).toBe("function");
    expect(typeof release2).toBe("function");
    release1();
    release2();
  });

  it("同じ serial provider は release まで待機する", async () => {
    const release1 = await acquireInferenceLock("provider-a", "serial");
    let acquired2 = false;
    const second = acquireInferenceLock("provider-a", "serial").then(
      (release) => {
        acquired2 = true;
        release();
      },
    );

    await tick();
    expect(acquired2).toBe(false);

    release1();
    await second;
    expect(acquired2).toBe(true);
  });

  it("同じ serial provider の待機タスクは FIFO 順で取得する", async () => {
    const release1 = await acquireInferenceLock("provider-a", "serial");
    const order: string[] = [];
    const second = acquireInferenceLock("provider-a", "serial").then(
      (release) => {
        order.push("second");
        release();
      },
    );
    const third = acquireInferenceLock("provider-a", "serial").then(
      (release) => {
        order.push("third");
        release();
      },
    );

    await tick();
    expect(order).toEqual([]);

    release1();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("異なる serial provider は同時に取得できる", async () => {
    const releaseA = await acquireInferenceLock("provider-a", "serial");
    const releaseB = await acquireInferenceLock("provider-b", "serial");

    expect(typeof releaseA).toBe("function");
    expect(typeof releaseB).toBe("function");
    releaseA();
    releaseB();
  });

  it("release は複数回呼んでも次の待機タスクを飛ばさない", async () => {
    const release1 = await acquireInferenceLock("provider-a", "serial");
    const order: string[] = [];
    const second = acquireInferenceLock("provider-a", "serial").then(
      (release) => {
        order.push("second");
        release();
      },
    );
    const third = acquireInferenceLock("provider-a", "serial").then(
      (release) => {
        order.push("third");
        release();
      },
    );

    release1();
    release1();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
  });

  it("idle 後に同じ provider の semaphore を再作成できる", async () => {
    const release1 = await acquireInferenceLock("provider-a", "serial");
    release1();

    const release2 = await acquireInferenceLock("provider-a", "serial");
    expect(typeof release2).toBe("function");
    release2();
  });
});

describe("finite inference capacity", () => {
  it("admits eight, hands the freed slot to the ninth in FIFO order, and ignores duplicate release", async () => {
    const releases = await Promise.all(
      Array.from({ length: 8 }, () => acquireInferenceLock("gpu", 8)),
    );
    const order: number[] = [];
    const ninth = acquireInferenceLock("gpu", 8).then((release) => {
      order.push(9);
      return release;
    });
    const tenth = acquireInferenceLock("gpu", 8).then((release) => {
      order.push(10);
      return release;
    });
    await tick();
    expect(order).toEqual([]);
    releases[0]();
    releases[0]();
    const release9 = await ninth;
    expect(order).toEqual([9]);
    const eleventh = acquireInferenceLock("gpu", 8).then((release) => {
      order.push(11);
      return release;
    });
    release9();
    const release10 = await tenth;
    expect(order).toEqual([9, 10]);
    release10();
    (await eleventh)();
    releases.forEach((release) => {
      release();
    });
    expect(order).toEqual([9, 10, 11]);
    (await acquireInferenceLock("gpu", 8))();
  });

  it("removes aborted waiters without leaking capacity and detaches listeners after acquisition", async () => {
    const first = await acquireInferenceLock("gpu", 1);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = acquireInferenceLock("gpu", 1, controller.signal);
    const rejected = expect(waiting).rejects.toThrow("aborted");
    const nextController = new AbortController();
    const nextRemove = vi.spyOn(nextController.signal, "removeEventListener");
    const next = acquireInferenceLock("gpu", 1, nextController.signal);
    controller.abort();
    await rejected;
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
    first();
    const release = await next;
    expect(nextRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    nextController.abort(); // Ownership belongs to the caller until release, even on abort.
    let acquired = false;
    const last = acquireInferenceLock("gpu", 1).then((done) => {
      acquired = true;
      return done;
    });
    await tick();
    expect(acquired).toBe(false);
    release();
    (await last)();
    await expect(
      acquireInferenceLock("gpu", 1, controller.signal),
    ).rejects.toThrow("aborted");
    (await acquireInferenceLock("gpu", 1))();
  });

  it("does not grant an aborted waiter when another abort listener releases the slot first", async () => {
    const first = await acquireInferenceLock("gpu", 1);
    const controller = new AbortController();
    controller.signal.addEventListener("abort", first, { once: true });
    const waiting = acquireInferenceLock("gpu", 1, controller.signal);
    const rejected = expect(waiting).rejects.toThrow("aborted");
    const next = acquireInferenceLock("gpu", 1);
    controller.abort();
    await rejected;
    (await next)();
    (await acquireInferenceLock("gpu", 1))();
  });

  it("refuses inconsistent limits on a live resource", async () => {
    const release = await acquireInferenceLock("gpu", 8);
    await expect(acquireInferenceLock("gpu", 2)).rejects.toThrow(
      "limit mismatch",
    );
    release();
  });

  it("closing a parent cancels waiting borrowers but drains its active child before returning", async () => {
    const held = createHeldInferenceResource("gpu");
    const release = await held.borrow();
    const waiting = held.borrow();
    const rejected = expect(waiting).rejects.toThrow("aborted");
    let closed = false;
    const closing = held.close().then(() => {
      closed = true;
    });
    await rejected;
    expect(held.signal.aborted).toBe(true);
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    await expect(held.borrow()).rejects.toThrow("aborted");
    await held.close();
  });
});
