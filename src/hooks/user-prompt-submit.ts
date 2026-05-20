// UserPromptSubmit hook: publishes a truncated copy of the user's prompt
// so teammates' agents can see what each user is asking. Respects the
// share_prompts userConfig flag (default true). Fails open like every
// other hook.

import { hookIpc, readStdinJson, sharePromptsEnabled, warn } from "./_common.js";

const MAX_PROMPT_CHARS = 100;

function truncate(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 3) + "...";
}

async function main(): Promise<void> {
  const input = readStdinJson();
  const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return;

  if (!sharePromptsEnabled()) {
    await hookIpc("set_last_prompt", { session_id: sessionId, text: null }, sessionId, 800);
    return;
  }

  const promptRaw = typeof input.prompt === "string" ? input.prompt : "";
  if (!promptRaw) {
    return;
  }
  const text = truncate(promptRaw, MAX_PROMPT_CHARS);
  await hookIpc("set_last_prompt", { session_id: sessionId, text }, sessionId, 800);
}

main().catch((e) => {
  warn(`user-prompt-submit: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(0);
});
