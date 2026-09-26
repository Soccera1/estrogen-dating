import { execFileSync } from "node:child_process";
import { cfBin } from "./cf-bin.mjs";
const options = { stdio: "inherit", env: { ...process.env, CF_BIN: cfBin } };
for (const command of ["check:free", "test", "build"])
  execFileSync("npm", ["run", command], options);
execFileSync("python3", ["scripts/migrate.py"], options);
execFileSync(cfBin, ["deploy", "--prebuilt"], options);
