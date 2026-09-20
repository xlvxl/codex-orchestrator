import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "skills/codex-orchestrator/scripts");
const launcher = path.join(scripts, "claude-subscription-worker");

const NODE_VERSION = "v20.11.1";

// A fake Claude that reports a valid Claude Max login for `auth status --json`
// and otherwise echoes whether provider credentials survived and its arguments.
const FAKE_CLAUDE_MAX = [
  "#!/bin/sh",
  'if [ "$1" = auth ] && [ "$2" = status ] && [ "$3" = --json ]; then',
  '  printf \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\\n\'',
  "  exit 0",
  "fi",
  'if [ -n "${ANTHROPIC_API_KEY-}" ] || [ -n "${OPENAI_API_KEY-}" ] || [ -n "${ANTHROPIC_MODEL-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN-}" ]; then',
  "  printf 'provider_credentials=present\\n'",
  "else",
  "  printf 'provider_credentials=absent\\n'",
  "fi",
  'printf \'arg=%s\\n\' "$@"',
  "",
].join("\n");

// A fake Claude that authenticates without a Claude Max subscription.
const FAKE_CLAUDE_NOT_MAX = [
  "#!/bin/sh",
  'if [ "$1" = auth ] && [ "$2" = status ] && [ "$3" = --json ]; then',
  '  printf \'{"loggedIn":false,"authMethod":"none","subscriptionType":"none"}\\n\'',
  "  exit 0",
  "fi",
  "printf 'unexpected-exec\\n'",
  "",
].join("\n");

function makeHome() {
  // realpath so the launcher's canonicalized (realpath) target shares the
  // $HOME-derived nvm-root prefix even when TMPDIR contains symlinks.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-sub-worker-")));
  const binDir = path.join(home, ".nvm/versions/node", NODE_VERSION, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const configDir = path.join(home, ".config/codex-orchestrator");
  fs.mkdirSync(configDir, { recursive: true });
  const configFile = path.join(configDir, "claude-executable");
  return { home, binDir, configDir, configFile };
}

function installFakeClaude(binDir, body = FAKE_CLAUDE_MAX, name = "claude") {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

function run(args, { home, extraEnv = {} } = {}) {
  return spawnSync(launcher, args, {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      ...extraEnv,
    },
  });
}

test("absent trusted configuration falls back to /usr/bin/claude without regression", () => {
  const { home } = makeHome();
  // No configuration file is written.
  const result = run(["--role", "default", "--verify-only"], { home });

  // The default /usr/bin/claude is offline-unauthenticated under this temp HOME,
  // so the standard auth path fails closed with 78 -- never a config rejection.
  assert.equal(result.status, 78);
  assert.doesNotMatch(result.stderr, /Trusted Claude configuration/);
  assert.match(
    result.stderr,
    /Claude subscription authentication check failed|Claude Max authentication is required/,
  );
});

test("XDG_CONFIG_HOME cannot redirect the trusted configuration location", () => {
  const { home, binDir } = makeHome();
  // A valid, authenticating config placed under an attacker-chosen XDG dir.
  const claudePath = installFakeClaude(binDir);
  const xdgDir = fs.mkdtempSync(path.join(os.tmpdir(), "evil-xdg-"));
  const xdgConfigDir = path.join(xdgDir, "codex-orchestrator");
  fs.mkdirSync(xdgConfigDir, { recursive: true });
  fs.writeFileSync(path.join(xdgConfigDir, "claude-executable"), `${claudePath}\n`, { mode: 0o600 });
  // No config exists at the fixed $HOME/.config location.

  const result = run(["--role", "default", "--verify-only"], {
    home,
    extraEnv: { XDG_CONFIG_HOME: xdgDir },
  });

  // The launcher ignores XDG_CONFIG_HOME and falls back to /usr/bin/claude,
  // which is unauthenticated here -- it never adopts the XDG-supplied target.
  assert.equal(result.status, 78);
  assert.doesNotMatch(result.stdout, /executable=/);
});

test("valid manager-style nvm path authenticates and reports selection for both roles", () => {
  const { home, binDir, configFile } = makeHome();
  const claudePath = installFakeClaude(binDir);
  fs.writeFileSync(configFile, `${claudePath}\n`, { mode: 0o600 });

  const impl = run(["--role", "implementation", "--verify-only"], { home });
  assert.equal(impl.status, 0);
  assert.match(impl.stdout, /model=opus/);
  assert.match(impl.stdout, /auth=claude\.ai subscription=max fallback=disabled/);
  assert.match(impl.stdout, new RegExp(`executable=${claudePath}(\\s|$)`));

  const def = run(["--role", "default", "--verify-only"], { home });
  assert.equal(def.status, 0);
  assert.match(def.stdout, /model=sonnet/);
  assert.match(def.stdout, new RegExp(`executable=${claudePath}(\\s|$)`));
});

test("execution uses the validated target, forces the role model, and sanitizes credentials", () => {
  const { home, binDir, configFile } = makeHome();
  installFakeClaude(binDir);
  fs.writeFileSync(configFile, `${path.join(binDir, "claude")}\n`, { mode: 0o600 });

  const result = run(["--role", "implementation", "--print"], {
    home,
    extraEnv: { ANTHROPIC_API_KEY: "test-only", OPENAI_API_KEY: "test-only" },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /provider_credentials=absent/);
  assert.match(result.stdout, /arg=--model/);
  assert.match(result.stdout, /arg=opus/);
  assert.match(result.stdout, /arg=--print/);
});

test("a hostile PATH cannot replace the selected executable", () => {
  const { home, binDir, configFile } = makeHome();
  installFakeClaude(binDir);
  fs.writeFileSync(configFile, `${path.join(binDir, "claude")}\n`, { mode: 0o600 });

  const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), "evil-path-"));
  fs.writeFileSync(
    path.join(evilDir, "claude"),
    ["#!/bin/sh", "printf 'MALICIOUS\\n'", "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );

  const result = run(["--role", "default", "--print"], {
    home,
    extraEnv: { PATH: `${evilDir}${path.delimiter}${process.env.PATH}` },
  });

  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /MALICIOUS/);
  assert.match(result.stdout, /provider_credentials=absent/);
});

