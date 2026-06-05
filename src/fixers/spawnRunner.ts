// Shared child-process runner for BugFixer implementations.
// Spawns a CLI with the given binary/args, pipes the prompt via stdin,
// applies a hard wall-clock timeout (SIGTERM then SIGKILL after a grace
// period), captures bounded stdout/stderr buffers, and resolves with the
// captured stdout on success.
// Limitations: stderr is retained only for diagnostic logging on failure.
//   stdout is truncated to maxStdoutSize bytes (keeping the tail) so a
//   runaway model cannot exhaust process memory.

import { spawn } from "child_process";

import { logger } from "../logger.js";

// Time the runner waits between SIGTERM and the follow-up SIGKILL when
// the child does not exit gracefully on the first signal.
const SIGKILL_GRACE_MS = 5_000;

// Configuration for a single child-process invocation.
export interface SpawnFixerOptions {
  // Executable to spawn, e.g. "claude" / "agent" / "codex".
  binary: string;
  // Argument vector passed verbatim to the child process.
  args: string[];
  // Working directory of the child process (typically the cloned repo).
  cwd: string;
  // Text written to the child's stdin, then stdin is closed.
  stdinInput: string;
  // Hard wall-clock timeout. The runner sends SIGTERM at this point and
  // falls back to SIGKILL after SIGKILL_GRACE_MS.
  timeoutMs: number;
  // Human-readable name used in log messages and error strings.
  logTag: string;
  // Maximum number of bytes of stdout to keep (the tail is preserved).
  maxStdoutSize: number;
  // Extra environment variables merged on top of process.env. Each fixer
  // can use this to inject CLI-specific knobs without polluting the
  // daemon's own environment.
  env?: Record<string, string>;
}

// Run the configured child process and resolve with the captured stdout.
// Rejects with a descriptive Error on timeout, non-zero exit, or spawn
// failure.
export function runFixerProcess(opts: SpawnFixerOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const child = spawn(opts.binary, opts.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });

    let stdout = "";
    let stderr = "";

    const killTimer = setTimeout(() => {
      if (settled) return;
      logger.warn(`${opts.logTag} timed out, sending SIGTERM.`, {
        timeoutMs: opts.timeoutMs,
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (settled) return;
        logger.warn(
          `${opts.logTag} did not exit after SIGTERM, sending SIGKILL.`
        );
        child.kill("SIGKILL");
      }, SIGKILL_GRACE_MS);
    }, opts.timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > opts.maxStdoutSize) {
        stdout = stdout.substring(stdout.length - opts.maxStdoutSize);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        logger.error(`${opts.logTag} timed out.`, {
          signal,
          timeoutMs: opts.timeoutMs,
          stderr: stderr.substring(0, 1000) || "(empty)",
          stdoutTail:
            stdout.substring(Math.max(0, stdout.length - 1000)) || "(empty)",
        });
        reject(
          new Error(
            `${opts.logTag} fix generation timed out after ${
              opts.timeoutMs / 1000
            }s.`
          )
        );
        return;
      }

      if (code !== 0) {
        logger.error(`${opts.logTag} exited with non-zero code.`, {
          exitCode: code,
          stderr: stderr.substring(0, 1000) || "(empty)",
          stdoutTail:
            stdout.substring(Math.max(0, stdout.length - 2000)) || "(empty)",
        });
        reject(
          new Error(`${opts.logTag} fix generation exited with code ${code}.`)
        );
        return;
      }

      resolve(stdout);
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      reject(
        new Error(`${opts.logTag} fix generation failed: ${error.message}`)
      );
    });

    child.stdin.write(opts.stdinInput);
    child.stdin.end();
  });
}
