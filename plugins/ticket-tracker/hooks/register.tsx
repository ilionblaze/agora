import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ticket, TicketAction } from '../types'
import { extract, merge, summarize } from './extract'
import type { ToolCallRecord } from './extract'

const PANE = 'ticket-tracker'
const TITLE = 'Tickets'

const tickets = atom({ plugin: 'ticket-tracker', key: 'tickets' } as const, [])
const expanded = atom({ plugin: 'ticket-tracker', key: 'expanded' } as const, [])
const showReads = atom({ plugin: 'ticket-tracker', key: 'showReads' } as const, false)
const isOpen = atom({ plugin: 'ticket-tracker', key: 'isOpen' } as const, false)

const USAGE = [
  '/tickets           toggle the Tickets pane',
  '/tickets open      open the pane (no change if already open)',
  '/tickets close     close the pane (no change if already closed)',
  '/tickets summary   print what was touched (changes only); `summary all` includes views',
  '/tickets all       show views as well as changes in the pane',
  '/tickets changes   show only changes in the pane',
  '/tickets rescan    rebuild the list from the conversation history',
  '/tickets clear     forget everything tracked so far',
].join('\n')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tickets',
      description: 'Toggle the pane of Jira / GitHub items touched in this conversation',
      argumentHint: '[open|close|summary|all|changes|rescan|clear]',
    })
    await rescan($)

    return next(e)
  })

  // Only `summary` answers with text: a command's text becomes a transcript
  // row the model reads, so every other subcommand replies with a toast,
  // which the person sees and the model never does.
  on('command.run', { command: 'tickets' }, async ($, e) => {
    const [arg = '', more = ''] = e.args.trim().toLowerCase().split(/\s+/)

    switch (arg) {
      case 'summary':
        return { text: summarize(await read($, tickets), more === 'all') }
      case '':
      case 'toggle':
        await toggle($)
        break
      case 'open':
        await open($)
        break
      case 'close':
        await close($)
        break
      case 'all':
      case 'changes':
        await update($, showReads, () => arg === 'all')
        $.ui.toast(arg === 'all' ? 'Tickets: showing views and changes.' : 'Tickets: showing changes only.')
        break
      case 'rescan': {
        await update($, tickets, () => [])
        const count = await rescan($)
        $.ui.toast(`Tickets: rebuilt from history, ${count} item${count === 1 ? '' : 's'}.`)
        break
      }
      case 'clear':
        await update($, tickets, () => [])
        await update($, expanded, () => [])
        $.ui.toast('Tickets: cleared the tracked items.')
        break
      default:
        $.ui.toast(USAGE, { timeoutMs: 12_000 })
    }

    return {}
  })

  // Every tool call, in the main conversation and in subagents.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      const found = extract({
        id: e.tool_use_id ?? `${e.tool}:${await $.clock.now()}`,
        tool: String(e.tool),
        input: e as unknown as Record<string, unknown>,
        text: ran.deny ?? (typeof ran.text === 'string' ? ran.text : textOf(ran.result)),
        isError: ran.deny !== undefined || ran.isError === true,
        at: await $.clock.now(),
      })
      if (found.length > 0) await update($, tickets, list => merge(list, found))
    } catch (error) {
      $.ui.log(`ticket-tracker: could not record ${String(e.tool)}: ${String(error)}`)
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The one-line band above the prompt: a count and the toggle button.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tickets)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = await read($, isOpen)
    const changed = list.filter(t => t.actions.some(a => a.isWrite)).length

    return (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>
          Tickets: {changed} changed, {list.length - changed} viewed
        </Text>
        <Button
          key="ticket-tracker-toggle"
          label={shown ? 'Hide tickets' : 'Show tickets'}
          onPress={() => toggle($)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, tickets)
    const open = new Set(await read($, expanded))
    const withReads = await read($, showReads)

    const list = withReads ? all : all.filter(t => t.actions.some(a => a.isWrite))
    const hidden = all.length - list.length
    const isAllOpen = list.length > 0 && list.every(t => open.has(t.key))

    const toggleRow = (key: string) =>
      update($, expanded, keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]))

    const groups = (['jira', 'github'] as const)
      .map(system => ({ system, items: list.filter(t => t.system === system) }))
      .filter(g => g.items.length > 0)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button
            key="filter"
            label={withReads ? 'All activity' : 'Changes only'}
            onPress={() => update($, showReads, v => !v)}
          />
          <Button
            key="expand"
            label={isAllOpen ? 'Collapse all' : 'Expand all'}
            onPress={() => update($, expanded, () => (isAllOpen ? [] : list.map(t => t.key)))}
          />
        </Box>

        {list.length === 0 && (
          <Text dimColor>
            {hidden > 0
              ? `${hidden} item${hidden === 1 ? '' : 's'} viewed, none changed. Press "Changes only" to see them.`
              : 'No Jira or GitHub items touched yet.'}
          </Text>
        )}

        {groups.map(group => (
          <Box key={`group:${group.system}`} flexDirection="column" marginTop={1}>
            <Text bold>{group.system === 'jira' ? 'Jira' : 'GitHub'}</Text>
            {group.items.map(ticket => (
              ticketRow({
                Box,
                Button,
                Text,
                ticket,
                isExpanded: open.has(ticket.key),
                withReads,
                onToggle: () => toggleRow(ticket.key),
              })
            ))}
          </Box>
        ))}

        {hidden > 0 && list.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>
              +{hidden} viewed only (hidden)
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

type Elements = ReturnType<EngineInterface['ui']['resolve']>

function ticketRow(props: {
  Box: Elements['Box']
  Button: Elements['Button']
  Text: Elements['Text']
  ticket: Ticket
  isExpanded: boolean
  withReads: boolean
  onToggle: () => unknown
}) {
  const { Box, Button, Text, ticket, isExpanded, withReads, onToggle } = props
  const actions = ticket.actions.filter(a => withReads || a.isWrite)
  const last = actions.at(-1)
  const hasFailed = actions.some(a => a.isError)

  return (
    <Box key={`ticket:${ticket.key}`} flexDirection="column">
      <Button key={`row:${ticket.key}`} plain onPress={onToggle}>
        {isExpanded ? '▾ ' : '▸ '}
        <Text bold color={hasFailed ? 'error' : undefined}>
          {ticket.key}
        </Text>
        {ticket.title ? ` ${ticket.title}` : ''}
        <Text dimColor>
          {' '}
          · {actions.length} action{actions.length === 1 ? '' : 's'}
          {last && !isExpanded ? `, last: ${last.verb}` : ''}
        </Text>
      </Button>
      {isExpanded && (
        <Box flexDirection="column" paddingLeft={4}>
          {ticket.url && <Text dimColor>{ticket.url}</Text>}
          {actions.map(a => (
            <Text color={colorOf(a)}>
              {a.isError ? '✗ ' : a.isWrite ? '● ' : '○ '}
              {a.verb}
              {a.isError ? ' (failed)' : ''}
              <Text dimColor>
                {a.detail ? ` · ${a.detail}` : ''} · {shortTool(a.tool)}
              </Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function colorOf(a: TicketAction): string | undefined {
  if (a.isError) return 'error'
  if (a.kind === 'created' || a.kind === 'merged') return 'success'
  if (a.kind === 'closed') return 'merged'
  if (a.kind === 'transitioned') return 'suggestion'
  return undefined
}

function shortTool(tool: string): string {
  return tool.replace(/^mcp__([^_]+(?:_[^_]+)*)__/, '$1:')
}

async function open($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  await update($, isOpen, () => true)
  if (!opened.isPlaced) $.ui.toast(`Tickets: the pane could not be shown here (${opened.reason}).`)
  return opened.isPlaced
}

async function close($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  await update($, isOpen, () => false)
}

/** Opens the pane when closed, closes it when open; says whether it is open now. */
async function toggle($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()
  if (panes.some(p => p.id === PANE)) {
    await close($)
    return false
  }
  await open($)
  return true
}

/** Reads the conversation so far and folds every ticket call it holds into the list. */
async function rescan($: EngineInterface): Promise<number> {
  const messages = await $.session.messages()
  const found = messages.flatMap(m =>
    m.toolUses.flatMap(use => {
      const call: ToolCallRecord = {
        id: use.tool_use_id,
        tool: use.tool,
        input: use.input,
        text: typeof use.text === 'string' ? use.text : textOf(use.result),
        isError: use.isError === true,
      }
      return extract(call)
    }),
  )
  const list = await update($, tickets, current => merge(current, found))

  return list.length
}

function textOf(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result).slice(0, 20_000)
  } catch {
    return undefined
  }
}
