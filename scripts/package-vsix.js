const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const workspaceRoot = process.cwd();
const packageJsonPath = path.join(workspaceRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = packageJson.version;
const outputDir = path.join(workspaceRoot, "releases", "vsix");
const outputFile = path.join(outputDir, `codex-task-notify-${version}.vsix`);
const relativeOutputFile = path.join("releases", "vsix", `codex-task-notify-${version}.vsix`);

fs.mkdirSync(outputDir, { recursive: true });

const command = process.platform === "win32" ? "cmd.exe" : "npx";
const args = process.platform === "win32"
  ? [
      "/d",
      "/s",
      "/c",
      "npx @vscode/vsce package -o " + relativeOutputFile + " --allow-missing-repository --allow-unused-files-pattern"
    ]
  : [
  "@vscode/vsce",
  "package",
  "-o",
  outputFile,
  "--allow-missing-repository",
  "--allow-unused-files-pattern"
];

const result = spawnSync(command, args, {
  cwd: workspaceRoot,
  stdio: "inherit"
});

if (typeof result.status === "number" && result.status !== 0) {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}