test("a symlink configuration object is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const claudePath = installFakeClaude(binDir);
  fs.symlinkSync(claudePath, configFile);

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must be a regular file, not a symlink/);
});

test("a non-regular (directory) configuration object is rejected", () => {
  const { home, configFile } = makeHome();
  fs.mkdirSync(configFile);

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must be a regular file/);
});

test("a non-regular (fifo) configuration object is rejected", () => {
  const { home, configFile } = makeHome();
  const made = spawnSync("mkfifo", [configFile], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must be a regular file/);
});

test("a group- or world-writable configuration is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const claudePath = installFakeClaude(binDir);
  fs.writeFileSync(configFile, `${claudePath}\n`, { mode: 0o600 });
  fs.chmodSync(configFile, 0o666);

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must not be group- or world-writable/);
});

test(
  "a foreign-owned configuration is rejected",
  { skip: process.getuid && process.getuid() !== 0 ? "requires root to create a foreign-owned fixture" : false },
  () => {
    const { home, binDir, configFile } = makeHome();
    const claudePath = installFakeClaude(binDir);
    fs.writeFileSync(configFile, `${claudePath}\n`, { mode: 0o600 });
    fs.chownSync(configFile, 65534, 65534); // nobody

    const result = run(["--role", "default", "--verify-only"], { home });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /must be owned by the current user/);
  },
);

test("empty and whitespace-only configuration contents are rejected", () => {
  const empty = makeHome();
  fs.writeFileSync(empty.configFile, "", { mode: 0o600 });
  const emptyRun = run(["--role", "default", "--verify-only"], { home: empty.home });
  assert.equal(emptyRun.status, 64);
  assert.match(emptyRun.stderr, /exactly one nonempty line|must not be empty/);

  const blank = makeHome();
  fs.writeFileSync(blank.configFile, "\n", { mode: 0o600 });
  const blankRun = run(["--role", "default", "--verify-only"], { home: blank.home });
  assert.equal(blankRun.status, 64);
  assert.match(blankRun.stderr, /must not be empty/);
});

test("multiple-line configuration contents are rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const claudePath = installFakeClaude(binDir);
  fs.writeFileSync(configFile, `${claudePath}\n${claudePath}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /exactly one line/);
});

test("a relative configuration path is rejected", () => {
  const { home, configFile } = makeHome();
  fs.writeFileSync(configFile, "relative/path/claude\n", { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must be absolute/);
});

test("whitespace, control-character, and extra-token contents are rejected", () => {
  const withSpace = makeHome();
  fs.writeFileSync(withSpace.configFile, "/path/to/claude --model opus\n", { mode: 0o600 });
  const spaceRun = run(["--role", "default", "--verify-only"], { home: withSpace.home });
  assert.equal(spaceRun.status, 64);
  assert.match(spaceRun.stderr, /unsupported characters/);

  const withTab = makeHome();
  fs.writeFileSync(withTab.configFile, "/path/to\tclaude\n", { mode: 0o600 });
  const tabRun = run(["--role", "default", "--verify-only"], { home: withTab.home });
  assert.equal(tabRun.status, 64);
  assert.match(tabRun.stderr, /unsupported characters/);

  const withControl = makeHome();
  fs.writeFileSync(withControl.configFile, "/path/to/claude\u0001\n", { mode: 0o600 });
  const controlRun = run(["--role", "default", "--verify-only"], { home: withControl.home });
  assert.equal(controlRun.status, 64);
  assert.match(controlRun.stderr, /unsupported characters/);
});

test("a parent-directory traversal path is rejected", () => {
  const { home, configFile } = makeHome();
  // A raw (non-normalized) traversal sequence within the nvm-root prefix.
  const traversal = `${home}/.nvm/versions/node/${NODE_VERSION}/bin/../../../../../../etc/claude`;
  fs.writeFileSync(configFile, `${traversal}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must not contain "\.\." segments/);
});

