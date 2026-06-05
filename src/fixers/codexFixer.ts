// CodexFixer: BugFixer implementation backed by the OpenAI Codex CLI
// (`codex exec`). Configured for fully unattended use:
//   * --sandbox workspace-write: confine file edits to the cloned repo,
//     equivalent in intent to Claude's --allowedTools=Edit + read-only Bash.
//   * --ask-for-approval never: never pause for human approval.
//   * --skip-git-repo-check: Fixooly already clones into a git repo, but
//     this flag protects against transient detection issues (e.g. when
//     running inside a worktree the CLI does not recognise).
//   * --cd: pin the agent to the cloned repository directory.
//   * --json: emit a JSONL event stream so the shared output parser can
//     either pull last_agent_message or concatenate streaming deltas.
// Authentication: CODEX_API_KEY is the simplest option for daemon/CI
// use. ChatGPT-managed authentication via ~/.codex/auth.json is also
// supported but requires copying the file from an interactive machine.
// Limitations: ChatGPT Plus/Pro plans enforce a 5-hour rolling rate limit
//   (plus a weekly cap) on the underlying models, which can interrupt
//   long polling daemons. Cursor is generally a better fit for 24/7
//   daemons -- see plan in .plans/ for the trade-off discussion.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";

import { logger } from "../logger.js";
import { runFixerProcess } from "./spawnRunner.js";
import type { BugFixer, FixerInput, FixerKind } from "./types.js";

const execFileAsync = promisify(execFile);

const CODEX_BINARY = "codex";

// Codex's JSONL event stream is more verbose than Claude's --print
// output, so we retain a larger tail.
const MAX_STDOUT_SIZE = 300_000;

export class CodexFixer implements BugFixer {
  readonly name: FixerKind = "codex";
  private readonly model: string | null;

  constructor(model: string | null) {
    this.model = model;
  }

  async verifyPrerequisites(): Promise<void> {
    try {
      const { stdout } = await execFileAsync(CODEX_BINARY, ["--version"]);
      logger.debug("Codex CLI detected.", { version: stdout.trim() });
    } catch {
      throw new Error(
        `Codex CLI binary "${CODEX_BINARY}" is not available. ` +
          "Install via npm (-g @openai/codex) or follow the official " +
          "installation guide at https://developers.openai.com/codex/cli"
      );
    }

    if (!process.env.CODEX_API_KEY) {
      const authFile = join(homedir(), ".codex", "auth.json");
      if (!existsSync(authFile)) {
        logger.warn(
          "No Codex authentication detected. Set CODEX_API_KEY for daemon " +
            "use, or run 'codex login --device-auth' on a machine with a " +
            `browser and copy ~/.codex/auth.json to ${authFile}.`
        );
      } else {
        logger.debug("Using Codex auth.json for authentication.", {
          authFile,
        });
      }
    }
  }

  async generateFix(input: FixerInput): Promise<string> {
    const args = [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--skip-git-repo-check",
      "--cd",
      input.cwd,
      "--json",
    ];

    if (this.model) {
      args.push("--model", this.model);
    }

    logger.info("Running codex exec for fix generation...", {
      bugCount: input.bugCount,
      repoDir: input.cwd,
      model: this.model ?? "(default)",
    });

    // codex exec reads the prompt from stdin when no positional prompt
    // argument is provided, matching the pattern used for claude -p.
    return runFixerProcess({
      binary: CODEX_BINARY,
      args,
      cwd: input.cwd,
      stdinInput: input.prompt,
      timeoutMs: input.timeoutMs,
      logTag: "codex exec",
      maxStdoutSize: MAX_STDOUT_SIZE,
    });
  }
}
