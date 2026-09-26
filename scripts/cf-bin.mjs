import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const installed = join(homedir(), ".npm-global/bin/cf");
export const cfBin =
  process.env.CF_BIN || (existsSync(installed) ? installed : "cf");
