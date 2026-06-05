// CursorFixer: BugFixer implementation backed by the Cursor CLI
// (`agent -p`). Configured for fully unattended use in a daemon:
//   * --force / --yolo equivalent: pre-approve every command including
//     file modifications, so the agent does not block waiting for input.
//   * --trust: trust the workspace without prompting (required in headless
//     mode where there is no UI to confirm trust).
//   * --workspace: pin the agent to the cloned repository directory.
//   * --output-format json: emit a single JSON object so the shared output
//     parser can pull the result string out reliably.
// Authentication: CURSOR_API_KEY is the only required environment
// variable for daemon/CI use. Interactive `agent login` also works, but
// is generally unsuitable for unattended deployments.
// Limitations: The Cursor CLI accepts the prompt as a trailing positional
//   argument. On systems with small ARG_MAX, very large prompts may
//   exceed the OS limit. Fixooly's prompt builder already enforces upper
//   bounds on diff/file context sizes, but extreme cases may still hit
//   E2BIG; if that happens, lower MAX_FILE_CONTEXT_SIZE in fixGenerator.

import { execFile } from "child_process";
import { promisify } from "util";

import { logger } from "../logger.js";
import { runFixerProcess } from "./spawnRunner.js";
import type { BugFixer, FixerInput, FixerKind } from "./types.js";

const execFileAsync = promisify(execFile);

// Cursor CLI's installer (curl https://cursor.com/install -fsS | bash)
// places an `agent` binary on PATH. Some distributions expose the same
// tool as `cursor-agent` instead, so verifyPrerequisites tries both.
const PRIMARY_BINARY = "agent";
const FALLBACK_BINARY = "cursor-agent";

// JSON wrapper inflates the assistant message somewhat, so the cap is
// a little higher than Claude's 100KB tail.
const MAX_STDOUT_SIZE = 200_000;

export class CursorFixer implements BugFixer {
  readonly name: FixerKind = "cursor";
  private readonly model: string | null;
  // Cached after verifyPrerequisites picks the binary that responded to
  // --version. Defaults to the documented "agent" name until we confirm.
  private resolvedBinary: string = PRIMARY_BINARY;

  constructor(model: string | null) {
    this.model = model;
  }

  async verifyPrerequisites(): Promise<void> {
    const candidate = await this.detectBinary();
    if (!candidate) {
      throw new Error(
        `Cursor CLI binary is not available (tried "${PRIMARY_BINARY}" and ` +
          `"${FALLBACK_BINARY}"). Install via: ` +
          "curl https://cursor.com/install -fsS | bash"
      );
    }
    this.resolvedBinary = candidate.binary;
    logger.debug("Cursor CLI detected.", {
      binary: candidate.binary,
      version: candidate.version,
    });

    if (!process.env.CURSOR_API_KEY) {
      logger.warn(
        "CURSOR_API_KEY is not set. The Cursor CLI will fall back to an " +
          "interactive login session, which is unsuitable for daemon use. " +
          "Run 'agent login' once or set CURSOR_API_KEY explicitly."
      );
    }
  }

  async generateFix(input: FixerInput): Promise<string> {
    const args = [
      "-p",
      "--force",
      "--trust",
      "--workspace",
      input.cwd,
      "--output-format",
      "json",
    ];

    if (this.model) {
      args.push("--model", this.model);
    }

    // Cursor CLI reads the prompt as the trailing positional argument
    // rather than from stdin, so we pass it via argv here.
    args.push(input.prompt);

    logger.info("Running Cursor CLI (agent -p) for fix generation...", {
      bugCount: input.bugCount,
      repoDir: input.cwd,
      model: this.model ?? "(default)",
      binary: this.resolvedBinary,
    });

    return runFixerProcess({
      binary: this.resolvedBinary,
      args,
      cwd: input.cwd,
      stdinInput: "",
      timeoutMs: input.timeoutMs,
      logTag: `${this.resolvedBinary} -p`,
      maxStdoutSize: MAX_STDOUT_SIZE,
    });
  }

  // Try the documented "agent" name first and fall back to "cursor-agent"
  // for setups where the installer or a wrapper script used that name.
  private async detectBinary(): Promise<
    { binary: string; version: string } | null
  > {
    for (const binary of [PRIMARY_BINARY, FALLBACK_BINARY]) {
      try {
        const { stdout } = await execFileAsync(binary, ["--version"]);
        return { binary, version: stdout.trim() };
      } catch {
        // try the next candidate
      }
    }
    return null;
  }
}
