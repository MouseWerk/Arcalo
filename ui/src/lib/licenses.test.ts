import { describe, expect, it } from "vitest";
import { copyrightLine, filterLibraries, licenseName } from "./licenses";

describe("licenses", () => {
  it("reads the name and copyright of the app's license", () => {
    const text = "MIT License\n\nCopyright (c) 2026 Mousewerk, Maurice Kleindienst\n\nPermission is hereby granted";
    expect(licenseName(text)).toBe("MIT");
    expect(licenseName("Apache License 2.0")).toBe("Apache License 2.0");
    expect(copyrightLine(text)).toBe("© 2026 Mousewerk, Maurice Kleindienst");
    expect(copyrightLine("Copyright (c) 2026 Someone")).toBe("© 2026 Someone");
    expect(copyrightLine("no line")).toBe("");
  });

  it("filters libraries by name or license, sorted", () => {
    const list = [
      { name: "zustand", version: "5.0.0", license: "MIT" },
      { name: "dompurify", version: "3.0.0", license: "(MPL-2.0 OR Apache-2.0)" },
      { name: "React", version: "19.0.0", license: "MIT" },
    ];
    expect(filterLibraries(list, "").map((l) => l.name)).toEqual(["dompurify", "React", "zustand"]);
    expect(filterLibraries(list, "react").map((l) => l.name)).toEqual(["React"]);
    expect(filterLibraries(list, "apache").map((l) => l.name)).toEqual(["dompurify"]);
    expect(filterLibraries(list, "  mit ").length).toBe(2);
  });
});
