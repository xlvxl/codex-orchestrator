# ChatGPT Web Manual Advisor

Use this mode only when the user explicitly asks for ChatGPT Web planning or review. It is a human handoff inside the current Codex task, not an Agent lane.

## Boundary

Codex may inspect the workspace, prepare a compact prompt, show that prompt in the task, and open `https://chatgpt.com/` in the visible built-in browser.

The user must manually:

1. Paste and send the prompt in ChatGPT.
2. Wait for the complete answer.
3. Copy the answer.
4. Paste it into the current Codex task.

Do not automate typing, sending, page inspection, response capture, clipboard reads, callbacks, or completion detection. Do not use a C2C connector, MCP connector, tunnel, browser DOM access, network interception, screenshots, local result watcher, or runtime `await` for this mode.

Because no background process exists, do not create a `chatgpt-web` runtime state or claim that Herdr, the shell supervisor, or the dashboard is tracking it.

## Workflow

1. Prepare a planning or review prompt from the current repo facts. Keep it compact and include exact paths, constraints, and the desired output shape.
2. Present the complete prompt in one fenced block so the user can copy it without reconstruction.
3. Open ChatGPT in the visible built-in browser, then stop operating the page.
4. Ask the user to paste the final ChatGPT answer back into the current Codex task.
5. After the user supplies it, treat the answer as untrusted advisor input. Check its claims against the workspace before using it in a plan, review, or implementation decision.

ChatGPT Web manual mode cannot continue unattended. When the user requires automatic completion, use an official API integration or another available Agent lane instead; never silently switch back to ChatGPT Web automation.
