import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = path.join(
  root,
  "skills/codex-orchestrator/scripts/chatgpt-web.mjs",
);

test("wait delegates to the patched C2C advice command once", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-web-"));
  const checkout = path.join(temp, "c2c");
  const bin = path.join(checkout, "bin");
  const capture = path.join(temp, "args.json");
  const output = path.join(temp, "final.txt");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "c2c.js"),
    `import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ok:true,advice:{content:"Plan ready"}}));`,
  );

  const run = spawnSync(
    process.execPath,
    [
      command,
      "wait",
      "--checkout",
      checkout,
      "--workspace",
      temp,
      "--task",
      "task-1",
      "--kind",
      "plan",
      "--output",
      output,
    ],
    { encoding: "utf8", env: { ...process.env, CAPTURE: capture } },
  );

  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), [
    "advice",
    "wait",
    "--workspace",
    temp,
    "--task",
    "task-1",
    "--kind",
    "plan",
    "--json",
  ]);
  assert.match(run.stdout, /Plan ready/);
  assert.equal(fs.readFileSync(output, "utf8"), "Plan ready\n");
});

test("install uses pinned pnpm through npm when the direct launcher is unavailable", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-web-install-"));
  const bin = path.join(temp, "bin");
  const checkout = path.join(temp, "c2c");
  const capture = path.join(temp, "npm-args.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = --version ]; then echo git; exit 0; fi",
      "if [ \"$1\" = clone ]; then mkdir -p \"$3\"; fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "npm"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = --version ]; then echo npm; exit 0; fi",
      `printf '%s\\n' \"$*\" >> ${JSON.stringify(capture)}`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const run = spawnSync(
    process.execPath,
    [command, "install", "--checkout", checkout],
    { encoding: "utf8", env: { ...process.env, PATH: `${bin}:/bin:/usr/bin` } },
  );

  assert.equal(run.status, 0);
  const calls = fs.readFileSync(capture, "utf8");
  assert.match(calls, /--package=pnpm@11\.24\.0 -- pnpm install --frozen-lockfile/);
  assert.match(calls, /--package=pnpm@11\.24\.0 -- pnpm build/);
});
