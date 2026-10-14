// Turns one tool call (live from `tool.call`, or read back from the
// transcript) into the ticket activity it represents, if any.
//
// Pure functions only: no `$`, so the tests can drive them directly.

import type { ActionKind, Ticket, TicketAction, TicketSystem } from '../types'

export type ToolCallRecord = {
  id: string
  tool: string
  input: Record<string, unknown>
  /** The result as the model read it; absent while in flight. */
  text?: string
  isError?: boolean
  at?: number
}

export type Activity = {
  key: string
  system: TicketSystem
  title?: string
  url?: string
  action: TicketAction
}

const READ_KINDS: readonly ActionKind[] = ['viewed']

const JIRA_KEY = /\b([A-Z][A-Z0-9_]{1,9}-\d+)\b/
const GH_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/
const JIRA_URL = /https:\/\/[\w.-]+\/browse\/([A-Z][A-Z0-9_]{1,9}-\d+)/

/** Every activity one tool call amounts to (most calls: zero or one). */
export function extract(call: ToolCallRecord): Activity[] {
  const tool = call.tool
  if (tool === 'Bash') return fromBash(call)
  if (tool === 'WebFetch') return fromWebFetch(call)
  if (!tool.startsWith('mcp__')) return []

  const [, server = '', name = ''] = tool.match(/^mcp__(.+?)__(.+)$/) ?? []
  if (/jira|atlassian/i.test(server) || /jira/i.test(name)) return fromJiraMcp(call, name)
  if (/github/i.test(server)) return fromGithubMcp(call, name)

  return []
}

// ---------------------------------------------------------------- GitHub MCP

type GhRule = { kind: ActionKind; verb: string; isPull?: boolean }

const GH_TOOLS: Record<string, GhRule> = {
  issue_read: { kind: 'viewed', verb: 'read issue' },
  get_issue: { kind: 'viewed', verb: 'read issue' },
  get_issue_comments: { kind: 'viewed', verb: 'read comments' },
  create_issue: { kind: 'created', verb: 'created issue' },
  update_issue: { kind: 'updated', verb: 'updated issue' },
  issue_write: { kind: 'updated', verb: 'updated issue' },
  add_issue_comment: { kind: 'commented', verb: 'commented' },
  update_issue_comment: { kind: 'commented', verb: 'edited a comment' },
  sub_issue_write: { kind: 'linked', verb: 'changed sub-issues' },
  pull_request_read: { kind: 'viewed', verb: 'read pull request', isPull: true },
  get_pull_request: { kind: 'viewed', verb: 'read pull request', isPull: true },
  create_pull_request: { kind: 'created', verb: 'opened pull request', isPull: true },
  update_pull_request: { kind: 'updated', verb: 'updated pull request', isPull: true },
  merge_pull_request: { kind: 'merged', verb: 'merged', isPull: true },
  update_pull_request_branch: { kind: 'updated', verb: 'updated branch', isPull: true },
  pull_request_review_write: { kind: 'reviewed', verb: 'reviewed', isPull: true },
  add_comment_to_pending_review: { kind: 'commented', verb: 'added review comment', isPull: true },
  add_reply_to_pull_request_comment: { kind: 'commented', verb: 'replied to review comment', isPull: true },
  request_copilot_review: { kind: 'reviewed', verb: 'requested Copilot review', isPull: true },
  enable_pr_auto_merge: { kind: 'updated', verb: 'enabled auto-merge', isPull: true },
  disable_pr_auto_merge: { kind: 'updated', verb: 'disabled auto-merge', isPull: true },
}

