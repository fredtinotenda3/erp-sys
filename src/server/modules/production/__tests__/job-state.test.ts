import { describe, it, expect } from "vitest";
import { allowedTransitions, canTransition, acceptsWork, JOB_STATUS_VALUES } from "../job-state";

describe("job state machine (pure)", () => {
  it("planned can only be released or cancelled", () => {
    expect(allowedTransitions("planned", false).sort()).toEqual(["cancelled", "released"]);
  });
  it("in_progress cannot be cancelled (material may be consumed)", () => {
    expect(canTransition("in_progress", "cancelled", true)).toBe(false);
    expect(allowedTransitions("in_progress", true).sort()).toEqual(["completed", "on_hold"]);
  });
  it("on_hold returns to where the job came from", () => {
    expect(allowedTransitions("on_hold", false)).toEqual(["released"]);
    expect(allowedTransitions("on_hold", true)).toEqual(["in_progress"]);
  });
  it("completed can only be closed; closed and cancelled are terminal", () => {
    expect(allowedTransitions("completed", true)).toEqual(["closed"]);
    expect(allowedTransitions("closed", true)).toEqual([]);
    expect(allowedTransitions("cancelled", false)).toEqual([]);
  });
  it("cannot skip stages", () => {
    expect(canTransition("planned", "in_progress", false)).toBe(false);
    expect(canTransition("planned", "completed", false)).toBe(false);
    expect(canTransition("released", "completed", false)).toBe(false);
  });
  it("only released and in_progress jobs accept work", () => {
    const accepting = JOB_STATUS_VALUES.filter(acceptsWork);
    expect(accepting.sort()).toEqual(["in_progress", "released"]);
  });
});
