import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

// Other dist modules share this boundary, including tests in the installed VSIX.
const result = await build({
  entryPoints: ["src/model-client.ts"],
  outfile: "dist/model-client.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  metafile: true,
});
const packages = new Set(
  Object.keys(result.metafile.inputs).flatMap((path) => {
    const match = path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    return match ? [match[1]] : [];
  }),
);
const notices = await Promise.all(
  [...packages].sort().map(async (name) => {
    const root = `node_modules/${name}`;
    const { version } = JSON.parse(
      await readFile(`${root}/package.json`, "utf8"),
    );
    // The npm tarball omits LICENSE; the vendored copy is from its gitHead:
    // standard-webhooks/standard-webhooks@b4d2c14fc5b4ccff3ff271e3b087dff812254c59/LICENSE.
    const licensePath =
      name === "standardwebhooks"
        ? `licenses/${name}-${version}.txt`
        : `${root}/LICENSE`;
    const license = await readFile(licensePath, "utf8");
    return `${name}@${version}\n\n${license}`;
  }),
);
await writeFile("dist/THIRD_PARTY_NOTICES.txt", notices.join("\n\n---\n\n"));
