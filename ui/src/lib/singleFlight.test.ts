import { describe, expect, it } from "vitest";
import { singleFlight } from "./singleFlight";

describe("singleFlight", () => {
  it("drops a second call while the first one runs, and runs again after it", async () => {
    const once = singleFlight();
    let calls = 0;
    let finish: () => void = () => {};
    const slow = () =>
      new Promise<number>((r) => {
        calls++;
        finish = () => r(calls);
      });
    const first = once(slow);
    const second = once(slow);
    expect(calls).toBe(1);
    finish();
    expect(await first).toBe(1);
    expect(await second).toBeUndefined();
    const third = once(slow);
    finish();
    expect(await third).toBe(2);
  });

  it("opens again after a failed run", async () => {
    const once = singleFlight();
    await expect(once(() => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await once(async () => 7)).toBe(7);
  });
});