function fromGithubMcp(call: ToolCallRecord, name: string): Activity[] {
  let rule = GH_TOOLS[name]
  if (rule === undefined) return []
  const input = call.input

  // `issue_write` covers create and update under one name.
  if (name === 'issue_write' && input.method === 'create') rule = { kind: 'created', verb: 'created issue' }

  let { kind, verb } = rule
  if (input.state === 'closed') ({ kind, verb } = { kind: 'closed', verb: 'closed' })
  if (input.state === 'open' && kind === 'updated') ({ kind, verb } = { kind: 'reopened', verb: 'reopened' })
  if (name === 'pull_request_review_write' && typeof input.event === 'string') {
    verb = `reviewed (${String(input.event).toLowerCase().replace(/_/g, ' ')})`
  }
  if (typeof input.method === 'string' && kind === 'viewed' && input.method !== 'get') {
    verb = `${verb}: ${input.method.replace(/^get_?/, '').replace(/_/g, ' ')}`
  }

  const fromUrl = call.text?.match(GH_URL)
  const owner = str(input.owner) ?? fromUrl?.[1]
  const repo = str(input.repo) ?? fromUrl?.[2]
  const number =
    num(input.issue_number ?? input.issueNumber ?? input.pullNumber ?? input.pull_number ?? input.number) ??
    (kind === 'created' ? numberFromResult(call.text) : undefined)
  if (number === undefined) return []

  const key = ghKey(owner, repo, number)
  const title = str(input.title) ?? (kind === 'viewed' ? jsonField(call.text, 'title') : undefined)

  return [
    {
      key,
      system: 'github',
      title,
      url: owner && repo ? `https://github.com/${owner}/${repo}/${rule.isPull ? 'pull' : 'issues'}/${number}` : undefined,
      action: action(call, kind, verb, detailFrom(input)),
    },
  ]
}

// ------------------------------------------------------------------ Jira MCP

const JIRA_VERBS: [RegExp, ActionKind, string][] = [
  [/gettransition/i, 'viewed', 'read transitions'],
  [/transition/i, 'transitioned', 'transitioned'],
  [/comment/i, 'commented', 'commented'],
  [/worklog/i, 'updated', 'logged work'],
  [/link/i, 'linked', 'linked'],
  [/assign/i, 'assigned', 'assigned'],
  [/create/i, 'created', 'created'],
  [/edit|update/i, 'updated', 'updated'],
  [/get|read|fetch|view/i, 'viewed', 'read'],
]

function fromJiraMcp(call: ToolCallRecord, name: string): Activity[] {
  if (/search|jql|list|lookup|project|metadata|resources|user/i.test(name) && !/issue$/i.test(name)) return []
  const rule = JIRA_VERBS.find(([re]) => re.test(name))
  if (rule === undefined) return []
  const [, kind, baseVerb] = rule
  const input = call.input

  const fromInput =
    str(input.issueIdOrKey) ?? str(input.issueKey) ?? str(input.issue_key) ?? str(input.key) ?? findJiraKey(input)
  const key = fromInput ?? (kind === 'created' ? jsonField(call.text, 'key') ?? call.text?.match(JIRA_KEY)?.[1] : undefined)
  if (key === undefined || !JIRA_KEY.test(key)) return []

  let verb = baseVerb
  const transition = input.transition as { id?: unknown; name?: unknown } | undefined
  const target = str(transition?.name) ?? str(input.transitionName) ?? str(input.status) ?? str(input.transition_id)
  if (kind === 'transitioned' && target) verb = `moved to ${target}`
  if (kind === 'updated' && isRecord(input.fields)) {
    const fields = Object.keys(input.fields)
    if (fields.length > 0) verb = `updated ${fields.join(', ')}`
  }

  const title = str(input.summary) ?? (kind === 'viewed' ? jsonField(call.text, 'summary') : undefined)
  const site = str(input.cloudId)?.includes('.') ? str(input.cloudId) : undefined

  return [
    {
      key,
      system: 'jira',
      title,
      url: site ? `https://${site.replace(/^https?:\/\//, '')}/browse/${key}` : undefined,
      action: action(call, kind, verb, detailFrom(input)),
    },
  ]
}

// ---------------------------------------------------------------------- Bash

const GH_CLI: Record<string, ActionKind> = {
  view: 'viewed',
  create: 'created',
  comment: 'commented',
  edit: 'updated',
  close: 'closed',
  reopen: 'reopened',
  merge: 'merged',
  review: 'reviewed',
  ready: 'updated',
  lock: 'updated',
  unlock: 'updated',
  transfer: 'updated',
  pin: 'updated',
  unpin: 'updated',
  develop: 'linked',
  checkout: 'viewed',
  diff: 'viewed',
  checks: 'viewed',
}

const JIRA_CLI: [RegExp, ActionKind, string][] = [
  [/\b(move|transition)\b/, 'transitioned', 'transitioned'],
  [/\bcomment\b/, 'commented', 'commented'],
  [/\bassign\b/, 'assigned', 'assigned'],
  [/\bworklog\b/, 'updated', 'logged work'],
  [/\blink\b/, 'linked', 'linked'],
  [/\bcreate\b/, 'created', 'created'],
  [/\bedit\b/, 'updated', 'updated'],
  [/\bview\b/, 'viewed', 'read'],
]

