import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateDeployment } from "../scripts/deployment-config.mjs";
const template = () => JSON.parse(readFileSync("deployment.json", "utf8"));
const account = "b".repeat(32);
const database = "12345678-1234-1234-1234-123456789abc";
async function configure(answers, initial = template()) {
  const directory = mkdtempSync(join(tmpdir(), "dating-configure-"));
  const target = join(directory, "instance.json");
  try {
    writeFileSync(target, JSON.stringify(initial));
    const completed = spawnSync("python3", [resolve("scripts/configure.py")], {
      input: answers.join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, DEPLOYMENT_CONFIG: target },
    });
    expect(completed.stderr).toBe("");
    expect(completed.status).toBe(0);
    const result = JSON.parse(readFileSync(target, "utf8"));
    // Verify the Python output against the production deployment validator.
    expect(() => validateDeployment(result)).not.toThrow();
    return { result, messages: [completed.stdout] };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
describe("interactive deployment setup", () => {
  it("derives workers.dev routing, retries invalid input, and defaults to free", async () => {
    const original = template();
    const { result, messages } = await configure(
      [
        "bad",
        account,
        "my-dating",
        "",
        "",
        database,
        "",
        "my-account",
        "",
        "my-client",
      ],
      original,
    );
    expect(result.billingMode).toBe("free");
    expect(result.worker.env.APP_ORIGIN.value).toBe(
      "https://my-dating.my-account.workers.dev",
    );
    expect(result.worker.workersDev).toBe(true);
    expect(result.worker.domains).toEqual([]);
    expect(messages.join("\n")).toContain(
      "https://my-dating.my-account.workers.dev/auth/callback",
    );
    expect(original).toEqual(template());
  });
  it("supports custom domains, paid opt-in and retaining existing settings", async () => {
    const { result } = await configure([
      account,
      "",
      "paid",
      "my-db",
      database,
      "custom",
      "https://wrong.example",
      "dating.example.com",
      "",
      "client",
    ]);
    expect(result.billingMode).toBe("paid");
    expect(result.worker.domains).toEqual(["dating.example.com"]);
    expect(result.worker.workersDev).toBe(false);
    const rerun = await configure(Array(9).fill(""), result);
    expect(rerun.result).toEqual(result);
  });
  it("protects the shared template", () => {
    const before = readFileSync("deployment.json", "utf8");
    const completed = spawnSync("python3", [resolve("scripts/configure.py")], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, DEPLOYMENT_CONFIG: resolve("deployment.json") },
    });
    expect(completed.status).toBe(1);
    expect(completed.stderr).toContain("shared template");
    expect(readFileSync("deployment.json", "utf8")).toBe(before);
  });
  it("writes the selected file and leaves it untouched on premature EOF", () => {
    const directory = mkdtempSync(join(tmpdir(), "dating-configure-"));
    const target = join(directory, "instance.json");
    const run = (input) =>
      spawnSync("python3", [resolve("scripts/configure.py")], {
        input,
        encoding: "utf8",
        env: { ...process.env, DEPLOYMENT_CONFIG: target },
      });
    try {
      const completed = run(
        [
          account,
          "",
          "",
          "",
          database,
          "",
          "my-account",
          "",
          "client",
          "",
        ].join("\n"),
      );
      expect(completed.stderr).toBe("");
      expect(completed.status).toBe(0);
      const saved = readFileSync(target, "utf8");
      expect(JSON.parse(saved).worker.env.APP_ORIGIN.value).toBe(
        "https://estrogen-dating.my-account.workers.dev",
      );
      const cancelled = run("\n");
      expect(cancelled.status).toBe(1);
      expect(cancelled.stderr).toContain("no configuration was written");
      expect(readFileSync(target, "utf8")).toBe(saved);
      writeFileSync(target, "invalid JSON");
      expect(run("").status).toBe(1);
      expect(readFileSync(target, "utf8")).toBe("invalid JSON");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
