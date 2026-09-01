# ChatGPT Web Advisor

Use this lane only for planning and review. ChatGPT Web may inspect the current workspace through the patched Codex with ChatGPT connector, but it must never implement changes, run commands, or act as a write producer.

## Availability

This lane requires all of the following:

- Codex Desktop with the built-in browser capability.
- Node.js 20 or newer.
- `cloudflared`.
- The pinned, patched Codex with ChatGPT checkout installed by `scripts/chatgpt-web.mjs`.
- A ChatGPT account that can create and use a custom MCP connector.

Run the read-only check first:

```bash
node "$SKILL_DIR/scripts/chatgpt-web.mjs" check
```

If it reports unavailable, stop and ask whether to install or configure the missing dependency. Do not silently install software, create a tunnel, change ChatGPT settings, or switch to another advisor.

When the user approves installation, run:

```bash
node "$SKILL_DIR/scripts/chatgpt-web.mjs" install
```

The installer checks out `XiaoDuoYa/codex-with-chatgpt` at the pinned commit recorded in the script, applies `c2c-advice.patch`, installs its locked dependencies, and builds it under `~/.codex/vendor/codex-with-chatgpt`. It does not globally link `c2c`.

For first-time connector setup or repair, read only the setup, security, in-app browser, and reconnect sections of `<checkout>/skill/SKILL.md`. Use the built-in browser skill and its existing signed-in ChatGPT tab. The Orchestrator rules below replace the upstream coding loop, daily update check, and 20-30 second reply polling.

## Security Boundary

The patched connector adds one OAuth scope, `advice.submit`, and one MCP tool, `submit_advice`. The tool accepts a task ID, `plan|review`, and final text. It writes only a short protocol result beneath the C2C state directory.

It does not add workspace writes, shell execution, deletion, commits, package installation, or access outside the existing C2C workspace boundary. Existing users must reconnect the ChatGPT connector once so the new scope appears on the consent page.

## Plan Or Review Request

1. Create a unique task ID and a five-part spec. For review, include changed paths, success criteria, and the exact scoped verification evidence already available.
2. Ensure the C2C bridge and tunnel are healthy using the pinned checkout's `c2c doctor -w <workspace> --json`. Do not open ChatGPT until the doctor check is green.
3. Reuse the saved ChatGPT conversation for that workspace when valid. Otherwise use the same built-in browser tab to create or bind the conversation according to the upstream setup guidance.
4. Send one compact C2C message. Require ChatGPT to inspect through the named connector and call `submit_advice` exactly once when its final result is ready.
5. Immediately enter the runtime wait shown below. Do not inspect the page, ask for status, read routine logs, or send the request again.
6. After `await` returns, require terminal state `exited` and non-empty result text. The main Codex session then judges the advice and continues normal implementation or verification.

Planning request suffix:

```text
When the complete plan is ready, call submit_advice exactly once with:
- task_id: <task-id>
- kind: plan
- content: the complete C2C PLAN message

Do not call submit_advice with progress updates. Do not only print the plan in chat.
```

Review request suffix:

```text
When the complete independent review is ready, call submit_advice exactly once with:
- task_id: <task-id>
- kind: review
- content: the final findings and verdict, ordered by severity

Do not call submit_advice with progress updates. Do not only print the review in chat.
```

## Silent Runtime Wait

The wait is a normal read lane in the Orchestrator dashboard. The browser performs the reasoning; Herdr or the shell supervisor owns only the local completion wait.

```bash
RUNTIME="$SKILL_DIR/scripts/lane-runtime.sh"
WEB="$SKILL_DIR/scripts/chatgpt-web.mjs"
STATE_DIR=$("$RUNTIME" state-dir \
  --lane chatgpt-web --cwd "$CWD" --spec "$SPEC")
FINAL="$STATE_DIR/final.txt"

launch_receipt=$("$RUNTIME" start \
  --lane chatgpt-web --cwd "$CWD" --spec "$SPEC" --state-dir "$STATE_DIR" \
  --result-source "$FINAL" --ephemeral-watch \
  --title "$TITLE" --model-label "ChatGPT Web / current" --mode read -- \
  node "$WEB" wait --workspace "$CWD" --task "$TASK_ID" \
  --kind "$KIND" --output "$FINAL") || exit $?
"$RUNTIME" await --state-dir "$STATE_DIR"
```

Leave `CODEX_ORCHESTRATOR_RUNTIME` unset so normal Herdr-first selection remains active. The wait has no time limit unless `--timeout <milliseconds>` is explicitly supplied. It watches one local completion file without invoking a model.

If the user cancels, stop the runtime lane explicitly. If ChatGPT reports an authentication, connector, or tool error in the browser, the user may ask to repair the connection; never infer failure merely because the result has not arrived.
