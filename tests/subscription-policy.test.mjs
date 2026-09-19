import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills/codex-orchestrator/scripts");
const policy = path.join(scripts, "subscription-policy.sh");
const runtime = path.join(scripts, "lane-runtime.sh");

function route(...args) {
  return spawnSync(policy, ["route", ...args], { encoding: "utf8" });
}

function fields(output) {
  return Object.fromEntries(output.trim().split(/\s+/).map((entry) => entry.split("=")));
}

test("normal Claude availability keeps the preferred subscription worker", () => {
  const run = route("--role", "default", "--claude-status", "available");

  assert.equal(run.status, 0);
  assert.deepEqual(fields(run.stdout), {
    provider: "claude",
    model: "sonnet",
    role: "default",
    fallback: "false",
    reason: "preferred",
  });
});

test("Claude capacity failure permits an owner-authorized ChatGPT fallback", () => {
  const run = route(
    "--role",
    "default",
    "--claude-status",
    "capacity_unavailable",
    "--fallback-authorization",
    "owner",
    "--codex-auth",
    "chatgpt",
  );

  assert.equal(run.status, 0);
  assert.equal(fields(run.stdout).provider, "codex");
  assert.equal(fields(run.stdout).model, "gpt-5.6-sol");
  assert.equal(fields(run.stdout).reason, "capacity_unavailable");
});

test("missing fallback authorization fails closed", () => {
  const run = route(
    "--role",
    "default",
    "--claude-status",
    "monthly_spend_limit",
    "--codex-auth",
    "chatgpt",
  );

  assert.equal(run.status, 78);
  assert.match(run.stderr, /fallback_not_authorized/);
});

test("an attempted API-key fallback is rejected", () => {
  const run = route(
    "--role",
    "default",
    "--claude-status",
    "authentication_failure",
    "--fallback-authorization",
    "accepted-plan",
    "--codex-auth",
    "api-key",
  );

  assert.equal(run.status, 78);
  assert.match(run.stderr, /api_key_fallback_forbidden/);
});

test("neither subscription path available fails closed", () => {
  const run = route(
    "--role",
    "implementation",
    "--claude-status",
    "subscription_unavailable",
    "--fallback-authorization",
    "owner",
    "--codex-auth",
    "unavailable",
  );

  assert.equal(run.status, 78);
  assert.match(run.stderr, /no_subscription_worker_available/);
});

test("roles map to separate fixed provider models", () => {
  const claudeRead = route("--role", "default", "--claude-status", "available");
  const claudeWrite = route("--role", "implementation", "--claude-status", "available");
  const codexRead = route(
    "--role",
    "default",
    "--claude-status",
    "capacity_unavailable",
    "--fallback-authorization",
    "owner",
    "--codex-auth",
    "chatgpt",
  );
  const codexWrite = route(
    "--role",
    "implementation",
    "--claude-status",
    "monthly_spend_limit",
    "--fallback-authorization",
    "accepted-plan",
    "--codex-auth",
    "chatgpt",
  );

  assert.equal(fields(claudeRead.stdout).model, "sonnet");
  assert.equal(fields(claudeWrite.stdout).model, "opus");
  assert.equal(fields(codexRead.stdout).model, "gpt-5.6-sol");
  assert.equal(fields(codexWrite.stdout).model, "gpt-6-astra");
  assert.notEqual(fields(codexRead.stdout).model, fields(codexWrite.stdout).model);
});

test("runtime accepts only the fixed subscription launch contracts", () => {
  const claude = spawnSync(
    runtime,
    [
      "check-launch",
      "--lane",
      "claude",
      "--mode",
      "read",
      "--model-label",
      "sonnet / Claude Max / preferred",
      "--",
      "node",
      "adapter.mjs",
      "--",
      "/home/vscode/.local/bin/claude-subscription-worker",
      "--role",
      "default",
    ],
    { encoding: "utf8" },
  );
  const codex = spawnSync(
    runtime,
    [
      "check-launch",
      "--lane",
      "codex-subscription-fallback",
      "--mode",
      "write",
      "--model-label",
      "gpt-6-astra / ChatGPT subscription / fallback:monthly_spend_limit",
      "--",
      "node",
      "adapter.mjs",
      "--",
      "/home/vscode/.local/bin/codex-subscription-worker",
      "--role",
      "implementation",
      "--fallback-authorization",
      "accepted-plan",
      "--fallback-reason",
      "monthly_spend_limit",
    ],
    { encoding: "utf8" },
  );
  const rawCodex = spawnSync(
    runtime,
    [
      "check-launch",
      "--lane",
      "codex-subscription-fallback",
      "--mode",
      "read",
      "--model-label",
      "gpt-5.6-sol / ChatGPT subscription / fallback:capacity_unavailable",
      "--",
      "codex",
      "exec",
    ],
    { encoding: "utf8" },
  );

  assert.equal(claude.status, 0);
  assert.equal(codex.status, 0);
  assert.equal(rawCodex.status, 78);
  assert.match(rawCodex.stderr, /may not invoke the raw Codex executable/);
});

test("Codex launcher uses fresh ChatGPT-authenticated sessions and strips API credentials", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subscription-worker-"));
  const bin = path.join(temp, "bin");
  fs.mkdirSync(bin);
  const install = spawnSync(
    "sh",
    [path.join(scripts, "install-subscription-workers.sh"), "--target-dir", bin],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0);

  const fakeCodex = path.join(bin, "codex");
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/bin/sh",
      "if [ \"${1-}\" = login ] && [ \"${2-}\" = status ]; then",
      "  printf '%s\\n' 'Logged in using ChatGPT'",
      "  exit 0",
      "fi",
      "if [ -n \"${OPENAI_API_KEY-}\" ] || [ -n \"${CODEX_API_KEY-}\" ] || [ -n \"${CODEX_ACCESS_TOKEN-}\" ]; then",
      "  printf '%s\\n' 'api_credentials=present'",
      "else",
      "  printf '%s\\n' 'api_credentials=absent'",
      "fi",
      "printf 'arg=%s\\n' \"$@\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const launcher = path.join(bin, "codex-subscription-worker");
  const run = spawnSync(
    launcher,
    [
      "--role",
      "default",
      "--fallback-authorization",
      "owner",
      "--fallback-reason",
      "capacity_unavailable",
      "--json",
      "--sandbox",
      "read-only",
      "--cd",
      temp,
      "-",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        OPENAI_API_KEY: "test-only",
        CODEX_API_KEY: "test-only",
        CODEX_ACCESS_TOKEN: "test-only",
      },
    },
  );

  assert.equal(run.status, 0);
  assert.match(run.stdout, /api_credentials=absent/);
  assert.match(run.stdout, /arg=--ephemeral/);
  assert.match(run.stdout, /arg=--ignore-user-config/);
  assert.match(run.stdout, /arg=gpt-5\.6-sol/);
  assert.doesNotMatch(run.stdout, /arg=resume|arg=fork/);
});
