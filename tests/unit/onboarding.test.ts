import { describe, expect, it } from "vitest";
import { resolveOnboardingState } from "../../src/shared/onboarding";

describe("resolveOnboardingState", () => {
  it("requires the guide for a new empty profile without a marker", () => {
    expect(resolveOnboardingState(undefined, false)).toEqual({
      required: true,
      completed: false,
    });
  });

  it("keeps the guide required when an incomplete marker is present", () => {
    expect(resolveOnboardingState(false, false)).toEqual({
      required: true,
      completed: false,
    });
  });

  it("does not interrupt an existing profile during an upgrade", () => {
    expect(resolveOnboardingState(undefined, true)).toEqual({
      required: false,
      completed: true,
    });
  });

  it("honors a completed marker even if the profile is later empty", () => {
    expect(resolveOnboardingState(true, false)).toEqual({
      required: false,
      completed: true,
    });
  });
});
