import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/max.js",
  banner: { js: "#!/usr/bin/env node" },
  target: "node20",
  logLevel: "info",
});