function fromBash(call: ToolCallRecord): Activity[] {
  const command = str(call.input.command)
  if (command === undefined) return []
  const found: Activity[] = []

  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const words = tokenize(segment.trim())
    const at = words.findIndex(w => w === 'gh' || w.endsWith('/gh'))
    if (at >= 0) {
      const one = fromGhCli(call, words.slice(at + 1))
      if (one) found.push(one)
      continue
    }
    if (words[0] === 'jira' || words[0] === 'acli') {
      const one = fromJiraCli(call, segment)
      if (one) found.push(one)
    }
  }

  return found
}

function fromGhCli(call: ToolCallRecord, words: string[]): Activity | undefined {
  const [noun, sub, ...rest] = words
  if (noun !== 'issue' && noun !== 'pr') return undefined
  const kind = sub === undefined ? undefined : GH_CLI[sub]
  if (kind === undefined) return undefined
  const isPull = noun === 'pr'

  let owner: string | undefined
  let repo: string | undefined
  let number: number | undefined
  let title: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? ''
    if (word === '-R' || word === '--repo') {
      ;[owner, repo] = (rest[++i] ?? '').replace(/^github\.com\//, '').split('/')
    } else if (word.startsWith('--repo=')) {
      ;[owner, repo] = word.slice(7).split('/')
    } else if (word === '-t' || word === '--title') {
      title = rest[++i]
    } else if (/^#?\d+$/.test(word) && number === undefined) {
      number = Number(word.replace('#', ''))
    } else if (GH_URL.test(word)) {
      const m = word.match(GH_URL)!
      ;[owner, repo, number] = [m[1], m[2], Number(m[4])]
    }
  }

  if (number === undefined && kind === 'created') {
    const m = call.text?.match(GH_URL)
    if (m) [owner, repo, number] = [m[1], m[2], Number(m[4])]
  }
  // `gh pr view` / `gh pr comment` with no number targets the current branch's PR.
  if (number === undefined && isPull) {
    const m = call.text?.match(GH_URL)
    if (m && m[3] === 'pull') [owner, repo, number] = [m[1], m[2], Number(m[4])]
  }
  if (number === undefined) return undefined

  let verb: string = sub === 'checkout' ? 'checked out' : sub === 'checks' ? 'checked CI' : kind
  if (kind === 'reviewed') {
    if (rest.includes('--approve') || rest.includes('-a')) verb = 'approved'
    else if (rest.includes('--request-changes') || rest.includes('-r')) verb = 'requested changes'
  }
  if (kind === 'viewed' && sub === 'view') verb = isPull ? 'read pull request' : 'read issue'
  if (kind === 'created') verb = isPull ? 'opened pull request' : 'created issue'

  return {
    key: ghKey(owner, repo, number),
    system: 'github',
    title,
    url: owner && repo ? `https://github.com/${owner}/${repo}/${isPull ? 'pull' : 'issues'}/${number}` : undefined,
    action: action(call, kind, verb, `gh ${noun} ${sub}`),
  }
}

function fromJiraCli(call: ToolCallRecord, segment: string): Activity | undefined {
  const key = segment.match(JIRA_KEY)?.[1] ?? (/\bcreate\b/.test(segment) ? call.text?.match(JIRA_KEY)?.[1] : undefined)
  if (key === undefined) return undefined
  const rule = JIRA_CLI.find(([re]) => re.test(segment))
  if (rule === undefined) return undefined
  const [, kind, verb] = rule

  return { key, system: 'jira', action: action(call, kind, verb, segment.trim().slice(0, 80)) }
}

// ------------------------------------------------------------------ WebFetch

function fromWebFetch(call: ToolCallRecord): Activity[] {
  const url = str(call.input.url) ?? ''
  const gh = url.match(GH_URL)
  if (gh) {
    const [, owner, repo, type, n] = gh
    return [
      {
        key: ghKey(owner, repo, Number(n)),
        system: 'github',
        url: `https://github.com/${owner}/${repo}/${type}/${n}`,
        action: action(call, 'viewed', 'fetched page', 'WebFetch'),
      },
    ]
  }
  const jira = url.match(JIRA_URL)
  if (jira?.[1]) {
    return [{ key: jira[1], system: 'jira', url, action: action(call, 'viewed', 'fetched page', 'WebFetch') }]
  }

  return []
}

