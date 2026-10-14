import { describe, expect, mock, test } from 'claude-code/testing'

import { extract, merge, summarize } from '../hooks/extract'

const SURFACES = ['terminal', 'desktop'] as const

const PANE_PROPS = {
  title: 'Tickets',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

describe('extract', () => {
  test('GitHub MCP comment', async () => {
    const [found] = extract({
      id: 't1',
      tool: 'mcp__github__add_issue_comment',
      input: { owner: 'acme', repo: 'web', issue_number: 42, body: 'Fixed in #43' },
      text: '{"id":1}',
    })
    expect(found?.key).toBe('acme/web#42')
    expect(found?.action.kind).toBe('commented')
    expect(found?.action.isWrite).toBe(true)
  })

  test('GitHub MCP issue_write close and create', async () => {
    const [closed] = extract({
      id: 't2',
      tool: 'mcp__github__issue_write',
      input: { method: 'update', owner: 'acme', repo: 'web', issue_number: 7, state: 'closed' },
      text: 'ok',
    })
    expect(closed?.action.kind).toBe('closed')

    const [created] = extract({
      id: 't3',
      tool: 'mcp__github__issue_write',
      input: { method: 'create', owner: 'acme', repo: 'web', title: 'Crash on load' },
      text: '{"html_url":"https://github.com/acme/web/issues/88","number":88}',
    })
    expect(created?.key).toBe('acme/web#88')
    expect(created?.title).toBe('Crash on load')
  })

  test('Jira MCP transition and edit', async () => {
    const [moved] = extract({
      id: 'j1',
      tool: 'mcp__atlassian__transitionJiraIssue',
      input: { cloudId: 'acme.atlassian.net', issueIdOrKey: 'PROJ-12', transition: { id: '31', name: 'In Review' } },
      text: 'ok',
    })
    expect(moved?.key).toBe('PROJ-12')
    expect(moved?.action.verb).toBe('moved to In Review')
    expect(moved?.url).toBe('https://acme.atlassian.net/browse/PROJ-12')

    const [edited] = extract({
      id: 'j2',
      tool: 'mcp__atlassian__editJiraIssue',
      input: { issueIdOrKey: 'PROJ-12', fields: { priority: {}, labels: [] } },
      text: 'ok',
    })
    expect(edited?.action.verb).toBe('updated priority, labels')

    expect(extract({ id: 'j3', tool: 'mcp__atlassian__searchJiraIssuesUsingJql', input: { jql: 'x' } })).toEqual([])
  })

  test('gh and jira CLIs through Bash', async () => {
    const found = extract({
      id: 'b1',
      tool: 'Bash',
      input: { command: 'gh pr review 15 --approve -R acme/api && gh issue close 3 --repo acme/api' },
      text: '',
    })
    expect(found.map(f => [f.key, f.action.verb])).toEqual([
      ['acme/api#15', 'approved'],
      ['acme/api#3', 'closed'],
    ])

    const [created] = extract({
      id: 'b2',
      tool: 'Bash',
      input: { command: 'gh pr create --title "Add cache" --body x' },
      text: 'https://github.com/acme/api/pull/16\n',
    })
    expect(created?.key).toBe('acme/api#16')
    expect(created?.title).toBe('Add cache')

    const [jira] = extract({ id: 'b3', tool: 'Bash', input: { command: 'jira issue move PROJ-9 "Done"' }, text: '' })
    expect(jira?.action.kind).toBe('transitioned')

    expect(extract({ id: 'b4', tool: 'Bash', input: { command: 'gh pr list' }, text: '' })).toEqual([])
  })

  test('merge is idempotent per call and summary hides views', async () => {
    const view = extract({
      id: 'v1',
      tool: 'mcp__github__issue_read',
      input: { method: 'get', owner: 'acme', repo: 'web', issue_number: 1 },
      text: '{"title":"Login broken"}',
    })
    const once = merge([], view)
    expect(merge(once, view)).toEqual(once)
    expect(once[0]?.title).toBe('Login broken')
    expect(summarize(once, false)).toContain('No Jira or GitHub items changed')
    expect(summarize(once, true)).toContain('acme/web#1')
  })
})

test('a tracked call shows in the band and the pane, on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('tool.call', () => ({ result: { id: 1 }, text: '{"id":1}' }))

  await $.tool.call({
    tool: 'mcp__github__add_issue_comment',
    tool_use_id: 'call-1',
    owner: 'acme',
    repo: 'web',
    issue_number: 42,
    body: 'Looks good',
  })

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'ticket-tracker', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect((await band.find({ key: 'ticket-tracker-toggle' }))?.text).toContain('Show tickets')
    await band.unmount()

    const pane = await $.ui.mount({
      plugin: 'ticket-tracker',
      surface,
      component: 'Pane',
      requestId: 'ticket-tracker',
      props: PANE_PROPS,
    })
    expect(await pane.find({ text: /acme\/web#42/ })).toBeDefined()
    expect(await pane.find({ text: /Looks good/ })).toBeUndefined()

    await pane.press({ key: 'row:acme/web#42' })
    expect(await pane.find({ text: /Looks good/ })).toBeDefined()
    await pane.press({ key: 'row:acme/web#42' })
    await pane.unmount()
  }
})
