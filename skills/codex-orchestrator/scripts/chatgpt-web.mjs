#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const C2C_COMMIT = "d6d0dd4e866fd9253572fcf84d8414132838d6f9";
const C2C_REPO = "https://github.com/XiaoDuoYa/codex-with-chatgpt.git";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const patchFile = path.join(scriptDir, "c2c-advice.patch");
const standardCheckout = path.join(os.homedir(), ".codex", "vendor", "codex-with-chatgpt");

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function takeArgs(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name.startsWith("--")) die(`Unexpected argument: ${name}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) die(`Missing value for ${name}`);
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

function run(program, args, options = {}) {
  const child = spawnSync(program, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    cwd: options.cwd,
    env: process.env,
  });
  if (child.error) die(`${program}: ${child.error.message}`);
  if (child.status !== 0) process.exit(child.status ?? 1);
  return child.stdout ?? "";
}

function c2cFile(checkout) {
  const file = path.join(checkout, "bin", "c2c.js");
  if (!fs.existsSync(file)) die(`C2C checkout is not ready: ${checkout}`);
  return file;
}

function commandExists(name) {
  return spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
}

function runPnpm(args, cwd) {
  if (commandExists("npm")) {
    run("npm", ["exec", "--yes", "--package=pnpm@11.24.0", "--", "pnpm", ...args], { cwd });
    return;
  }
  if (!commandExists("pnpm")) die("npm or pnpm is required");
  run("pnpm", args, { cwd });
}

const [action, ...rest] = process.argv.slice(2);
const options = takeArgs(rest);
const checkout = options.checkout ?? process.env.CODEX_ORCHESTRATOR_C2C_HOME ?? standardCheckout;

if (action === "check") {
  const report = {
    ok: false,
    checkout,
    node: Number.parseInt(process.versions.node, 10) >= 20,
    cloudflared: commandExists("cloudflared"),
    c2c: fs.existsSync(path.join(checkout, "bin", "c2c.js")),
    advice: false,
  };
  if (report.c2c) {
    const probe = spawnSync(process.execPath, [c2cFile(checkout), "advice", "--help"], {
      encoding: "utf8",
    });
    report.advice = probe.status === 0;
  }
  report.ok = report.node && report.cloudflared && report.c2c && report.advice;
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (action === "install") {
  if (fs.existsSync(checkout)) die(`Install target already exists: ${checkout}`);
  if (!commandExists("git")) die("git is required");
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  run("git", ["clone", C2C_REPO, checkout]);
  run("git", ["checkout", "--detach", C2C_COMMIT], { cwd: checkout });
  run("git", ["apply", patchFile], { cwd: checkout });
  runPnpm(["install", "--frozen-lockfile"], checkout);
  runPnpm(["build"], checkout);
  process.stdout.write(`${JSON.stringify({ ok: true, checkout, commit: C2C_COMMIT })}\n`);
  process.exit(0);
}

if (action === "wait") {
  for (const name of ["workspace", "task", "kind"]) {
    if (!options[name]) die(`Missing --${name}`);
  }
  if (options.kind !== "plan" && options.kind !== "review") die("kind must be plan or review");
  const args = [
    c2cFile(checkout),
    "advice",
    "wait",
    "--workspace",
    options.workspace,
    "--task",
    options.task,
    "--kind",
    options.kind,
    "--json",
  ];
  if (options.timeout) args.push("--timeout", options.timeout);
  const child = spawnSync(process.execPath, args, {
    encoding: "utf8",
    stdio: options.output ? "pipe" : "inherit",
    env: process.env,
  });
  if (child.error) die(child.error.message);
  if (options.output && child.status === 0) {
    process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    const result = JSON.parse(child.stdout);
    const content = result?.advice?.content;
    if (typeof content !== "string" || !content.trim()) die("C2C returned no advice content");
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${content.trim()}\n`, { mode: 0o600 });
  }
  process.exit(child.status ?? 1);
}

die("Usage: chatgpt-web.mjs check|install|wait [options]");
