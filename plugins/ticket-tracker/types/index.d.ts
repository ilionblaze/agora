export type TicketSystem = 'github' | 'jira'

export type ActionKind =
  | 'viewed'
  | 'created'
  | 'updated'
  | 'commented'
  | 'closed'
  | 'reopened'
  | 'transitioned'
  | 'assigned'
  | 'linked'
  | 'merged'
  | 'reviewed'

export type TicketAction = {
  /** The tool_use_id of the call that did it. */
  id: string
  kind: ActionKind
  /** What happened, in words: "commented", "moved to In Review". */
  verb: string
  /** The tool that did it: `mcp__github__add_issue_comment`, `Bash`. */
  tool: string
  detail?: string
  isWrite: boolean
  isError: boolean
  isPending: boolean
  /** Epoch ms when seen live; absent for calls read back from history. */
  at?: number
}

export type Ticket = {
  /** `owner/repo#12`, `#12` (repo unknown) or `PROJ-123`. */
  key: string
  system: TicketSystem
  title?: string
  url?: string
  actions: TicketAction[]
  lastAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'ticket-tracker': {
      tickets: Ticket[]
      /** Keys of the tickets whose action lists are expanded in the pane. */
      expanded: string[]
      /** Show read-only activity (views) as well as changes. */
      showReads: boolean
      isOpen: boolean
    }
  }
}
