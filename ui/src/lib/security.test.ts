import { describe, expect, it } from "vitest";
import { callUnlocked, formatRecoveryInput, formatWait, isLockedError, pinProblem, recoveryComplete } from "./security";

describe("recovery key input", () => {
  it("groups, upper-cases and reads look-alikes as the code's letters", () => {
    expect(formatRecoveryInput("abcd efgh")).toBe("ABCD-EFGH");
    expect(formatRecoveryInput("ab-cd-ef")).toBe("ABCD-EF");
    expect(formatRecoveryInput("0o1i8b")).toBe("OOII-BB");
    expect(formatRecoveryInput("ab9#c")).toBe("ABC");
  });

  it("stops at the full length and knows when it is complete", () => {
    const full = formatRecoveryInput("A".repeat(60));
    expect(full.split("-")).toHaveLength(14);
    expect(recoveryComplete(full)).toBe(true);
    expect(recoveryComplete(formatRecoveryInput("A".repeat(55)))).toBe(false);
  });
});

describe("app lock", () => {
  it("formats the wait after wrong PINs", () => {
    expect(formatWait(0)).toBe("0:00");
    expect(formatWait(4.2)).toBe("0:05");
    expect(formatWait(125)).toBe("2:05");
  });

  it("checks a new PIN", () => {
    expect(pinProblem("123", "123")).toBe("short");
    expect(pinProblem("1234", "1235")).toBe("mismatch");
    expect(pinProblem("1234", "1234")).toBeNull();
    expect(pinProblem("x".repeat(65), "x".repeat(65))).toBe("long");
  });

  it("recognizes the rejection while locked", () => {
    expect(isLockedError("app-locked")).toBe(true);
    expect(isLockedError(new Error("other"))).toBe(false);
  });
});

// q124 R2D-6: a command refused while locked never settled. A chat save on its way when the lock
// came stopped every later save queued behind it, so no answer was saved for the rest of the
// session. Now it is sent again once the app is unlocked.
describe("commands refused while locked", () => {
  const fake = () => {
    let locked = true;
    let unlock = () => {};
    const unlocked = () => new Promise<void>((r) => (unlock = () => ((locked = false), r())));
    const ran: string[] = [];
    const send = <R,>(cmd: string): Promise<R> => (locked ? Promise.reject("app-locked") : (ran.push(cmd), Promise.resolve(cmd as R)));
    return { send, unlocked, ran, unlock: () => unlock() };
  };

  it("run once after the unlock, in their order", async () => {
    const f = fake();
    let chain: Promise<unknown> = Promise.resolve();
    const results: unknown[] = [];
    for (const cmd of ["chat_append", "chat_append_2"]) chain = chain.then(() => callUnlocked(cmd, {}, f.send, f.unlocked)).then((r) => results.push(r));
    await new Promise((r) => setTimeout(r, 5));
    expect(f.ran).toEqual([]);
    f.unlock();
    await chain;
    expect(f.ran).toEqual(["chat_append", "chat_append_2"]);
    expect(results).toEqual(["chat_append", "chat_append_2"]);
  });

  it("pass other errors on at once", async () => {
    const send = <R,>(): Promise<R> => Promise.reject("Seite nicht gefunden");
    await expect(callUnlocked("page_get", {}, send, () => new Promise(() => {}))).rejects.toBe("Seite nicht gefunden");
  });
});

