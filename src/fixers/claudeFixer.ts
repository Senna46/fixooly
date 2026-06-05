// ClaudeFixer: BugFixer implementation backed by the Anthropic Claude
// Code CLI (`claude -p`). Uses --allowedTools to restrict the agent to
// Read/Edit and a small set of read-only Bash commands so it cannot run
// arbitrary shell commands during fix generation.
// Authentication: relies on Claude Code's own credential resolution
// (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, or ~/.claude/.credentials.json).
// Limitations: Requires the claude binary on PATH. Fix quality is
//   inherited from whichever model Claude Code selects (or whatever
//   AUTOFIX_CLAUDE_MODEL overrides it to).

import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";

import { logger } from "../logger.js";
import { runFixerProcess } from "./spawnRunner.js";
import type { BugFixer, FixerInput, FixerKind } from "./types.js";

const execFileAsync = promisify(execFile);

// Tools claude -p is allowed to invoke. Edit is the main file-mutation
// capability; the bash entries are limited to read-only or inspection
// commands so the agent cannot run arbitrary scripts.
const ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Bash(git diff *)",
  "Bash(git status *)",
  "Bash(find *)",
  "Bash(grep *)",
  "Bash(rg *)",
  "Bash(ls *)",
  "Bash(cat *)",
  "Bash(head *)",
  "Bash(tail *)",
  "Bash(wc *)",
  "Bash(tree *)",
].join(",");

// Upper bound on the amount of stdout we keep in memory. Claude's --print
// mode emits the final JSON result at the end, so retaining only the tail
// is sufficient for parsing.
const MAX_STDOUT_SIZE = 100_000;

export class ClaudeFixer implements BugFixer {
  readonly name: FixerKind = "claude";
  private readonly model: string | null;

  constructor(model: string | null) {
    this.model = model;
  }

  async verifyPrerequisites(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("claude", ["--version"]);
      logger.debug("claude CLI detected.", { version: stdout.trim() });
    } catch {
      throw new Error(
        "claude CLI is not available. Install Claude Code first: " +
          "https://docs.anthropic.com/en/docs/claude-code"
      );
    }

    if (
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.ANTHROPIC_API_KEY
    ) {
      const homeDir = process.env.HOME ?? "/root";
      const credFile = `${homeDir}/.claude/.credentials.json`;
      if (!existsSync(credFile)) {
        logger.warn(
          "No Claude authentication detected. " +
            "On macOS Docker, set CLAUDE_CODE_OAUTH_TOKEN " +
            "(run 'claude setup-token' to generate). " +
            "On Linux, ensure ~/.claude is mounted and contains .credentials.json."
        );
      }
    }
  }

  async generateFix(input: FixerInput): Promise<string> {
    const args = ["-p", "--allowedTools", ALLOWED_TOOLS];

    if (this.model) {
      args.push("--model", this.model);
    }

    logger.info("Running claude -p for fix generation...", {
      bugCount: input.bugCount,
      repoDir: input.cwd,
      model: this.model ?? "(default)",
    });

    return runFixerProcess({
      binary: "claude",
      args,
      cwd: input.cwd,
      stdinInput: input.prompt,
      timeoutMs: input.timeoutMs,
      logTag: "claude -p",
      maxStdoutSize: MAX_STDOUT_SIZE,
    });
  }
}
