import { describe, expect, it } from "vitest";
import { splitOwn } from "./MailGroup";

describe("own addresses", () => {
  it("splits addresses and names, keeping „Last, First“ together", () => {
    expect(splitOwn("ich@firma.de, Müller, Anna; Anna Müller\nich@firma.de")).toEqual(["ich@firma.de", "Müller, Anna", "Anna Müller"]);
    expect(splitOwn(" , ")).toEqual([]);
  });
});
