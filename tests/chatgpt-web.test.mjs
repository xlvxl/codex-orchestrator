import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manual ChatGPT Web mode ships no automatic callback artifacts", () => {
  for (const file of [
    "skills/codex-orchestrator/scripts/chatgpt-web.mjs",
    "skills/codex-orchestrator/scripts/c2c-advice.patch",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});
