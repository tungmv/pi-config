/**
 * Session Limit
 *
 * Keeps the N most recently used sessions per project session directory and
 * deletes the older ones. Default: 20 sessions.
 *
 * - Runs on session start, so the newest session is always kept and the current
 *   session file is never deleted, even when it is older than the newest N.
 * - Only touches the session directory Pi groups sessions into for the current
 *   working directory (`ctx.sessionManager.getSessionDir()`). Other projects,
 *   and ephemeral `--no-session` runs, are left alone.
 * - Sessions modified in the last 10 minutes are never deleted: another Pi
 *   process may still be writing them, so they stay until a later start.
 * - Deletions go through a trash tool (`trash`, `trash-put`, then `gio trash`)
 *   so pruned sessions stay recoverable. When none is installed, or none can
 *   trash the session directory's filesystem, the files are unlinked instead.
 *
 * State: <agent-dir>/session-limit.json  ({"limit": N}, written by /session-limit)
 * A `sessionLimit` number in settings.json is honored too, but the state file
 * wins because /session-limit writes it.
 *
 * Usage:
 *   /session-limit          show the limit, its source, and session counts
 *   /session-limit <N>      set the limit (0 or "off" disables) and prune now
 *   /session-limit prune    prune now
 *   /session-limit reset    drop the /session-limit override
 */

