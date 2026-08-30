// Helper used by webui-bundle-browser-load.node.test.ts to normalise
// a JS chunk through esbuild's parser from a Node child process. The
// helper exists because esbuild's parser relies on a TextEncoder
// invariant that jsdom (vitest's `unit-node` environment) breaks, so
// we shell out to a fresh Node process that has the full set of
// globals esbuild expects.
import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const src = readFileSync(process.argv[2], "utf8");
const result = esbuild.transformSync(src, {
  loader: "js",
  format: "esm",
  target: "esnext",
  treeShaking: false,
  minify: false,
  sourcefile: process.argv[3] || "src",
  legalComments: "none",
});
process.stdout.write(result.code);
