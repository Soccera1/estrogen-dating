import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
// Deployment scripts are JavaScript so they can run before dependencies/builds.
import {
  validateDeployment,
  validateSubscriptions,
  deploymentEnv,
} from "../scripts/deployment-config.mjs";
function config() {
  const c = JSON.parse(readFileSync("deployment.json", "utf8"));
  c.accountId = "a".repeat(32);
  c.worker.name = "another-instance";
  c.worker.env.DB.name = "another-database";
  c.worker.env.DB.id = "12345678-1234-1234-1234-123456789abc";
  c.worker.env.APP_ORIGIN.value =
    "https://another-instance.example.workers.dev";
  c.worker.env.HRTID_CLIENT_ID.value = "independent-client";
  return c;
}
describe("portable deployment policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("accepts independently named resources and defaults to free", () => {
    const c = config();
    // Deploy passes the real account to subprocesses; this fixture uses its own.
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", undefined);
    delete c.billingMode;
    expect(validateDeployment(c)).toBe("free");
    expect(deploymentEnv(c).CLOUDFLARE_ACCOUNT_ID).toBe(c.accountId);
  });
  it("accepts a matching account environment and rejects a different account", () => {
    const c = config();
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", c.accountId);
    expect(deploymentEnv(c).CLOUDFLARE_ACCOUNT_ID).toBe(c.accountId);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "b".repeat(32));
    expect(() => deploymentEnv(c)).toThrow(
      "CLOUDFLARE_ACCOUNT_ID does not match deployment accountId",
    );
  });
  it("requires complete hosting configuration and keeps the model key out of config", () => {
    const c = config();
    c.worker.env.AI_ENDPOINT = {
      type: "text",
      value: "https://model.example/v1/chat/completions",
    };
    expect(() => validateDeployment(c)).toThrow();
    c.worker.env.AI_MODEL = { type: "text", value: "model" };
    c.worker.env.AI_API_KEY = { type: "secret" };
    expect(validateDeployment(c)).toBe("free");
    c.worker.env.AI_API_KEY.value = "do-not-store";
    expect(() => validateDeployment(c)).toThrow("secret binding");
    delete c.worker.env.AI_API_KEY.value;
    for (const value of [
      "http://model.example",
      "https://key@model.example",
      "https://model.example?key=secret",
    ]) {
      c.worker.env.AI_ENDPOINT.value = value;
      expect(() => validateDeployment(c)).toThrow("AI_ENDPOINT");
    }
  });
  it("supports custom domains", () => {
    const c = config();
    c.worker.domains = ["dating.example.com"];
    c.worker.workersDev = false;
    c.worker.env.APP_ORIGIN.value = "https://dating.example.com";
    expect(validateDeployment(c)).toBe("free");
  });
  it("requires explicit paid opt-in and preserves strict free checks", () => {
    const c = config();
    c.billingMode = "paid";
    expect(validateDeployment(c)).toBe("paid");
    expect(() => validateDeployment(c, { forceFree: true })).toThrow();
    c.billingMode = "paidd";
    expect(() => validateDeployment(c)).toThrow();
  });
  it("rejects placeholders, origin mismatches and extra resources even when paid", () => {
    expect(() =>
      validateDeployment(JSON.parse(readFileSync("deployment.json", "utf8"))),
    ).toThrow();
    const c = config();
    c.worker.env.APP_ORIGIN.value += "/";
    expect(() => validateDeployment(c)).toThrow();
    c.worker.env.APP_ORIGIN.value = "https://wrong.example.com";
    expect(() => validateDeployment(c)).toThrow();
    const paid = config();
    paid.billingMode = "paid";
    paid.worker.env.AI = { type: "ai" };
    expect(() => validateDeployment(paid)).toThrow();
  });
  it("fails closed on paid, unknown or malformed subscription responses", () => {
    expect(() => validateSubscriptions([])).not.toThrow();
    expect(() =>
      validateSubscriptions([{ state: "Expired", price: 5 }]),
    ).not.toThrow();
    for (const response of [
      {},
      [null],
      [{}],
      [{ state: "Active", price: "unknown" }],
      [{ state: "Active", price: 5 }],
      [{ state: "Active", price: 0, name: "Workers Paid" }],
    ]) {
      expect(() => validateSubscriptions(response)).toThrow();
    }
  });
});
