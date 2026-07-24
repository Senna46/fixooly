// Classifies fix-generation failures so the daemon can decide whether
// retrying is worth another full fix generation.
//   permanent — the same run will fail the same way (push rejected by a
//               branch rule, missing token scope). Give up immediately.
//   transient — an outage unrelated to the bug (usage limit, expired auth,
//               network). Retry later without spending a retry attempt.
//   retryable — anything else. Retry, but count it against the cap.

export type FailureKind = "permanent" | "transient" | "retryable";

export interface FailureClassification {
  kind: FailureKind;
  // Short human-readable cause, used in logs and the PR comment.
  reason: string;
}

const PERMANENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /without .?workflow.? scope/i,
    reason: "The push token lacks the `workflow` scope required to update .github/workflows files.",
  },
  {
    pattern: /protected branch|GH006|pre-receive hook declined/i,
    reason: "The PR head branch rejects pushes (branch protection or a pre-receive hook).",
  },
  {
    pattern: /permission to .+ denied|403 Forbidden/i,
    reason: "The push credentials are not allowed to write to this repository.",
  },
  {
    pattern: /remote rejected|refusing to allow/i,
    reason: "GitHub rejected the push to the PR head branch.",
  },
];

const TRANSIENT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /hit your limit|usage limit|rate limit|\b429\b/i,
    reason: "Claude usage limit reached.",
  },
  {
    pattern:
      /oauth (?:access )?(?:token|session) (?:has )?expired|invalid authentication credentials|\b401\b/i,
    reason: "Claude authentication expired or was rejected.",
  },
  {
    pattern:
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|EADDRNOTAVAIL|EAI_AGAIN|socket hang up|\b50[234]\b/i,
    reason: "Network or upstream service error.",
  },
];

export function classifyFailure(message: string): FailureClassification {
  for (const { pattern, reason } of PERMANENT_PATTERNS) {
    if (pattern.test(message)) return { kind: "permanent", reason };
  }

  for (const { pattern, reason } of TRANSIENT_PATTERNS) {
    if (pattern.test(message)) return { kind: "transient", reason };
  }

  return { kind: "retryable", reason: "Fix generation failed." };
}
