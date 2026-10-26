#!/usr/bin/env node
// Verify this plugin commit composed into a pinned LancerLogin Core checkout.
//
//   node scripts/verify-with-core.mjs core-pin                         print the pinned Core repository and commit
//   node scripts/verify-with-core.mjs --core <dir> [--mode acceptance|fast]
//
// The Core commit is pinned in .github/plugin-release.json. Verification runs Core's module gate for this plugin
// (npm run verify:module -- <mode> <module id>) with LANCERLOGIN_<NAME>_PLUGIN_SOURCE/COMMIT pointing at this exact
// commit, so Core's tests, browser specs, typechecks and builds use it instead of the commit Core pins. Plugin tests never
// skip here: LANCERLOGIN_REQUIRE_*_PLUGIN is set. Core's official modules (Outreach) are fetched with
// LANCERLOGIN_PLUGIN_TOKEN when they are private.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseVersion } from "./release-policy.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitPattern = /^[0-9a-f]{40}$/;

export function readConfig(root = pluginRoot) {
  const config = JSON.parse(readFileSync(join(root, ".github", "plugin-release.json"), "utf8"));
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository ?? "") || typeof config.title !== "string" || !config.title.trim()) throw new Error(".github/plugin-release.json needs repository and title");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.core?.repository ?? "") || !commitPattern.test(config.core?.commit ?? "")) throw new Error(".github/plugin-release.json core must name a repository and a full 40-character commit SHA");
  return config;
}

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

function verify({ core, mode }) {
  const config = readConfig();
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  const moduleId = pkg.lancerlogin?.moduleId;
  if (typeof moduleId !== "string" || !/^[a-z][a-z0-9-]*$/.test(moduleId)) throw new Error("package.json lancerlogin.moduleId is missing");
  if (!parseVersion(pkg.version)) throw new Error(`package.json version ${pkg.version} must be X.Y.Z or X.Y.Z-beta.N`);
  const coreRoot = resolve(core);
  if (!existsSync(join(coreRoot, "scripts", "run-module-tests.mjs")) || !existsSync(join(coreRoot, "module-tests", `${moduleId}.json`))) throw new Error(`${coreRoot} is not a LancerLogin Core checkout with a module gate for ${moduleId}`);
  const commit = git(pluginRoot, "rev-parse", "HEAD");
  if (git(pluginRoot, "status", "--porcelain", "--untracked-files=no")) throw new Error("Commit or discard changes first: verification composes the committed plugin, not the working tree");
  const coreCommit = existsSync(join(coreRoot, ".git")) ? git(coreRoot, "rev-parse", "HEAD") : undefined;
  if (coreCommit !== config.core.commit) {
    const message = `Core checkout is at ${coreCommit ?? "an unknown commit"}, not the pinned ${config.core.commit}`;
    if (process.env.CI) throw new Error(message);
    console.warn(`Warning: ${message}. Results apply to that Core commit only.`);
  }
  const name = moduleId === "hour-tracking" ? "OUTREACH" : moduleId.toUpperCase().replaceAll("-", "_");
  const env = {
    ...process.env,
    [`LANCERLOGIN_${name}_PLUGIN_SOURCE`]: pathToFileURL(pluginRoot).href,
    [`LANCERLOGIN_${name}_PLUGIN_COMMIT`]: commit,
    LANCERLOGIN_REQUIRE_OUTREACH_PLUGIN: "1",
    LANCERLOGIN_REQUIRE_CARPOOL_PLUGIN: "1",
  };
  console.log(`Verifying ${moduleId} ${pkg.version} at ${commit} against Core ${config.core.repository} ${coreCommit ?? "(unknown)"} (${mode})`);
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "verify:module", "--", mode, moduleId], { cwd: coreRoot, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Core's ${mode} module gate failed for ${moduleId}`);
  console.log(`${moduleId} ${commit} passed Core's ${mode} module gate.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "core-pin" && args.length === 1) {
      const { core } = readConfig();
      console.log(`repository=${core.repository}`); console.log(`commit=${core.commit}`);
    } else {
      const options = { mode: "acceptance" };
      for (let index = 0; index < args.length; index++) {
        const value = () => { const next = args[++index]; if (!next) throw new Error(`${args[index - 1]} needs a value`); return next; };
        if (args[index] === "--core") options.core = value();
        else if (args[index] === "--mode") options.mode = value();
        else throw new Error(`Unknown argument ${args[index]}`);
      }
      if (!options.core || !["acceptance", "fast"].includes(options.mode)) throw new Error("Usage: node scripts/verify-with-core.mjs core-pin | --core <dir> [--mode acceptance|fast]");
      verify(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