test("a missing target is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  fs.writeFileSync(configFile, `${path.join(binDir, "ghost")}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /does not exist/);
});

test("a non-executable target is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const plain = path.join(binDir, "claude");
  fs.writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
  fs.writeFileSync(configFile, `${plain}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /is not executable/);
});

test("a group- or world-writable target is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const writable = installFakeClaude(binDir, FAKE_CLAUDE_MAX, "claude");
  fs.chmodSync(writable, 0o775); // group-writable and executable
  fs.writeFileSync(configFile, `${writable}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /must not be group- or world-writable/);
});

test("a symlink target escaping the nvm root is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const outside = path.join(home, "outside-claude");
  fs.writeFileSync(outside, FAKE_CLAUDE_MAX, { mode: 0o755 });
  const link = path.join(binDir, "claude");
  fs.symlinkSync(outside, link);
  fs.writeFileSync(configFile, `${link}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /escapes the supported nvm installation root/);
});

test("a broken symlink target is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const link = path.join(binDir, "claude");
  fs.symlinkSync(path.join(binDir, "nonexistent"), link);
  fs.writeFileSync(configFile, `${link}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /does not exist|could not be resolved/);
});

test("a looping symlink target is rejected", () => {
  const { home, binDir, configFile } = makeHome();
  const a = path.join(binDir, "loop-a");
  const b = path.join(binDir, "loop-b");
  fs.symlinkSync(b, a);
  fs.symlinkSync(a, b);
  fs.writeFileSync(configFile, `${a}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /does not exist|could not be resolved/);
});

test("a target outside the supported nvm root is rejected", () => {
  const { home, configFile } = makeHome();
  const outsideDir = path.join(home, ".local/bin");
  fs.mkdirSync(outsideDir, { recursive: true });
  const outside = path.join(outsideDir, "claude");
  fs.writeFileSync(outside, FAKE_CLAUDE_MAX, { mode: 0o755 });
  fs.writeFileSync(configFile, `${outside}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /outside the supported nvm installation root/);
});

test("model, settings, and fallback overrides remain rejected before auth", () => {
  const { home, binDir, configFile } = makeHome();
  installFakeClaude(binDir);
  fs.writeFileSync(configFile, `${path.join(binDir, "claude")}\n`, { mode: 0o600 });

  for (const override of [
    "--model",
    "--fallback-model",
    "--settings",
    "--managed-settings",
    "--setting-sources",
  ]) {
    const result = run(["--role", "implementation", override, "x"], { home });
    assert.equal(result.status, 64, override);
    assert.match(result.stderr, /blocked Claude worker override/);
  }
});

test("Claude Max authentication is required even with a valid trusted target", () => {
  const { home, binDir, configFile } = makeHome();
  const claudePath = installFakeClaude(binDir, FAKE_CLAUDE_NOT_MAX);
  fs.writeFileSync(configFile, `${claudePath}\n`, { mode: 0o600 });

  const result = run(["--role", "default", "--verify-only"], { home });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /Claude Max authentication is required/);
});

test("role mapping, usage, and verify-only argument guards are unchanged", () => {
  const { home } = makeHome();

  const noRole = run(["--verify-only"], { home });
  assert.equal(noRole.status, 64);
  assert.match(noRole.stderr, /usage: claude-subscription-worker/);

  const badRole = run(["--role", "architect"], { home });
  assert.equal(badRole.status, 64);
  assert.match(badRole.stderr, /unsupported Claude worker role/);

  const verifyWithArgs = run(["--role", "default", "--verify-only", "--print"], { home });
  assert.equal(verifyWithArgs.status, 64);
  assert.match(verifyWithArgs.stderr, /--verify-only does not accept Claude arguments/);
});
