import { build } from "esbuild";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { loadDeployment } from "./deployment-config.mjs";
const config = loadDeployment();
const root = ".cloudflare/output/v0";
await rm(root, { recursive: true, force: true });
await mkdir(`${root}/workers/default/bundle`, { recursive: true });
await build({
  entryPoints: ["worker/index.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  outfile: `${root}/workers/default/bundle/index.js`,
  minify: true,
});
await mkdir("dist/worker", { recursive: true });
await cp(`${root}/workers/default/bundle/index.js`, "dist/worker/index.js");
await cp("dist/client", `${root}/workers/default/assets`, { recursive: true });
await writeFile(
  `${root}/config.json`,
  JSON.stringify(
    { accountId: config.accountId, buildContext: { isPreview: false } },
    null,
    2,
  ),
);
await writeFile(
  `${root}/workers/default/worker.config.json`,
  JSON.stringify(
    {
      ...config.worker,
      manifest: {
        type: "complete",
        mainModule: "index.js",
        modules: { "index.js": { type: "esm" } },
      },
    },
    null,
    2,
  ),
);
console.log("Built static assets and the D1-only Worker.");