// ------------------------------------------------------------------- merging

/** Folds activities into the ticket list, newest-touched first; idempotent per action id. */
export function merge(tickets: readonly Ticket[], found: readonly Activity[]): Ticket[] {
  const byKey = new Map(tickets.map(t => [t.key, t] as const))
  let changed = false

  for (const one of found) {
    const known = byKey.get(one.key)
    const ticket: Ticket = known ?? { key: one.key, system: one.system, actions: [] }
    const at = ticket.actions.findIndex(a => a.id === one.action.id && a.verb === one.action.verb)
    // A call seen in flight is replaced by its finished record.
    const actions =
      at >= 0
        ? ticket.actions.map((a, i) => (i === at ? { ...a, ...one.action } : a))
        : [...ticket.actions, one.action]
    byKey.set(one.key, {
      ...ticket,
      title: one.title ?? ticket.title,
      url: one.url ?? ticket.url,
      actions,
      lastAt: Math.max(ticket.lastAt ?? 0, one.action.at ?? 0),
    })
    changed = true
  }

  if (!changed) return [...tickets]
  return [...byKey.values()].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

export function isWrite(kind: ActionKind): boolean {
  return !READ_KINDS.includes(kind)
}

/** A plain-text report, used by `/tickets summary`. */
export function summarize(tickets: readonly Ticket[], showReads: boolean): string {
  const shown = tickets.filter(t => showReads || t.actions.some(a => a.isWrite))
  if (shown.length === 0) {
    return showReads ? 'No Jira or GitHub items touched in this conversation yet.' : 'No Jira or GitHub items changed in this conversation yet.'
  }
  const lines: string[] = []
  for (const system of ['jira', 'github'] as const) {
    const group = shown.filter(t => t.system === system)
    if (group.length === 0) continue
    lines.push(system === 'jira' ? 'Jira' : 'GitHub')
    for (const t of group) {
      lines.push(`  ${t.key}${t.title ? ` — ${t.title}` : ''}${t.url ? ` (${t.url})` : ''}`)
      for (const a of t.actions) {
        if (!showReads && !a.isWrite) continue
        lines.push(`    - ${a.verb}${a.isError ? ' (failed)' : ''}${a.detail ? ` · ${a.detail}` : ''}`)
      }
    }
  }

  return lines.join('\n')
}

// ------------------------------------------------------------------- helpers

function action(call: ToolCallRecord, kind: ActionKind, verb: string, detail?: string): TicketAction {
  return {
    id: call.id,
    kind,
    verb,
    tool: call.tool,
    detail,
    isWrite: isWrite(kind),
    isError: call.isError === true,
    isPending: call.text === undefined && call.isError === undefined,
    at: call.at,
  }
}

function ghKey(owner: string | undefined, repo: string | undefined, number: number): string {
  return owner && repo ? `${owner}/${repo}#${number}` : `#${number}`
}

function detailFrom(input: Record<string, unknown>): string | undefined {
  const labels = Array.isArray(input.labels) ? input.labels.filter(l => typeof l === 'string') : []
  const assignees = Array.isArray(input.assignees) ? input.assignees.filter(l => typeof l === 'string') : []
  const parts = [
    labels.length ? `labels: ${labels.join(', ')}` : undefined,
    assignees.length ? `assignees: ${assignees.join(', ')}` : undefined,
    typeof input.body === 'string' ? `“${oneLine(input.body)}”` : undefined,
    typeof input.comment === 'string' ? `“${oneLine(input.comment)}”` : undefined,
    typeof input.commentBody === 'string' ? `“${oneLine(input.commentBody)}”` : undefined,
  ].filter(Boolean)

  return parts.length ? parts.join(' · ') : undefined
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat
}

function numberFromResult(text: string | undefined): number | undefined {
  const url = text?.match(GH_URL)
  if (url) return Number(url[4])
  const field = text?.match(/"number"\s*:\s*(\d+)/)
  return field ? Number(field[1]) : undefined
}

function jsonField(text: string | undefined, field: string): string | undefined {
  const m = text?.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,200})"`))
  if (!m?.[1]) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1]
  }
}

function findJiraKey(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value === 'string') {
      const m = value.match(new RegExp(`^${JIRA_KEY.source}$`))
      if (m) return m[1]
    }
  }
  return undefined
}

function tokenize(text: string): string[] {
  const words: string[] = []
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
    words.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return words
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
