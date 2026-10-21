import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { checksLabel, parseAheadBehind, parseGh, parsePorcelain, parsePrUrls, prLabel, pushLabel, sessionPr } from '../hooks/parse'

const BARE_PORCELAIN = [
  'worktree /src/repo.git',
  'bare',
  '',
  'worktree /src/repo/main',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/master',
  '',
  'worktree /src/repo/feat-x',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feat/x',
  '',
].join('\n')

const PORCELAIN = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/master',
  '',
  'worktree /repo/.claude/worktrees/feat-x',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feat/x',
  '',
].join('\n')

test('porcelain parsing keeps the bare entry flagged so it can be skipped', () => {
  expect(parsePorcelain(BARE_PORCELAIN)).toEqual([
    { path: '/src/repo.git', branch: null, isBare: true },
    { path: '/src/repo/main', branch: 'master', isBare: false },
    { path: '/src/repo/feat-x', branch: 'feat/x', isBare: false },
  ])
})

test('gh JSON maps to a label for each state', () => {
  const pr = (fields: Record<string, unknown>) =>
    prLabel(parseGh(0, JSON.stringify({ number: 12, state: 'OPEN', isDraft: false, reviewDecision: '', ...fields }), ''))
  expect(pr({ state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z' })).toEqual({ text: '#12 merged', tone: 'good' })
  expect(pr({ state: 'CLOSED' })).toEqual({ text: '#12 closed', tone: 'dim' })
  expect(pr({ isDraft: true })).toEqual({ text: '#12 draft', tone: 'dim' })
  expect(pr({ reviewDecision: 'APPROVED' })).toEqual({ text: '#12 approved', tone: 'good' })
  expect(pr({ reviewDecision: 'CHANGES_REQUESTED' })).toEqual({ text: '#12 changes requested', tone: 'bad' })
  expect(pr({ reviewDecision: 'REVIEW_REQUIRED' })).toEqual({ text: '#12 review required', tone: 'warn' })
  expect(pr({ reviewDecision: null })).toEqual({ text: '#12 review required', tone: 'warn' })
  expect(prLabel(parseGh(1, '', 'no pull requests found for branch "x"'))).toEqual({ text: 'no PR', tone: 'dim' })
  expect(prLabel(parseGh(1, '', 'HTTP 401: Bad credentials'))).toEqual({ text: 'PR ?', tone: 'dim' })
  expect(prLabel(parseGh(0, 'not json', ''))).toEqual({ text: 'PR ?', tone: 'dim' })
})

test('rev-list counts map to a pushed label', () => {
  expect(pushLabel(parseAheadBehind('0\t0\n'))).toEqual({ text: 'pushed', tone: 'good' })
  expect(pushLabel(parseAheadBehind('0\t3\n'))).toEqual({ text: '↑3 unpushed', tone: 'warn' })
  expect(pushLabel(parseAheadBehind('2\t0\n'))).toEqual({ text: '↓2 behind', tone: 'warn' })
  expect(pushLabel(parseAheadBehind('2\t3\n'))).toEqual({ text: '↑3 ↓2', tone: 'warn' })
  expect(pushLabel(null)).toEqual({ text: 'not pushed', tone: 'warn' })
})

type GhRepoView = (n: number) => Record<string, unknown>

const fakeRepo = (on: On, ghCalls: string[], ghRepoView?: GhRepoView) => {
  on('session.cwd', async () => ({ value: '/repo' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    const args = e.argv.join(' ')
    const out = (stdout: string, exitCode = 0, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (args.includes('worktree list')) return out(PORCELAIN)
    if (args.includes('--show-toplevel')) return out('/repo\n')
    if (args.includes('--git-common-dir')) return out('/repo/.git\n')
    if (args.includes('rev-list')) return out(e.init?.cwd === '/repo' ? '0\t0\n' : '0\t2\n')
    if (e.argv[0] === 'gh' && ghRepoView && e.argv.includes('--repo')) return out(JSON.stringify(ghRepoView(Number(e.argv[3]))))
    if (e.argv[0] === 'gh') {
      ghCalls.push(e.argv[3] ?? '')
      if (e.argv[3] === 'master') return out('', 1, 'no pull requests found for branch "master"')
      return out(JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', url: 'https://x/7' }))
    }
    return out('', 1)
  })
}

const PANE_PROPS = {
  title: 'Worktree PRs',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

test('/prs opens the pane listing every worktree', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  const ghCalls: string[] = []
  fakeRepo(on, ghCalls)
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })

  const ran = await $.command.run({
    command: 'prs',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await clock.advance(0)

  expect(opened).toEqual(['pr-status'])
  expect(ran.text).toBe('Session PRs pane opened.')
  expect(ghCalls.sort()).toEqual(['feat/x', 'master'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pr-status', surface, component: 'Pane', requestId: 'pr-status', props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /repo \(main\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#7 approved/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↑2 unpushed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /no PR/ })).toBeDefined()
    await ui.unmount()
  }

  // A second refresh inside 60s reuses the gh answers
  await $.command.run({
    command: 'prs',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await clock.advance(0)
  expect(ghCalls.length).toBe(2)
})

test('band shows the current worktree only', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  fakeRepo(on, [])
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)

  await $.command.run({
    command: 'prs',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await clock.advance(0)

  const ui = await $.ui.mount({
    plugin: 'pr-status',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: /^no PR$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^pushed$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /#7/ })).toBeUndefined()
  await ui.unmount()
})

test('PR URLs are read from gh output, deduplicated, ignoring pull/new links', () => {
  const out = [
    'https://github.com/crumbl/crumbl/pull/42100',
    'a pull request for branch "x" into branch "master" already exists:',
    'https://github.com/crumbl/crumbl/pull/42100',
    'https://github.com/crumbl/crumbl/pull/new/feat-x',
  ].join('\n')
  expect(parsePrUrls(out)).toEqual([{ repo: 'crumbl/crumbl', number: 42100 }])
})

test('checks rollup ignores cancelled and skipped runs', () => {
  const run = (conclusion: string | null, status = 'COMPLETED') => ({ __typename: 'CheckRun', status, conclusion })
  expect(checksLabel([])).toBeNull()
  expect(checksLabel([run('SUCCESS'), run('CANCELLED'), run('SKIPPED')])).toEqual({ text: '✓ checks', tone: 'good' })
  expect(checksLabel([run('SUCCESS'), run(null, 'IN_PROGRESS')])).toEqual({ text: '…1 running', tone: 'warn' })
  expect(checksLabel([run('FAILURE'), run(null, 'IN_PROGRESS')])).toEqual({ text: '✗1 failing', tone: 'bad' })
  expect(checksLabel([{ __typename: 'StatusContext', state: 'ERROR' }])).toEqual({ text: '✗1 failing', tone: 'bad' })
})

test('an open PR with conflicts reads as conflicts; a merged one drops its checks', () => {
  const ref = { repo: 'o/r', number: 5 }
  const json = (fields: Record<string, unknown>) =>
    JSON.stringify({ number: 5, state: 'OPEN', title: 'T', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }], ...fields })
  expect(sessionPr(ref, 0, json({ mergeStateStatus: 'DIRTY' })).state).toEqual({ text: '#5 conflicts', tone: 'bad' })
  const merged = sessionPr(ref, 0, json({ state: 'MERGED', mergeStateStatus: 'DIRTY' }))
  expect(merged.state).toEqual({ text: '#5 merged', tone: 'good' })
  expect(merged.checks).toBeNull()
  expect(merged.isFinal).toBe(true)
})

test('every PR a session creates shows in the band with live status', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const viewed: string[] = []
  let state = 'OPEN'
  fakeRepo(on, [], n => {
    viewed.push(String(n))
    return { number: n, title: `PR ${n}`, state: n === 1 ? state : 'OPEN', mergedAt: null, reviewDecision: 'REVIEW_REQUIRED', url: `https://github.com/o/r/pull/${n}`, statusCheckRollup: [] }
  })
  on('session.id', async () => ({ value: 'sess-1' }))
  mock.store(on)
  on('tool.call', async (_$, e) => {
    const command = String((e as { command?: string }).command)
    const n = command.includes('second') ? 2 : 1
    const isExisting = command.includes('again')
    const stdout = isExisting ? '' : `https://github.com/o/r/pull/${n}\n`
    const stderr = isExisting ? `a pull request for branch "x" already exists:\nhttps://github.com/o/r/pull/${n}\n` : ''
    return { result: { stdout, stderr, interrupted: false }, text: stdout + stderr, ...(isExisting ? { isError: true } : {}) } as never
  })

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title first' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title second' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title again' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await clock.advance(0)

  const band = () =>
    $.ui.mount({
      plugin: 'pr-status',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
  let ui = await band()
  expect(await ui.find({ type: 'Text', text: /^#1 review required$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#2 review required$/ })).toBeDefined()
  await ui.unmount()

  state = 'MERGED'
  await clock.advance(60_000)
  ui = await band()
  expect(await ui.find({ type: 'Text', text: /^#1 merged$/ })).toBeDefined()
  await ui.unmount()

  const before = viewed.length
  await clock.advance(60_000)
  expect(viewed.slice(before)).toEqual(['2'])
})
