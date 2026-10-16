import { describe, it, expect } from "vitest";
import { authFailedOn, type OnboardingState } from "./onboarding";

const NODE = "http://localhost:37093";

function state(overrides: Partial<OnboardingState>): OnboardingState {
  return { nodeUrl: NODE, authAvailable: false, providersAvailable: false, hasConfiguredProviders: false, ...overrides };
}

describe("authFailedOn", () => {
  it("reports a failed probe of the node in use", () => {
    expect(authFailedOn(state({}), NODE)).toBe(true);
    expect(authFailedOn(state({ authAvailable: true }), NODE)).toBe(true);
  });

  it("ignores a probe of another node, like the default port probed before onboarding created this one", () => {
    expect(authFailedOn(state({ nodeUrl: "http://localhost:2528" }), NODE)).toBe(false);
  });

  it("ignores the default URLs, which first launch probes before any node exists", () => {
    expect(authFailedOn(state({ nodeUrl: "http://localhost:2528" }), "http://localhost:2528")).toBe(false);
    expect(authFailedOn(state({ nodeUrl: "http://localhost:8080" }), "http://localhost:8080")).toBe(false);
  });

  it("passes a node whose auth and providers are up", () => {
    expect(authFailedOn(state({ authAvailable: true, providersAvailable: true }), NODE)).toBe(false);
  });
});
