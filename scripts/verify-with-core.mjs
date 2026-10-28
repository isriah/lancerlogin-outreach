#!/usr/bin/env node
// Verify this plugin commit composed into a pinned LancerLogin Core checkout.
//
//   node scripts/verify-with-core.mjs core-pin                         print the pinned Core repository, commit and tag
//   node scripts/verify-with-core.mjs --core <dir> [--mode acceptance|fast]
//
// The Core commit is pinned in .github/plugin-release.json as a full commit SHA; the release tag beside it is recorded
// for people. Verification runs Core's module gate for this plugin (npm run verify:module -- <mode> <module id>) with
// LANCERLOGIN_<NAME>_PLUGIN_SOURCE/COMMIT pointing at this exact commit, so Core's tests, browser specs, typechecks and
// builds use it instead of the commit Core pins. Plugin tests never skip here: LANCERLOGIN_REQUIRE_*_PLUGIN is set.
//
// Core's tests also compose the other plugins Core pins (scripts/official-modules.json and tests/fixtures/*.modules.json).
// Those are public repositories, so when neither LANCERLOGIN_PLUGIN_TOKEN nor LANCERLOGIN_PLUGIN_CHECKOUTS is set, this
// script clones them anonymously into a temporary directory and points LANCERLOGIN_PLUGIN_CHECKOUTS at it. No token is
// needed. LANCERLOGIN_PLUGIN_TOKEN only matters if a pinned Core ever composes private plugin repositories.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseVersion } from "./release-policy.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function readConfig(root = pluginRoot) {
  const config = JSON.parse(readFileSync(join(root, ".github", "plugin-release.json"), "utf8"));
  if (!repositoryPattern.test(config.repository ?? "") || typeof config.title !== "string" || !config.title.trim()) throw new Error(".github/plugin-release.json needs repository and title");
  if (!repositoryPattern.test(config.core?.repository ?? "") || !commitPattern.test(config.core?.commit ?? "")) throw new Error(".github/plugin-release.json core must name a repository and a full 40-character commit SHA");
  if (config.core.tag !== undefined && (typeof config.core.tag !== "string" || !/^v[0-9A-Za-z.-]+$/.test(config.core.tag))) throw new Error(".github/plugin-release.json core.tag must be a v-prefixed release tag when present");
  return config;
}

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

/** The GitHub plugin repositories Core's tests may compose, other than this plugin's own repository. */
export function corePluginRepositories(coreRoot, ownRepository) {
  const files = [join(coreRoot, "scripts", "official-modules.json")];
  const fixtures = join(coreRoot, "tests", "fixtures");
  if (existsSync(fixtures)) files.push(...readdirSync(fixtures).filter((name) => name.endsWith(".modules.json")).map((name) => join(fixtures, name)));
  const repositories = new Map();
  for (const file of files.filter((path) => existsSync(path))) {
    for (const module of JSON.parse(readFileSync(file, "utf8")).modules ?? []) {
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(module.source ?? "");
      if (!match || match[1].toLowerCase() === ownRepository.toLowerCase()) continue;
      repositories.set(match[1], `https://github.com/${match[1]}.git`);
    }
  }
  return repositories;
}

/** Clone the public plugin repositories Core pins, without credentials, for Core's local-checkout lookup. */
function preparePluginCheckouts(coreRoot, ownRepository) {
  const repositories = corePluginRepositories(coreRoot, ownRepository);
  if (!repositories.size) return;
  const directory = mkdtempSync(join(tmpdir(), "lancerlogin-plugin-checkouts-"));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  for (const [repository, url] of repositories) {
    console.log(`Cloning public plugin repository ${repository} for Core's tests`);
    const result = spawnSync("git", ["clone", "--quiet", "--no-checkout", url, join(directory, repository.split("/")[1])], { env, encoding: "utf8" });
    if (result.status !== 0) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`Unable to clone ${url} without credentials: ${result.stderr.trim()}. If the pinned Core composes a private plugin repository, set LANCERLOGIN_PLUGIN_TOKEN to a token with read access to it.`);
    }
  }
  return directory;
}

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
  const pinned = `${config.core.commit}${config.core.tag ? ` (${config.core.tag})` : ""}`;
  if (coreCommit !== config.core.commit) {
    const message = `Core checkout is at ${coreCommit ?? "an unknown commit"}, not the pinned ${pinned}`;
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
  if (!env.LANCERLOGIN_PLUGIN_TOKEN) delete env.LANCERLOGIN_PLUGIN_TOKEN;
  const checkouts = env.LANCERLOGIN_PLUGIN_TOKEN || env.LANCERLOGIN_PLUGIN_CHECKOUTS ? undefined : preparePluginCheckouts(coreRoot, config.repository);
  if (checkouts) env.LANCERLOGIN_PLUGIN_CHECKOUTS = checkouts;
  console.log(`Verifying ${moduleId} ${pkg.version} at ${commit} against Core ${config.core.repository} ${coreCommit === config.core.commit ? pinned : coreCommit ?? "(unknown)"} (${mode})`);
  try {
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "verify:module", "--", mode, moduleId], { cwd: coreRoot, env, stdio: "inherit", shell: process.platform === "win32" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Core's ${mode} module gate failed for ${moduleId}`);
  } finally {
    if (checkouts) rmSync(checkouts, { recursive: true, force: true });
  }
  console.log(`${moduleId} ${commit} passed Core's ${mode} module gate.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "core-pin" && args.length === 1) {
      const { core } = readConfig();
      console.log(`repository=${core.repository}`); console.log(`commit=${core.commit}`); console.log(`tag=${core.tag ?? ""}`);
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
