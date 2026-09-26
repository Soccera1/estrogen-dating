import { execFileSync } from "node:child_process";
import { cfBin } from "./cf-bin.mjs";
import { checkDeployment } from "./check-deployment.mjs";
const { env } = checkDeployment();
execFileSync("python3", ["scripts/migrate.py"], {
  stdio: "inherit",
  env: { ...env, CF_BIN: cfBin },
});
