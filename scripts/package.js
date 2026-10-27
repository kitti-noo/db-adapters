// Bump the patch version and build the .vsix. If the build fails, the version
// goes back to what it was, so failed builds don't use up version numbers.
// Extra arguments are passed to `vsce package`.
const { execFileSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
const setVersion = (v) => run(npm, ["version", v, "--no-git-tag-version", "--allow-same-version"]);

const current = require(path.join(root, "package.json")).version;
const [major, minor, patch] = current.split(".").map(Number);
const next = `${major}.${minor}.${patch + 1}`;

setVersion(next);
try {
  run(npm, ["exec", "--", "vsce", "package", "--allow-missing-repository", ...process.argv.slice(2)]);
} catch {
  console.error(`\nBuild failed: version reset to ${current}.`);
  setVersion(current);
  process.exit(1);
}
