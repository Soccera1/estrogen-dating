import { describe, expect, it } from "vitest";
import { hostingAvailable } from "../worker/hosting";
import app from "../worker/index";
import type { Env } from "../worker/types";

describe("instance hosting availability", () => {
  it("defaults off and requires a complete secure configuration", async () => {
    const env = {} as Env;
    expect(hostingAvailable(env)).toBe(false);
    const status = await app.request("/api/v1/status", {}, env);
    expect(await status.json()).toMatchObject({ aiHostingAvailable: false });
    env.AI_ENDPOINT = "https://model.example/v1/chat/completions";
    env.AI_MODEL = "model";
    expect(hostingAvailable(env)).toBe(false);
    env.AI_API_KEY = "secret";
    expect(hostingAvailable(env)).toBe(true);
    const publicStatus = await (
      await app.request("/api/v1/status", {}, env)
    ).text();
    expect(publicStatus).not.toContain("secret");
    expect(publicStatus).not.toContain("model.example");
    for (const endpoint of [
      "http://model.example",
      "https://key@model.example",
      "https://model.example?key=secret",
      "invalid",
    ]) {
      env.AI_ENDPOINT = endpoint;
      expect(hostingAvailable(env)).toBe(false);
    }
  });
});
