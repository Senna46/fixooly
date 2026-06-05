# CLAUDE.md

Instructions for Claude Code when working on this codebase.

## Project Overview

Fixooly is a TypeScript daemon that monitors GitHub PRs for Cursor Bugbot
review comments, parses bug reports, and auto-fixes them through a
pluggable BugFixer backend (Cursor CLI / Codex CLI / Claude Code CLI),
selected at startup via the AUTOFIX_FIXER environment variable.
Fixes are committed directly to the PR head branch.

## Tech Stack

- Language: TypeScript (ES2022, Node16 modules)
- Runtime: Node.js >= 18
- Package Manager: npm
- GitHub API: Octokit (via octokit package, GitHub App authentication)
- State: SQLite (via better-sqlite3)
- Config: dotenv
- Fix generation: pluggable BugFixer that wraps one of:
  - Cursor CLI (`agent -p --force --trust --workspace --output-format json`) -- recommended
  - OpenAI Codex CLI (`codex exec --sandbox workspace-write --ask-for-approval never --cd --json`)
  - Anthropic Claude Code CLI (`claude -p --allowedTools ...`)

## Project Structure

    src/
      main.ts              FixoolyDaemon entry point, polling loop, fixer wiring
      config.ts            AUTOFIX_* environment variable loader (incl. AUTOFIX_FIXER)
      types.ts             Shared interfaces (Config, FixerKind, BugbotBug, ...)
      logger.ts            Structured logger with level support
      githubClient.ts      Octokit wrapper (GitHub App auth, PR list, review comments)
      bugbotMonitor.ts     Discovers unprocessed cursor[bot] bugs via App installations
      bugParser.ts         Parses Cursor Bugbot comment format into BugbotBug objects
      fixGenerator.ts      Clones repo, builds the prompt, delegates fix generation
                           to the injected BugFixer, then commits and pushes
      fixers/
        types.ts           BugFixer interface and FixerInput type
        factory.ts         createFixer(config) -- selects backend per AUTOFIX_FIXER
        claudeFixer.ts     ClaudeFixer (claude -p with --allowedTools)
        codexFixer.ts      CodexFixer (codex exec with workspace-write sandbox)
        cursorFixer.ts     CursorFixer (agent -p with --force --trust --workspace)
        spawnRunner.ts     Shared child-process runner (timeout, stdin, bounded stdout)
        outputParser.ts    COMMIT_MSG / FIX_DETAIL marker parsing for text/JSON/JSONL
      state.ts             SQLite state tracking (processed_bugs table)

## Build and Run Commands

    npm install          # Install dependencies
    npm run build        # Compile TypeScript to dist/
    npm start            # Run compiled daemon
    npm run dev          # Run with tsx (development)
    npm run typecheck    # Type check without emitting

## Coding Conventions

- ESM modules: all imports use .js extension (e.g. import { X } from "./foo.js")
- lowerCamelCase for variables, functions, properties, and methods
- Structured logging: logger.info("message", { key: value })
- Error messages include function context and relevant parameters
- Comments at file top describe purpose and limitations (in English)
- User-facing text (logs, PR comments) in English
- Git commit messages in English only

## Key Patterns

- Polling daemon: FixoolyDaemon.run() loops with configurable sleep interval,
  interruptible via SIGINT/SIGTERM
- GitHub auth: GitHub App (JWT + installation access tokens via @octokit/auth-app)
- Repository discovery: auto-discovered from App installations (no manual repo/org list)
- Bugbot comment parsing: Regex extraction of BUGBOT_BUG_ID, DESCRIPTION, and
  LOCATIONS markers from cursor[bot] review comments
- Fix generation: dispatched to the selected BugFixer implementation. FixGenerator
  builds a backend-agnostic prompt that asks the model to emit COMMIT_MSG: and
  FIX_DETAIL: marker lines; src/fixers/outputParser.ts extracts those markers from
  whichever output format the underlying CLI produces (plain text / single-object
  JSON / JSONL stream). Each fixer enforces its own sandbox / allowed-tools policy
  (Claude: --allowedTools; Codex: --sandbox workspace-write; Cursor: --trust + --force).
- State: SQLite processed_bugs table with bug_id PRIMARY KEY prevents duplicates
- Repo cloning: Repos cloned to {workDir}/{owner}/{repo}/; reused with git fetch
- Git auth for clone/fetch: Installation access tokens via http.extraheader
- Git push: Uses AUTOFIX_PUSH_TOKEN (classic PAT) if set, otherwise installation
  token. PAT is needed to trigger webhook events for other integrations.

## Important Notes

- The daemon processes PRs sequentially (single-threaded)
- Bug parser depends on Cursor Bugbot comment format which may change
- Fix generator has a 10-minute timeout applied to whichever BugFixer is selected
- Git operations have a 2-minute timeout
- Fixes commit directly to the PR head branch (no separate fix branch)
- No dependency on gh CLI or GH_TOKEN; authentication is via GitHub App
- Optional AUTOFIX_PUSH_TOKEN (classic PAT) for git push to trigger webhooks
- Environment variables use AUTOFIX_ prefix; AUTOFIX_FIXER is required
- Recommended backend for daemon use is `cursor` (no per-hour rate limit on
  the Cursor Pro Auto+Composer pool); see README.md "Backend Selection"
