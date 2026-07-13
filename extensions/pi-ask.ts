/**
 * pi-ask Extension
 *
 * Registers the `/ask` slash command. When the user types `/ask <question>`,
 * the question is answered with **read-only access to the codebase**: the
 * model may read files and run read-only shell commands (grep, git log, rg,
 * cat, ...) to ground its answer, but it CANNOT write, edit, create, or
 * delete files and cannot run any state-modifying commands.
 *
 * This is "plan mode for a single turn" — tools are swapped to a read-only
 * set for the ask turn, then restored when the agent settles, so subsequent
 * normal prompts are unaffected.
 *
 * Usage:
 *   /ask How does dependency injection work in this codebase?
 *   /ask Where is the auth middleware applied?
 *   /ask What's the difference between Promise.all and Promise.allSettled?
 *
 * Placement: ~/.pi/agent/extensions/pi-ask.ts (auto-discovered globally).
 * Reload with /reload after editing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Built-in tools available during an /ask turn.
 * Everything state-modifying (write, edit, Agent subagents, etc.) is omitted.
 */
const ASK_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"];

/**
 * Instructions appended to the system prompt for the /ask turn.
 */
const ASK_SYSTEM_PROMPT_ADDENDUM = `
## /ask mode — read-only codebase Q&A

The user invoked \`/ask\`. They want an accurate answer grounded in THIS
codebase, but WITHOUT any side effects on their system. For this turn you MAY:

- Read files with \`read\`.
- Search the codebase with \`grep\`, \`find\`, \`ls\`.
- Run READ-ONLY shell commands with \`bash\` (e.g. \`rg\`, \`git log\`,
  \`git diff\`, \`wc -l\`, \`cat\`, \`head\`). Destructive commands are blocked
  automatically.

For this turn you MUST NOT:
- Write, edit, create, or delete any files (\`edit\` and \`write\` are disabled).
- Run any state-modifying shell command (rm, mv, cp, mkdir, touch, chmod,
  installs, git mutations, sudo, editors, redirections like >, etc.).
- Spawn sub-agents or run tools that modify state.

Answer the question directly and concisely. Cite the specific files and line
numbers you relied on. If the answer cannot be determined from the codebase,
say so rather than guessing. Keep the answer focused and self-contained.
`.trim();

// --- Read-only bash guard -------------------------------------------------
// Patterns adapted from pi's bundled plan-mode example. A command runs only
// if it matches a SAFE pattern AND does not match any DESTRUCTIVE pattern.

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // > redirection (but >> handled below, << heredoc allowed)
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function isReadOnlyCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export default function piAsk(pi: ExtensionAPI) {
	// Flags are armed by the /ask command and consumed by event handlers.
	// `askArmed` is one-shot (system-prompt injection); `askActive` covers the
	// whole run (tool restriction + bash guard) and is cleared on settle.
	let askArmed = false;
	let askActive = false;
	let toolsBeforeAsk: string[] | undefined;

	pi.registerCommand("ask", {
		description: "Ask a question — the model answers from the codebase using read-only tools only",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				ctx.ui.notify("Usage: /ask <question>", "warning");
				return;
			}

			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Wait for it to finish before using /ask.", "warning");
				return;
			}

			// Arm read-only mode for the upcoming turn, then send the bare
			// question as a user message (no /ask prefix).
			askArmed = true;
			ctx.ui.setStatus("pi-ask", "🔒 /ask (read-only)");
			pi.sendUserMessage(question);
		},
	});

	// Swap to read-only tools and inject the addendum for the /ask turn.
	pi.on("before_agent_start", async (event) => {
		if (!askArmed) {
			return;
		}
		// One-shot: consume the arm flag.
		askArmed = false;

		// Activate read-only mode for the whole run.
		askActive = true;
		if (toolsBeforeAsk === undefined) {
			toolsBeforeAsk = pi.getActiveTools();
		}
		const known = new Set(pi.getAllTools().map((t) => t.name));
		const askTools = ASK_TOOL_NAMES.filter((n) => known.has(n));
		pi.setActiveTools(askTools);

		return {
			systemPrompt: `${event.systemPrompt}\n\n${ASK_SYSTEM_PROMPT_ADDENDUM}`,
		};
	});

	// Block destructive bash commands while in /ask mode (belt + suspenders on
	// top of the allowlist; setActiveTools already removed edit/write).
	pi.on("tool_call", async (event) => {
		if (!askActive || event.toolName !== "bash") {
			return;
		}
		const command = (event.input?.command ?? "") as string;
		if (!isReadOnlyCommand(command)) {
			return {
				block: true,
				reason: `/ask mode is read-only. Command blocked (not on the read-only allowlist):\n${command}`,
			};
		}
	});

	// Restore the original toolset once the agent is fully settled (after any
	// auto-retries / auto-compaction). A queued follow-up from the user starts
	// a fresh run with the restored tools.
	pi.on("agent_settled", async (_event, ctx) => {
		if (askActive) {
			askActive = false;
			pi.setActiveTools(toolsBeforeAsk ?? []);
			toolsBeforeAsk = undefined;
			ctx.ui.setStatus("pi-ask", undefined);
		}
	});

	// Safety net: if the session shuts down mid-/ask, drop the status so a
	// reload/restart doesn't leave a stale lock indicator.
	pi.on("session_shutdown", async () => {
		askArmed = false;
		askActive = false;
		toolsBeforeAsk = undefined;
	});
}
