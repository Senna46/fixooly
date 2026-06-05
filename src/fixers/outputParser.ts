// Common parser for CLI stdout produced by any BugFixer implementation.
// Supports three families of output formats:
//   * Plain text (Claude --print=text, Codex default formatted output)
//   * Single JSON object with a `result` string field (Claude --print, Cursor --output-format json)
//   * Newline-delimited JSON streams (Cursor --output-format stream-json, Codex --json)
// The parser first heuristically extracts the natural-language assistant
// text from the raw stdout, then scans that text for COMMIT_MSG: and
// FIX_DETAIL: marker lines that the fixers' prompt asks the model to emit.
// Limitations: When a backend wraps the assistant text in an unknown
//   structure, the parser falls back to the raw output so marker lines
//   still match as long as they appear verbatim in stdout.

// Marker prefixes that the shared prompt asks every backend to emit.
// fixGenerator.ts uses these to build the prompt, and the parser scans
// for them in the captured stdout.
export const COMMIT_MSG_PREFIX = "COMMIT_MSG: ";
export const FIX_DETAIL_PREFIX = "FIX_DETAIL: ";

// Public entry: extract the assistant text from an arbitrary CLI stdout.
// Used directly by tests and indirectly by the marker parsers below.
export function extractSearchableText(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (trimmed.length === 0) {
    return rawOutput;
  }

  // Case 1: single JSON object/array (Claude --print, Cursor --output-format json)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const direct = extractMessageFromJson(parsed);
      if (direct) {
        return direct;
      }
    } catch {
      // fall through to JSONL scanning
    }
  }

  // Case 2: JSONL stream - first try to find a terminal message with
  // a complete result/last_agent_message field (Cursor stream-json's
  // final "result" line, Codex's task_complete event).
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      const text = extractMessageFromJson(parsed);
      if (text) {
        return text;
      }
    } catch {
      continue;
    }
  }

  // Case 3: JSONL stream - concatenate streaming deltas (Codex's
  // agent_message_delta events, Cursor's stream-partial-output deltas).
  const deltas: string[] = [];
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmedLine);
      const delta = extractDeltaFromJson(parsed);
      if (delta) {
        deltas.push(delta);
      }
    } catch {
      continue;
    }
  }
  if (deltas.length > 0) {
    return deltas.join("");
  }

  // Case 4: raw text fallback - return the original stdout untouched so
  // that the marker line scan can still match plain text output.
  return rawOutput;
}

// Look up a final assistant message inside a single parsed JSON value.
// Covers the field names emitted by all three supported CLIs.
function extractMessageFromJson(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;

  // Claude --print / Cursor --output-format json: top-level "result" string
  if (typeof obj.result === "string") {
    return obj.result;
  }

  // Codex JSONL: task_complete event carries the final natural-language reply
  if (typeof obj.last_agent_message === "string") {
    return obj.last_agent_message;
  }

  // Codex JSONL: agent_message event carries the assistant text directly
  if (typeof obj.message === "string") {
    return obj.message;
  }

  // Cursor stream-json: assistant turn with content blocks
  // { "type": "assistant", "message": { "content": [{ "text": "..." }] } }
  const message = obj.message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const part of content) {
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          texts.push((part as { text: string }).text);
        }
      }
      if (texts.length > 0) {
        return texts.join("");
      }
    }
  }

  return null;
}

// Extract a streaming delta from a parsed JSONL event. Used to reconstruct
// the final assistant message from incremental tokens when no single
// terminating event is available.
function extractDeltaFromJson(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.delta === "string") {
    return obj.delta;
  }
  return null;
}

// Pull the single COMMIT_MSG: <summary> line out of the assistant text.
// The marker is searched bottom-up so a model that emits multiple drafts
// is interpreted as choosing the last one.
export function parseCommitMessage(rawOutput: string): string | null {
  const textToSearch = extractSearchableText(rawOutput);

  const lines = textToSearch.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith(COMMIT_MSG_PREFIX)) {
      const message = line.substring(COMMIT_MSG_PREFIX.length).trim();
      if (message.length > 0) {
        return message;
      }
    }
  }

  return null;
}

// Pull every FIX_DETAIL: <bug_id> | <description> line out of the
// assistant text into a Map keyed by bug ID. Lines without the "|"
// separator or with empty fields are silently ignored.
export function parseFixDetails(rawOutput: string): Map<string, string> {
  const details = new Map<string, string>();
  const textToSearch = extractSearchableText(rawOutput);

  for (const line of textToSearch.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(FIX_DETAIL_PREFIX)) {
      continue;
    }

    const content = trimmed.substring(FIX_DETAIL_PREFIX.length).trim();
    const separatorIndex = content.indexOf("|");
    if (separatorIndex <= 0) {
      continue;
    }

    const bugId = content.substring(0, separatorIndex).trim();
    const fixDescription = content.substring(separatorIndex + 1).trim();
    if (bugId && fixDescription) {
      details.set(bugId, fixDescription);
    }
  }

  return details;
}
