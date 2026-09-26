import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { cfBin } from "./cf-bin.mjs";
import {
  loadDeployment,
  validateDeployment,
  validateSubscriptions,
  deploymentEnv,
} from "./deployment-config.mjs";

export function checkDeployment({ forceFree = false } = {}) {
  const config = loadDeployment();
  const mode = validateDeployment(config, { forceFree });
  const env = deploymentEnv(config);
  if (mode === "free") {
    validateSubscriptions(
      JSON.parse(
        execFileSync(cfBin, ["accounts", "subscriptions", "get"], {
          encoding: "utf8",
          env,
        }),
      ),
    );
    console.log(
      "Verified free-only deployment: no paid subscriptions; D1 and static assets only.",
    );
  } else {
    console.log(
      "Paid hosting explicitly enabled: Cloudflare usage may incur charges. No subscription is created or upgraded by this script.",
    );
  }
  return { config, env };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  checkDeployment();
