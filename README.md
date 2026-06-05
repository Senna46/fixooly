# Fixooly

Automatically fix [Cursor Bugbot](https://cursor.com/dashboard?tab=bugbot)-reported
bugs using a pluggable AI coding CLI -- choose between
[Cursor CLI](https://cursor.com/cli) (recommended),
[OpenAI Codex CLI](https://developers.openai.com/codex/cli/reference), or
[Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Monitors open pull requests for Cursor Bugbot review comments, parses bug reports, dispatches to the configured fixer to apply the fix, and commits the result directly to the PR head branch. A cost-effective alternative to Cursor's built-in Autofix.

## Features

- **Cursor Bugbot monitoring**: Polls GitHub for `cursor[bot]` review comments using repo-level API for efficient scanning
- **Resolved thread filtering**: Skips bugs whose review threads have been resolved (via GraphQL API)
- **Automatic bug parsing**: Extracts title, severity, description, file path, and line numbers from Bugbot's structured comment format
- **Pluggable fix backend**: Switch between Cursor, Codex, and Claude CLIs via the `AUTOFIX_FIXER` environment variable
- **Direct commit to PR**: Pushes fixes directly to the PR head branch (no separate fix branch or approval workflow)
- **Duplicate prevention**: SQLite-based state tracking ensures each bug ID is processed only once
- **Single-instance lock**: File-based lock prevents multiple daemon instances from running concurrently
- **Fix summary comments**: Posts a summary comment on the PR listing all fixed issues with commit link
- **Auto-discovery**: Automatically monitors all repositories accessible to the GitHub App
- **Docker support**: Production-ready Dockerfile and docker-compose.yml

## Prerequisites

- A [GitHub App](https://docs.github.com/en/apps/creating-github-apps) with required permissions, installed on target organizations/user accounts
- One of the supported fixer CLIs installed and authenticated (see [Backend Selection](#backend-selection))
- **`git`**: For repository operations
- **Node.js** >= 18.0.0 (for local installation) or **Docker** (for containerized deployment)

## Authentication Setup

### GitHub App

Fixooly uses GitHub App authentication instead of personal access tokens. Create a GitHub App with the following permissions:

- **Repository permissions**: Contents (read & write), Pull requests (read & write), Issues (read & write)
- **Subscribe to events**: (none required, polling-based)

After creating the App:
1. Note the **App ID** from the App settings page
2. Generate and download a **private key** (`.pem` file)
3. Install the App on the organizations/user accounts whose repositories you want to monitor

## Backend Selection

`AUTOFIX_FIXER` is required and chooses which CLI Fixooly uses to apply fixes. **Cursor is the recommended backend** for daemon use because Cursor Pro's Auto/Composer pool has no 5-hour rolling rate limit, unlike Codex on ChatGPT Plus/Pro.

| Backend | Plan | Headless auth | Rate limits | Recommended |
|---|---|---|---|---|
| `cursor` | Cursor Pro ($20/mo) | `CURSOR_API_KEY` | Monthly Auto+Composer pool, no per-hour cap | **Yes** |
| `codex`  | ChatGPT Plus ($20/mo) | `CODEX_API_KEY` or `~/.codex/auth.json` | 5-hour rolling + weekly cap | When you prefer GPT-5.3-Codex |
| `claude` | Anthropic plan or pay-as-you-go | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | Per-plan limits | Legacy |

### Cursor CLI (recommended)

```bash
# Install (macOS, Linux, WSL)
curl https://cursor.com/install -fsS | bash

# Verify
agent --version

# Authenticate for daemon use
export CURSOR_API_KEY=...
```

Optional: override the model with `AUTOFIX_CURSOR_MODEL=auto` (cost-optimised router) or `AUTOFIX_CURSOR_MODEL=composer-2.5` (Cursor's own agentic coding model). Both draw from the Auto+Composer usage pool included in the Cursor Pro flat rate.

### Codex CLI

```bash
# Install (see https://developers.openai.com/codex/cli/reference for full options)
npm install -g @openai/codex

# Verify
codex --version

# Authenticate (one of):
#   a) API key
export CODEX_API_KEY=...
#   b) ChatGPT subscription (run on a machine with a browser, then copy)
codex login --device-auth
# copy ~/.codex/auth.json to the daemon host afterwards
```

Optional: override the model with `AUTOFIX_CODEX_MODEL=gpt-5.3-codex` (the coding-tuned default).

### Claude Code CLI (legacy)

#### Option 1: OAuth Token (`CLAUDE_CODE_OAUTH_TOKEN`) -- for Pro/Max/Team plan

```bash
claude setup-token
```

#### Option 2: API Key (`ANTHROPIC_API_KEY`) -- for pay-as-you-go billing

1. Create an API key at [console.anthropic.com](https://console.anthropic.com/)
2. Set `ANTHROPIC_API_KEY` in `.env`

## Quick Start

### Local Installation

```bash
git clone https://github.com/Senna46/fixooly.git
cd fixooly

npm install

cp .env.example .env
# Edit .env: set AUTOFIX_APP_ID and AUTOFIX_PRIVATE_KEY_PATH

npm run build
npm start

# Or run in development mode
npm run dev
```

### Automated Setup

You can also use the automated setup script to configure your environment:

```bash
./setup-config.sh
```

### Docker

```bash
git clone https://github.com/Senna46/fixooly.git
cd fixooly

cp .env.example .env
# Edit .env with your GitHub App credentials, the AUTOFIX_FIXER backend,
# and the corresponding API key (CURSOR_API_KEY / CODEX_API_KEY /
# CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).

# (Claude only) Prevent Docker from creating ~/.claude.json as a directory
# when AUTOFIX_FIXER=claude.
touch ~/.claude.json

docker compose build
docker compose up -d

# View logs
docker compose logs -f
```

## Configuration

Copy `.env.example` to `.env` and configure:

### GitHub App Credentials

| Variable | Required | Description |
|---|---|---|
| `AUTOFIX_APP_ID` | Yes | GitHub App ID |
| `AUTOFIX_PRIVATE_KEY_PATH` | Yes\* | Path to the App private key `.pem` file |
| `AUTOFIX_PRIVATE_KEY` | Yes\* | App private key content (alternative to path) |
| `AUTOFIX_PUSH_TOKEN` | No | Classic PAT for git push (triggers webhooks) |

\* Either `AUTOFIX_PRIVATE_KEY_PATH` or `AUTOFIX_PRIVATE_KEY` must be set.

Monitored repositories are auto-discovered from the GitHub App installations.

**Why `AUTOFIX_PUSH_TOKEN`?** GitHub does not fire webhook events for pushes made with App installation tokens. If you use integrations that react to push events (e.g. Cursor Bugbot), set a [classic PAT](https://github.com/settings/tokens) with `repo` scope. When set, Fixooly uses this token for `git push` only; all API operations still use the GitHub App.

### Behavior

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTOFIX_POLL_INTERVAL` | No | `120` | Polling interval in seconds |
| `AUTOFIX_WORK_DIR` | No | `~/.fixooly/repos` | Directory for cloning repositories |
| `AUTOFIX_DB_PATH` | No | `~/.fixooly/state.db` | SQLite database path |
| `AUTOFIX_LOG_LEVEL` | No | `info` | Log level (debug/info/warn/error) |

### Fixer Backend

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTOFIX_FIXER` | **Yes** | _(none)_ | `claude` / `codex` / `cursor` (no default; must opt in explicitly) |
| `AUTOFIX_CURSOR_MODEL` | No | CLI default | Model override when `AUTOFIX_FIXER=cursor` (e.g. `auto`, `composer-2.5`) |
| `AUTOFIX_CODEX_MODEL` | No | CLI default | Model override when `AUTOFIX_FIXER=codex` (e.g. `gpt-5.3-codex`) |
| `AUTOFIX_CLAUDE_MODEL` | No | CLI default | Model override when `AUTOFIX_FIXER=claude` |

### Fixer Authentication

| Variable | Applies to | Description |
|---|---|---|
| `CURSOR_API_KEY` | `cursor` | Cursor CLI API key for headless / daemon use |
| `CODEX_API_KEY` | `codex` | OpenAI Codex CLI API key (alternative: `~/.codex/auth.json`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude` | Claude OAuth token (`claude setup-token`) |
| `ANTHROPIC_API_KEY` | `claude` | Anthropic API key for pay-as-you-go billing |

## Architecture

```mermaid
flowchart TD
    Start[Polling Loop] --> ListRepos[Auto-discover repos from App installations]
    ListRepos --> FetchComments["Fetch repo-level review comments from cursor[bot]"]
    FetchComments --> GroupByPR[Group comments by PR]
    GroupByPR --> Resolved["Filter out resolved threads (GraphQL)"]
    Resolved --> Parse[Parse bug details from BUGBOT_BUG_ID comments]
    Parse --> Filter[Filter out already-processed bugs via SQLite]
    Filter --> HasBugs{Unprocessed bugs?}
    HasBugs -->|No| Sleep[Sleep poll interval]
    HasBugs -->|Yes| FetchPR[Fetch PR details, skip closed PRs]
    FetchPR --> Clone[Clone/fetch repo, checkout PR head branch]
    Clone --> Fixer["Dispatch to selected BugFixer (claude / codex / cursor)"]
    Fixer --> Changes{Changes made?}
    Changes -->|No| Record[Record bugs as processed]
    Changes -->|Yes| Commit[git add + commit + push to PR head]
    Commit --> PostComment[Post fix summary comment on PR]
    PostComment --> Record
    Record --> Sleep
    Sleep --> Start
```

### Module Overview

| Module | Responsibility |
|---|---|
| `main.ts` | `FixoolyDaemon` polling loop, graceful shutdown, single-instance lock |
| `config.ts` | Loads and validates `AUTOFIX_*` environment variables (incl. `AUTOFIX_FIXER`) |
| `bugbotMonitor.ts` | Efficient repo-level scanning, resolved thread filtering, bug discovery |
| `bugParser.ts` | Parses `cursor[bot]` comment bodies into structured `BugbotBug` objects |
| `fixGenerator.ts` | Clones repos, builds the prompt, delegates fix generation to the injected `BugFixer`, then commits and pushes |
| `fixers/types.ts` | `BugFixer` interface and `FixerKind` definitions |
| `fixers/factory.ts` | `createFixer(config)` -- selects the implementation matching `AUTOFIX_FIXER` |
| `fixers/claudeFixer.ts` | Claude Code CLI (`claude -p`) backend with `--allowedTools` restrictions |
| `fixers/codexFixer.ts` | OpenAI Codex CLI (`codex exec`) backend with `--sandbox workspace-write` |
| `fixers/cursorFixer.ts` | Cursor CLI (`agent -p`) backend with `--force --trust` for headless use |
| `fixers/spawnRunner.ts` | Shared child-process runner (timeout, stdin piping, bounded stdout) |
| `fixers/outputParser.ts` | Extracts `COMMIT_MSG:` / `FIX_DETAIL:` markers from any backend's stdout (text / JSON / JSONL) |
| `githubClient.ts` | Octokit wrapper: GitHub App auth, repo-level comments, GraphQL threads, PR details |
| `state.ts` | SQLite tracking of processed bug IDs to prevent duplicates |
| `types.ts` | Shared TypeScript interfaces (incl. `Config` and `FixerKind`) |
| `logger.ts` | Structured logging with configurable levels |

## Running as a Service

### Docker (recommended)

```bash
docker compose up -d
```

Management commands:

```bash
docker compose ps          # Check status
docker compose logs -f     # View logs
docker compose restart     # Restart
docker compose down        # Stop
docker compose down -v     # Remove with data
```

### macOS (launchd)

To run as a native LaunchAgent (starts on login, restarts on failure), use the install script. See [deploy/README.md](deploy/README.md) for details.

From the project root:

```bash
npm run build
chmod +x deploy/install-daemon.sh
./deploy/install-daemon.sh
```

Logs: `~/.fixooly/logs/stdout.log` and `~/.fixooly/logs/stderr.log`.

## Related Projects

- [Claude Code BugHunter](https://github.com/Senna46/claude-code-bughunter) -- Self-hosted PR bug detection agent (detection + fix)

## License

MIT
