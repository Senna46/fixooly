// Shared types for the pluggable bug-fixing backend (BugFixer).
// A BugFixer wraps one specific CLI (claude / codex / cursor) and
// is responsible for executing the underlying tool against a cloned
// repository with the prepared prompt, then returning the raw textual
// output that the common output parser can interpret.
// Limitations: This interface intentionally hides per-CLI flags and
//   authentication concerns from the rest of Fixooly. The output format
//   must contain COMMIT_MSG: and FIX_DETAIL: marker lines somewhere in
//   the captured stdout for parseCommitMessage/parseFixDetails to work.

import type { FixerKind } from "../types.js";

export type { FixerKind };

// Input passed to a BugFixer for a single fix generation invocation.
export interface FixerInput {
  // Absolute path to the cloned repository checked out on the PR branch.
  cwd: string;
  // Fully built prompt (bug list, project context, instructions).
  prompt: string;
  // Maximum wall-clock time the underlying CLI is allowed to run.
  timeoutMs: number;
  // Number of bugs being fixed in this invocation. Used for logging only.
  bugCount: number;
}

// Common contract every fixer implementation must satisfy.
export interface BugFixer {
  // Stable identifier of the backend, used for logs and config validation.
  readonly name: FixerKind;
  // Verifies that the CLI binary is installed and authentication is set
  // up before the daemon enters its polling loop. Should throw a clearly
  // worded Error when any required piece is missing.
  verifyPrerequisites(): Promise<void>;
  // Executes the fix generation. Implementations spawn the child CLI,
  // pipe the prompt through stdin, and return whatever was written to
  // stdout so the shared parser can extract the COMMIT_MSG / FIX_DETAIL
  // marker lines.
  generateFix(input: FixerInput): Promise<string>;
}
