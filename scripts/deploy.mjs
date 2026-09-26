import { execFileSync } from "node:child_process";
import { cfBin } from "./cf-bin.mjs";
import { checkDeployment } from "./check-deployment.mjs";
const { env } = checkDeployment();
const options = { stdio: "inherit", env: { ...env, CF_BIN: cfBin } };
for (const command of ["test", "build"])
  execFileSync("npm", ["run", command], options);
execFileSync("python3", ["scripts/migrate.py"], options);
execFileSync(
  cfBin,
  ["deploy", "--prebuilt", ...process.argv.slice(2)],
  options,
);
