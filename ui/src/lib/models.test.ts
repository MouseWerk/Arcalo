import { describe, expect, it } from "vitest";
import { autoAssign } from "./models";
import type { RouterConfig } from "./types";

const router = { local_model: "ollama/llama3.2", standard_model: "cloud-standard", reasoning_model: "cloud-reasoning" } as RouterConfig;

describe("autoAssign", () => {
  it("maps placeholder tiers to server models by name", () => {
    expect(autoAssign(router, ["azure-gpt-4o", "gpt-4o-mini", "o3-reasoning", "text-embedding-3"])).toEqual({
      standard_model: "azure-gpt-4o",
      local_model: "gpt-4o-mini",
      reasoning_model: "o3-reasoning",
    });
  });
  it("keeps tiers the server has and never picks an embedding model", () => {
    const ok = { ...router, standard_model: "firma" };
    expect(autoAssign(ok, ["firma", "firma-embed"])).toEqual({ standard_model: "firma", local_model: "firma", reasoning_model: "firma" });
  });
});
