# ticket-tracker

Keeps a running record of every Jira issue and GitHub issue or pull request touched in the current Claude Code conversation, and of what was done to each: created, commented, edited, transitioned, closed, merged, reviewed. You can see it in a collapsible pane that you toggle with a button or a command, in the terminal and in the desktop app.

```
Tickets: 2 changed, 1 viewed  [ Hide tickets ]

┌ Tickets ─────────────────────────────────────────────┐
│ [ Changes only ] [ Expand all ]                      │
│                                                      │
│ Jira                                                 │
│ ▸ PROJ-123 Checkout times out · 2 actions, last: moved to In Review
│                                                      │
│ GitHub                                               │
│ ▾ acme/web#42 Fix retry loop · 2 actions             │
│     https://github.com/acme/web/pull/42              │
│     ● opened pull request · github:create_pull_request
│     ● commented · "Rebased on main" · Bash           │
└──────────────────────────────────────────────────────┘
```

## Install

```bash
claude plugin marketplace add ilionblaze/agora
claude plugin install ticket-tracker@agora
```

## Use

- **Band above the prompt**: once something has been touched, a single line shows the counts and a **Show tickets / Hide tickets** button that toggles the pane.
- **`/tickets`**: toggles the pane.
- **In the pane**: press a row to expand or collapse its actions. **Changes only / All activity** switches between write actions only and views too. **Expand all / Collapse all** does what it says. Close the pane with its close mark, `ctrl+x x`, or the toggle.

| Command | |
| --- | --- |
| `/tickets` | Toggle the pane |
| `/tickets summary` | Print the changes as text in the transcript (`/tickets summary all` includes views). Claude reads it too, so you can follow up with "post that as a status update". |
| `/tickets all` · `/tickets changes` | Show or hide read-only activity in the pane |
| `/tickets rescan` | Rebuild the list from the conversation history |
| `/tickets clear` | Forget everything tracked so far |

## What it recognizes

The list is built from the tool calls in the conversation. When a session starts (including `--resume` and `--continue`) the plugin reads the history the session already has, and after that it records each tool call as it finishes, from the main conversation and from subagents alike.

| Source | Recognized |
| --- | --- |
| GitHub MCP server (`mcp__github__*`) | issue read/create/update/close/reopen, comments, sub-issues; pull request read/create/update/merge, reviews, review comments and replies, branch updates, auto-merge, Copilot review requests |
| Atlassian / Jira MCP servers (any server or tool whose name contains `jira` or `atlassian`) | get, create, edit (with the fields changed), transition (with the target status), comment, assign, link, worklog |
| `gh` CLI via Bash | `gh issue|pr view/create/comment/edit/close/reopen/merge/review/ready/checkout/...`, including `-R owner/repo`, URLs, and chained commands. Created numbers are read from the output URL. |
| `jira` / `acli` CLIs via Bash | any command containing an issue key, classified by its verb (move/transition, comment, assign, edit, create, view) |
| WebFetch | GitHub issue/PR URLs and Jira `/browse/KEY` URLs, as views |

Searches and listings (JQL searches, `gh pr list`) aren't recorded because they don't target a specific item. Failed calls stay in the list, marked `✗ (failed)`, so you can see what didn't go through.

## Limits

- `gh` commands that don't name a repository are recorded as `#123` (the current repository).
- Only the newest 4096 messages are read back on session start.
- The pane opens docked beside the transcript in fullscreen terminals and inline above the prompt otherwise. In the desktop app it opens in the app's pane area.

## Development

```bash
claude --plugin-dir ./plugins/ticket-tracker   # load from disk; saves hot-reload
claude plugin validate ./plugins/ticket-tracker
claude plugin test ./plugins/ticket-tracker
```

- `hooks/register.tsx` holds the hooks: `tool.call` records activity, `session.start` backfills from history, `ui.render` draws the band and the pane, and `command.run` answers `/tickets`.
- `hooks/extract.ts` holds the pure logic that turns one tool call into ticket activity. To recognize a new tool or CLI, add it there and add a case to `tests/tracker.test.tsx`.
- `types/index.d.ts` is the state contract (`$.state` keys under `ticket-tracker`).

The function-hooks plugin API is in early access and may change between Claude Code releases.
