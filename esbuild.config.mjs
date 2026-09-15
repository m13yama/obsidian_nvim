import esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv.includes("production");
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
