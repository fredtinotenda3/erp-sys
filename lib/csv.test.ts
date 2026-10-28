import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(toCsv(["a", "b"], [['x,"y"', "line1\nline2"]])).toBe('a,b\r\n"x,""y""","line1\nline2"\r\n');
  });
  it("neutralises spreadsheet formulas but leaves plain negative numbers alone", () => {
    const out = toCsv(["v"], [["=SUM(A1)"], ["+1+1"], ["@cmd"], ["-5.25"], ["-abc"]]);
    expect(out).toContain("'=SUM(A1)");
    expect(out).toContain("'+1+1");
    expect(out).toContain("'@cmd");
    expect(out).toContain("\r\n-5.25\r\n");
    expect(out).toContain("'-abc");
  });
  it("writes null/undefined as empty cells", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,\r\n");
  });
});
