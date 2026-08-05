/**
 * @-file Autocomplete & Content Inclusion Extension
 *
 * When you type `@` in the editor, file path autocomplete automatically appears.
 * Selecting a file inserts `@path/to/file.ts`. When you send the message, every
 * `@path` reference is expanded with the actual file content.
 *
 * Usage:
 *   Type @ + start typing a filename → autocomplete pops up automatically
 *   @src/index.ts + Enter → file content is included inline for the LLM
 *
 * Placement: ~/.pi/agent/extensions/autofile.ts (auto-discovered globally).
 * Reload with /reload after editing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const SUGGESTION_LIMIT = 20;
const MAX_FILE_SIZE = 100_000; // 100KB

/**
 * Extract the path token after a bare @ at the cursor position.
 * Returns the token text (empty string if just @) or undefined if no @ token.
 */
function extractAtToken(textBeforeCursor: string): string | undefined {
  // Match @ not preceded by a word character (to avoid email addresses)
  const match = textBeforeCursor.match(/(?<!\w)@([^\s@,)\]!?]*)$/);
  return match?.[1];
}

/** Regex to find all @path references in a body of text (for the input handler). */
const AT_REF_REGEX = /(?<!\w)@([^\s@,)\]!?]+)/g;

// ── Autocomplete Provider ──────────────────────────────────────────────────

function makeProvider(
  current: AutocompleteProvider,
  filesPromise: () => Promise<string[] | undefined>,
): AutocompleteProvider {
  return {
    triggerCharacters: ["@"],

    async getSuggestions(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      options: { signal: AbortSignal },
    ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol);
      const token = extractAtToken(before);

      // No @ token → let the built-in provider handle it
      if (token === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const files = await filesPromise();
      if (options.signal.aborted || !files || files.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      let suggestions: AutocompleteItem[];
      if (!token.trim()) {
        // Bare @ — show the first N files
        suggestions = files.slice(0, SUGGESTION_LIMIT).map((f) => ({
          value: f,
          label: f.split("/").pop() ?? f,
          description: f,
        }));
      } else {
        const matched = fuzzyFilter(files, token, (f) => f);
        suggestions = matched.slice(0, SUGGESTION_LIMIT).map((f) => ({
          value: f,
          label: f.split("/").pop() ?? f,
          description: f,
        }));
      }

      if (suggestions.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return { items: suggestions, prefix: `@${token}` };
    },

    applyCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string,
    ) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
    ): boolean {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
      );
    },
  };
}

// ── File Loading ───────────────────────────────────────────────────────────

async function loadFiles(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  // 1) git ls-files (respects .gitignore, fastest)
  const git = await pi.exec("git", ["ls-files"], { cwd, timeout: 5_000 });
  if (git.code === 0) {
    const files = git.stdout.split("\n").filter((f) => f.trim() && !f.includes(" "));
    if (files.length > 0) return files;
  }

  // 2) fd (respects .gitignore, fast)
  const fd = await pi.exec("fd", ["--type", "f", "--max-results", "500"], {
    cwd,
    timeout: 5_000,
  });
  if (fd.code === 0) {
    const files = fd.stdout.split("\n").filter(Boolean);
    if (files.length > 0) return files;
  }

  // 3) find (always available, but slower — limit depth)
  const findCmd = await pi.exec(
    "find",
    [".", "-type", "f", "-maxdepth", "8", "-not", "-path", "./.git/*"],
    { cwd, timeout: 15_000 },
  );
  if (findCmd.code === 0) {
    return findCmd.stdout
      .split("\n")
      .filter(Boolean)
      .map((f) => (f.startsWith("./") ? f.slice(2) : f));
  }

  return [];
}

// ── Input Transformation (expand @path to include file contents) ───────────

async function expandRefs(text: string, cwd: string): Promise<string> {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(AT_REF_REGEX.source, "g");
  while ((m = re.exec(text)) !== null) {
    refs.add(m[1]);
  }
  if (refs.size === 0) return text;

  // Resolve file contents in parallel
  const resolved = new Map<string, string>();
  for (const ref of refs) {
    if (!ref || ref === "." || ref.startsWith("..") || ref.startsWith("/")) continue;
    const abs = resolve(cwd, ref);
    try {
      const s = await stat(abs);
      if (!s.isFile() || s.size > MAX_FILE_SIZE) continue;
      resolved.set(ref, await readFile(abs, "utf8"));
    } catch {
      // file not found or not readable — skip silently
    }
  }

  if (resolved.size === 0) return text;

  // Replace longest paths first to avoid substring collisions
  let result = text;
  const sorted = Array.from(resolved).sort(([a], [b]) => b.length - a.length);
  for (const [ref, content] of sorted) {
    const ext = ref.split(".").pop() || "";
    const block = `\n\`\`\`${ext}\n${content}\n\`\`\``;
    const escaped = `@${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    result = result.replace(new RegExp(escaped, "g"), `@${ref}${block}`);
  }

  return result;
}

// ── Extension Entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    let files: string[] | undefined;
    let loading: Promise<string[]> | null = null;

    const getFiles = async (): Promise<string[] | undefined> => {
      if (files !== undefined) return files;
      if (!loading) loading = loadFiles(pi, ctx.cwd);
      files = await loading;
      return files;
    };

    // Warm the cache
    void getFiles().then((count) => {
      ctx.ui.notify(`autofile: indexed ${count?.length ?? 0} files`, "info");
    });

    // Register autocomplete provider (wraps built-in)
    ctx.ui.addAutocompleteProvider((current) => makeProvider(current, getFiles));
  });

  // Expand @path → file content when the user sends a message
  pi.on("input", async (event, ctx) => {
    if (!event.text.includes("@")) return { action: "continue" };

    const expanded = await expandRefs(event.text, ctx.cwd);
    if (expanded !== event.text) {
      return { action: "transform", text: expanded };
    }

    return { action: "continue" };
  });
}
