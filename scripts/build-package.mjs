import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const externalPiPackages = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

await rm(distDir, { recursive: true, force: true });
await mkdir(path.join(distDir, "vendor"), { recursive: true });

await Promise.all([
  build({
    entryPoints: [path.join(rootDir, "extensions/pi-hapi-remote/index.ts")],
    outfile: path.join(distDir, "index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: externalPiPackages,
    minify: true,
    sourcemap: false,
    legalComments: "linked",
  }),
  build({
    entryPoints: [path.join(rootDir, "node_modules/tunnelmole/dist/bin/tunnelmole.js")],
    outfile: path.join(distDir, "vendor/tunnelmole.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    minify: true,
    sourcemap: false,
    legalComments: "linked",
  }),
]);

await cp(path.join(rootDir, "web/dist"), path.join(distDir, "web"), {
  recursive: true,
});
