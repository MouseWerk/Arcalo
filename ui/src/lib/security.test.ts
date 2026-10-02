import { describe, expect, it } from "vitest";
import { formatRecoveryInput, formatWait, isLockedError, pinProblem, recoveryComplete } from "./security";

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