import { readFileSync } from "node:fs";
import { readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

const DEFAULT_LIMIT = 20;
const STATE_FILE = join(getAgentDir(), "session-limit.json");
const RECENTLY_ACTIVE_MS = 10 * 60 * 1000;

type LimitSource = "session-limit.json" | "settings.json" | "default";

interface SessionFile {
	path: string;
	mtimeMs: number;
}

interface PruneSummary {
	limit: number;
	source: LimitSource;
	dir: string;
	stored: number;
	over: number;
	removed: string[];
	failed: string[];
	viaTrash: boolean;
	error?: string;
}

function readState(): { limit?: number } {
	try {
		const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf8"));
		if (parsed && typeof parsed === "object") {
			const { limit } = parsed as { limit?: unknown };
			if (typeof limit === "number" && Number.isFinite(limit)) return { limit };
		}
	} catch {
		// Missing or unreadable state: no override.
	}
	return {};
}

async function writeState(limit: number | undefined): Promise<void> {
	const tmp = `${STATE_FILE}.tmp-${process.pid}`;
	await withFileMutationQueue(STATE_FILE, async () => {
		await writeFile(tmp, `${JSON.stringify(limit === undefined ? {} : { limit }, null, 2)}\n`, "utf8");
		await rename(tmp, STATE_FILE);
	});
}

/** Precedence: /session-limit state file, then the `sessionLimit` setting, then 20. */
function resolveLimit(pi: ExtensionAPI): { limit: number; source: LimitSource } {
	const state = readState();
	if (state.limit !== undefined) {
		return { limit: Math.max(0, Math.floor(state.limit)), source: "session-limit.json" };
	}

	try {
		const settings = pi.getSettings() as Record<string, unknown> | undefined;
		const value = settings?.sessionLimit;
		if (typeof value === "number" && Number.isFinite(value)) {
			return { limit: Math.max(0, Math.floor(value)), source: "settings.json" };
		}
	} catch {
		// Settings unavailable: fall back to the default.
	}

	return { limit: DEFAULT_LIMIT, source: "default" };
}

async function realpathOrSelf(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

/** Session files in `dir`, most recently modified first. */
async function listSessionFiles(dir: string): Promise<SessionFile[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: SessionFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const path = join(dir, entry.name);
		try {
			const info = await stat(path);
			files.push({ path, mtimeMs: info.mtimeMs });
		} catch {
			// Raced with another process: skip it.
		}
	}
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** A command that moves files to the desktop trash, if one is installed. */
type TrashTool = { command: string; probe: string[]; args: (paths: string[]) => string[] };

const TRASH_TOOLS: TrashTool[] = [
	// trash-cli (Fedora, Debian, most distros)
	{ command: "trash", probe: ["--version"], args: (paths) => paths },
	// trash-cli's alternate entry point
	{ command: "trash-put", probe: ["--version"], args: (paths) => paths },
	// GNOME's gio, present on most GTK desktops (Arch, Ubuntu, Fedora)
	{ command: "gio", probe: ["version"], args: (paths) => ["trash", ...paths] },
];

let trashTools: TrashTool[] | undefined;

/** Installed trash tools, probed once per session. */
async function availableTrashTools(pi: ExtensionAPI): Promise<TrashTool[]> {
	if (trashTools !== undefined) return trashTools;
	const found: TrashTool[] = [];
	for (const tool of TRASH_TOOLS) {
		try {
			const result = await pi.exec(tool.command, tool.probe, { timeout: 5000 });
			if (result.code === 0) found.push(tool);
		} catch {
			// Not installed: try the next one.
		}
	}
	trashTools = found;
	return found;
}

async function deleteSessions(
	pi: ExtensionAPI,
	paths: string[],
): Promise<{ removed: string[]; failed: string[]; viaTrash: boolean; error?: string }> {
	if (paths.length === 0) return { removed: [], failed: [], viaTrash: false };

	// Prefer a recoverable delete. Trashing can fail on filesystems it does not
	// support (and gio refuses system-internal mounts), so fall through to the
	// next tool, then to a plain unlink, carrying the reason along.
	let trashError: string | undefined;
	for (const tool of await availableTrashTools(pi)) {
		try {
			const result = await pi.exec(tool.command, tool.args(paths), { timeout: 20000 });
			if (result.code === 0) return { removed: paths, failed: [], viaTrash: true };
			trashError = (result.stderr || result.stdout).trim() || `${tool.command} exited with code ${result.code}`;
		} catch (error) {
			trashError = error instanceof Error ? error.message : String(error);
		}
	}

	const removed: string[] = [];
	const failed: string[] = [];
	for (const path of paths) {
		try {
			await unlink(path);
			removed.push(path);
		} catch {
			failed.push(path);
		}
	}
	return { removed, failed, viaTrash: false, error: trashError };
}

async function pruneSessions(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	{ dryRun = false }: { dryRun?: boolean } = {},
): Promise<PruneSummary | undefined> {
	const { limit, source } = resolveLimit(pi);
	const currentFile = ctx.sessionManager.getSessionFile() as string | undefined | null;
	if (!currentFile) return undefined; // Ephemeral session: nothing is stored.

	const dir = ctx.sessionManager.getSessionDir() || dirname(currentFile);
	const files = await listSessionFiles(dir);
	const current = await realpathOrSelf(currentFile);

	// Keep the newest `limit` sessions, plus the current session (always kept,
	// even when it sorts below the cut) and any session another Pi process may
	// still be writing (left for a later start).
	const doomed: string[] = [];
	let kept = 0;
	for (const file of files) {
		if (limit <= 0) break; // Pruning off: keep everything.
		if ((await realpathOrSelf(file.path)) === current) continue;
		if (Date.now() - file.mtimeMs < RECENTLY_ACTIVE_MS) continue;
		if (kept < limit) {
			kept++;
			continue;
		}
		doomed.push(file.path);
	}

	const base: PruneSummary = {
		limit,
		source,
		dir,
		stored: files.length,
		over: doomed.length,
		removed: [],
		failed: [],
		viaTrash: false,
	};
	if (doomed.length === 0 || dryRun) return base;

	return { ...base, ...(await deleteSessions(pi, doomed)) };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function describe(summary: PruneSummary): string {
	const header = `Session limit ${summary.limit} (${summary.source})`;
	if (summary.limit <= 0) return `${header} — pruning disabled.`;
	if (summary.removed.length > 0) {
		const action = summary.viaTrash ? "Moved to trash" : "Deleted";
		return `${header}\n${action} ${plural(summary.removed.length, "old session")}. ${plural(
			summary.stored - summary.removed.length,
			"session",
		)} stored.`;
	}
	if (summary.failed.length > 0) {
		return `${header}\nCould not remove ${plural(summary.failed.length, "session file")}${
			summary.error ? `: ${summary.error}` : ""
		}`;
	}
	return `${header}\nNothing to prune: ${plural(summary.stored, "session")} stored.`;
}

function notify(ctx: ExtensionContext, text: string, kind: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, kind);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		try {
			const summary = await pruneSessions(pi, ctx);
			if (!summary || (summary.removed.length === 0 && summary.failed.length === 0)) return;
			if (summary.removed.length > 0) {
				const action = summary.viaTrash ? "Moved to trash" : "Deleted";
				notify(
					ctx,
					`session-limit: ${action} ${plural(summary.removed.length, "old session")} (limit ${summary.limit})`,
				);
			}
			if (summary.failed.length > 0) {
				notify(
					ctx,
					`session-limit: could not remove ${plural(summary.failed.length, "session file")}${
						summary.error ? `: ${summary.error}` : ""
					}`,
					"warning",
				);
			}
		} catch (error) {
			notify(ctx, `session-limit: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.registerCommand("session-limit", {
		description: `Limit stored sessions per project (default ${DEFAULT_LIMIT}); usage: /session-limit [<number>|prune|off|reset]`,
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = [
				{ value: "prune", label: "prune", description: "Prune over-limit sessions now" },
				{ value: "off", label: "off", description: "Stop pruning stored sessions" },
				{ value: "reset", label: "reset", description: "Drop the /session-limit override" },
				{ value: String(DEFAULT_LIMIT), label: String(DEFAULT_LIMIT), description: "Default limit" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const argument = (args ?? "").trim();

			if (!argument) {
				const summary = await pruneSessions(pi, ctx, { dryRun: true });
				if (!summary) {
					notify(ctx, "session-limit: this session is ephemeral (--no-session); nothing is stored.", "warning");
					return;
				}
				const { limit, source, over } = summary;
				notify(
					ctx,
					[
						`Session limit: ${limit <= 0 ? "off" : limit} (${source})`,
						`dir: ${summary.dir}`,
						`stored: ${summary.stored}${over > 0 ? ` (${over} over the limit)` : ""}`,
						`state: ${STATE_FILE}`,
					].join("\n"),
				);
				return;
			}

			if (argument === "prune") {
				const summary = await pruneSessions(pi, ctx);
				notify(
					ctx,
					summary ? describe(summary) : "session-limit: this session is ephemeral; nothing is stored.",
					summary && summary.failed.length > 0 ? "warning" : "info",
				);
				return;
			}

			if (argument === "reset" || argument === "off") {
				await writeState(argument === "off" ? 0 : undefined);
				const { limit, source } = resolveLimit(pi);
				notify(
					ctx,
					limit <= 0
						? "Session pruning off. Nothing will be deleted."
						: `Session limit override cleared. Now ${limit} (${source}).`,
				);
				return;
			}

			const value = Number(argument);
			if (!Number.isInteger(value) || value < 0) {
				notify(
					ctx,
					`session-limit: expected a whole number, "prune", "off", or "reset" (got "${argument}")`,
					"error",
				);
				return;
			}

			await writeState(value);
			if (value === 0) {
				notify(ctx, "Session limit off. Nothing will be deleted.");
				return;
			}

			const summary = await pruneSessions(pi, ctx);
			notify(
				ctx,
				summary
					? describe(summary)
					: `Session limit set to ${value}. This session is ephemeral; nothing to prune.`,
				summary && summary.failed.length > 0 ? "warning" : "info",
			);
		},
	});
}
