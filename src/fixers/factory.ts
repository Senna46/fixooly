// Factory that selects and instantiates the BugFixer implementation
// corresponding to AUTOFIX_FIXER. Centralises the switch so that
// main.ts does not need to import every concrete fixer class.
// Limitations: Validation of the FixerKind value happens in config.ts
//   via parseFixerKind(); this factory assumes its input has already
//   been validated and simply throws on the unreachable default branch.

import type { Config } from "../types.js";
import { ClaudeFixer } from "./claudeFixer.js";
import { CodexFixer } from "./codexFixer.js";
import { CursorFixer } from "./cursorFixer.js";
import type { BugFixer } from "./types.js";

// Build the BugFixer matching the selected backend kind in the Config.
// Throws if the value is not one of the supported kinds (defensive check
// against future enum expansions that forget to update this factory).
export function createFixer(config: Config): BugFixer {
  switch (config.fixer) {
    case "claude":
      return new ClaudeFixer(config.claudeModel);
    case "codex":
      return new CodexFixer(config.codexModel);
    case "cursor":
      return new CursorFixer(config.cursorModel);
    default: {
      const exhaustiveCheck: never = config.fixer;
      throw new Error(
        `Unsupported AUTOFIX_FIXER value: "${exhaustiveCheck}". ` +
          'Expected one of "claude", "codex", or "cursor".'
      );
    }
  }
}
