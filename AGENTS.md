# AGENTS.md

Guidelines for AI agents working on this codebase.

## Repository Purpose

This is **Fixooly**, a daemon that automatically fixes bugs reported by
Cursor Bugbot on GitHub PRs by delegating to a pluggable BugFixer backend
(Cursor CLI / Codex CLI / Claude Code CLI), selected via the AUTOFIX_FIXER
environment variable. It does NOT detect bugs itself; it only reads
Cursor Bugbot review comments and generates fixes.

## Before Making Changes

1. Run `npm run typecheck` to verify the codebase compiles
2. Read the relevant source files before editing
3. Understand the polling daemon architecture (main.ts -> bugbotMonitor -> bugParser -> fixGenerator)

## Code Style Rules

- TypeScript with strict mode enabled
- ESM modules with `.js` import extensions
- lowerCamelCase for all identifiers (variables, functions, properties, methods)
- Every source file starts with a comment block describing purpose and limitations
- All user-facing text (logs, GitHub comments) must be in English
- Git commit messages must be in English only
- Use structured logging: `logger.info("message", { contextKey: contextValue })`
- Error handling must include detailed context (function name, relevant parameters)
- Prefer readability over efficiency

## Module Dependency Graph

    main.ts
      -> config.ts
      -> logger.ts
      -> githubClient.ts
      -> state.ts
      -> bugbotMonitor.ts
           -> bugParser.ts
           -> githubClient.ts
           -> state.ts
      -> fixers/factory.ts
           -> fixers/claudeFixer.ts
           -> fixers/codexFixer.ts
           -> fixers/cursorFixer.ts
                (all use fixers/spawnRunner.ts)
      -> fixGenerator.ts
           -> fixers/types.ts (BugFixer)
           -> fixers/outputParser.ts
      -> types.ts (shared by all)

## Key Interfaces

- Config: All AUTOFIX_* settings from environment (appId, privateKey, fixer, ...)
- FixerKind: "claude" | "codex" | "cursor" (the supported backends)
- BugFixer: Common interface every fixer implements (name, verifyPrerequisites, generateFix)
- FixerInput: Per-invocation input passed to a BugFixer (cwd, prompt, timeoutMs, bugCount)
- BugbotBug: Parsed bug report from Cursor Bugbot comment
- PrBugReport: A PR with its list of unprocessed bugs
- FixResult: Commit SHA and list of fixed bugs after the fixer ran
- PullRequest: GitHub PR metadata (owner, repo, number, headRef, etc.)
- ReviewComment: Raw review comment data from GitHub API

## Testing Changes

After any code change:

    npm run typecheck    # Must pass with zero errors
    npm run build        # Must produce dist/ without errors

## Environment Variables

All Fixooly-specific config uses the AUTOFIX_ prefix. Required:
- AUTOFIX_APP_ID (GitHub App ID)
- AUTOFIX_PRIVATE_KEY_PATH or AUTOFIX_PRIVATE_KEY (GitHub App private key)
- AUTOFIX_FIXER (`claude` | `codex` | `cursor`; no default)

Backend-specific (depending on AUTOFIX_FIXER):
- cursor: CURSOR_API_KEY, optional AUTOFIX_CURSOR_MODEL
- codex:  CODEX_API_KEY (or ~/.codex/auth.json), optional AUTOFIX_CODEX_MODEL
- claude: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, optional AUTOFIX_CLAUDE_MODEL

Optional general:
- AUTOFIX_PUSH_TOKEN (classic PAT with repo scope, for triggering webhooks on push)

Monitored repositories are auto-discovered from the App installations.

## Common Tasks

### Adding a new config option
1. Add field to Config interface in types.ts
2. Parse it in config.ts loadConfig()
3. Add to .env.example with documentation comment

### Modifying bug parsing
- Edit regex patterns in bugParser.ts
- The Cursor Bugbot comment format uses HTML comment markers:
  <!-- BUGBOT_BUG_ID: uuid -->, <!-- DESCRIPTION START/END -->,
  <!-- LOCATIONS START/END -->

### Changing fix generation behavior
- Edit fixGenerator.ts for the prompt construction in buildFixPrompt(),
  and commitAndPush() for the commit message format
- Per-backend CLI invocation lives in src/fixers/*Fixer.ts; tool
  restrictions and authentication checks belong there, not in fixGenerator.ts
- Shared output marker conventions (COMMIT_MSG:, FIX_DETAIL:) and parsing
  live in src/fixers/outputParser.ts

### Adding a new fixer backend
1. Add the new value to FixerKind in types.ts and VALID_FIXER_KINDS in config.ts
2. Create src/fixers/<name>Fixer.ts implementing the BugFixer interface
3. Wire it into createFixer() in src/fixers/factory.ts
4. Document env vars and authentication in .env.example and README.md
