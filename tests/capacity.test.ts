import { describe, it, expect } from "vitest";
import app from "../worker/index";
import type { Env } from "../worker/types";
import { validateAvatar } from "../worker/avatar";
describe("Capacity failures", () => {
  it.each([
    "D1_ERROR: daily read quota exceeded",
    "D1_ERROR: database or disk is full",
    "D1_ERROR: daily write quota exceeded",
  ])("returns a safe retry response for %s", async (message) => {
    const env = {
      DB: {
        prepare() {
          throw new Error(message);
        },
      },
      APP_ORIGIN: "https://edating.soccera.uk",
    } as unknown as Env;
    const response = await app.fetch(
      new Request("https://edating.soccera.uk/api/v1/me", {
        headers: { Cookie: "__Host-ed-session=test" },
      }),
      env,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    const text = await response.text();
    expect(text).toContain("draft is safe");
    expect(text).not.toContain("D1_ERROR");
  });
  it("bounds avatar header parsing work for malicious 512 KB input", () => {
    const png = new Uint8Array(524288);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    view.setUint32(8, 13);
    png.set([73, 72, 68, 82], 12);
    view.setUint32(16, 1);
    view.setUint32(20, 1);
    const start = performance.now();
    expect(() => validateAvatar(png, "image/png")).toThrow(
      "fewer metadata chunks",
    );
    expect(performance.now() - start).toBeLessThan(10);
  });
});
