import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Label, PrRef, PrView, SessionPr, Tone, WorktreeStatus } from '../types'
import {
  basename,
  dirname,
  mergeRefs,
  parseAheadBehind,
  parseGh,
  parsePorcelain,
  parsePrUrls,
  prLabel,
  pushLabel,
  refKey,
  sessionPr,
} from './parse'

const PANE = 'pr-status'
const GH_TTL = 60_000
const POLL = 5 * 60_000
const SESSION_POLL = 60_000
const STORE_TTL = 14 * 24 * 60 * 60_000
const PR_FIELDS = 'number,title,state,isDraft,reviewDecision,mergedAt,url,mergeStateStatus,statusCheckRollup'

const view = atom({ plugin: 'pr-status', key: 'view' } as const, { list: [], current: null, error: null, session: [] })
const refs = atom({ plugin: 'pr-status', key: 'refs' } as const, [] as PrRef[])

// gh answers per branch, so a refresh inside GH_TTL reuses them
const ghCache = new Map<string, { at: number; pr: Label; url: string | null }>()
let isRefreshing = false
let isRefreshingSession = false
let isSessionPolling = false

/** Polls session PRs once there are any to watch. */
const ensureSessionPoll = ($: EngineInterface) => {
  if (isSessionPolling) return
  isSessionPolling = true
  $.clock.every(SESSION_POLL, () => void refreshSession($))
}

const run = ($: EngineInterface, argv: string[], cwd: string, timeoutMs = 10_000) =>
  $.process.run(argv, { cwd, timeoutMs })

const storeKey = async ($: EngineInterface) => `session:${await $.session.id()}`

async function lookupPr($: EngineInterface, branch: string, cwd: string, now: number, force: boolean) {
  const hit = ghCache.get(branch)
  if (hit && !force && now - hit.at < GH_TTL) return hit
  let entry: { at: number; pr: Label; url: string | null }
  try {
    const out = await run(
      $,
      ['gh', 'pr', 'view', branch, '--json', 'number,state,isDraft,reviewDecision,mergedAt,url'],
      cwd,
    )
    const lookup = parseGh(out.exitCode, out.stdout, out.stderr)
    entry = { at: now, pr: prLabel(lookup), url: lookup.kind === 'pr' ? (lookup.pr.url ?? null) : null }
  } catch {
    entry = { at: now, pr: prLabel({ kind: 'error' }), url: null }
  }
  ghCache.set(branch, entry)
  return entry
}

async function pushOf($: EngineInterface, cwd: string): Promise<Label> {
  try {
    const out = await run($, ['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd)
    return pushLabel(out.exitCode === 0 ? parseAheadBehind(out.stdout) : null)
  } catch {
    return { text: 'push ?', tone: 'dim' }
  }
}

async function load($: EngineInterface, force: boolean): Promise<Omit<PrView, 'session'>> {
  const cwd = await $.session.cwd()
  const listed = await run($, ['git', 'worktree', 'list', '--porcelain'], cwd)
  if (listed.exitCode !== 0) return { list: [], current: null, error: 'Not in a git repository.' }

  const [top, common] = await Promise.all([
    run($, ['git', 'rev-parse', '--show-toplevel'], cwd),
    run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd),
  ])
  const current = top.exitCode === 0 ? top.stdout.trim() : null
  // The main worktree holds the common .git dir; in a bare layout none does
  const mainPath = common.exitCode === 0 ? dirname(common.stdout.trim()) : null
  const now = await $.clock.now()

  const entries = parsePorcelain(listed.stdout).filter(entry => !entry.isBare)
  const list = await Promise.all(
    entries.map(async (entry): Promise<WorktreeStatus> => {
      const [push, gh] = await Promise.all([
        pushOf($, entry.path),
        entry.branch
          ? lookupPr($, entry.branch, entry.path, now, force)
          : Promise.resolve({ pr: { text: 'detached', tone: 'dim' as Tone }, url: null }),
      ])
      return {
        path: entry.path,
        name: basename(entry.path),
        branch: entry.branch,
        isMain: entry.path === mainPath,
        push,
        pr: gh.pr,
        url: gh.url,
      }
    }),
  )
  return { list, current, error: null }
}

/** Adds PRs to this session's list and saves it to `$.store` so a reload or resume keeps it. */
async function addRefs($: EngineInterface, found: PrRef[]) {
  if (found.length === 0) return
  const before = await read($, refs)
  const merged = mergeRefs(before, found)
  if (merged.length === before.length) return
  await update($, refs, () => merged)
  await $.store.set(await storeKey($), { at: await $.clock.now(), refs: merged })
  ensureSessionPoll($)
  scheduleSession($, true)
}

async function refresh($: EngineInterface, force = false) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const next = await load($, force).catch(
      (err: unknown): Omit<PrView, 'session'> => ({
        list: [],
        current: null,
        error: `Could not read worktrees: ${String(err)}`,
      }),
    )
    await update($, view, v => ({ ...v, ...next }))
    // The current worktree's PR counts as one of this session's
    const here = next.list.find(w => w.path === next.current)
    if (here?.url) await addRefs($, parsePrUrls(here.url))
  } finally {
    isRefreshing = false
  }
}

/** Re-reads every open session PR from gh, uncached; merged and closed ones keep their last answer unless forced. */
async function refreshSession($: EngineInterface, force = false) {
  if (isRefreshingSession) return
  isRefreshingSession = true
  try {
    const tracked = await read($, refs)
    if (tracked.length === 0) return
    const known = new Map((await read($, view)).session.map(p => [refKey(p), p]))
    const cwd = await $.session.cwd()
    const session = await Promise.all(
      tracked.map(async (ref): Promise<SessionPr> => {
        const last = known.get(refKey(ref))
        if (last?.isFinal && !force) return last
        try {
          const out = await run(
            $,
            ['gh', 'pr', 'view', String(ref.number), '--repo', ref.repo, '--json', PR_FIELDS],
            cwd,
            30_000,
          )
          const pr = sessionPr(ref, out.exitCode, out.stdout)
          // A failed lookup keeps the last good answer rather than blanking it
          return pr.title === null && last ? last : pr
        } catch {
          return last ?? sessionPr(ref, 1, '')
        }
      }),
    )
    await update($, view, v => ({ ...v, session }))
  } finally {
    isRefreshingSession = false
  }
}

// Off the dispatch, so a slow gh never holds up a turn
const schedule = ($: EngineInterface, force = false) => {
  $.clock.after(0, () => void refresh($, force))
}
const scheduleSession = ($: EngineInterface, force = false) => {
  $.clock.after(0, () => void refreshSession($, force))
}

/** PRs from `gh pr create` calls already in the transcript, for a session resumed under a new id. */
async function refsFromTranscript($: EngineInterface): Promise<PrRef[]> {
  const messages = await $.session.messages()
  return messages.flatMap(m =>
    m.toolUses
      .filter(u => u.tool === 'Bash' && String(u.input.command ?? '').includes('gh pr create'))
      .flatMap(u => parsePrUrls(`${u.text ?? ''}\n${JSON.stringify(u.result ?? null)}`)),
  )
}

/** Drops saved session lists older than STORE_TTL; `$.store` is shared by every session. */
async function pruneStore($: EngineInterface, now: number) {
  for (const key of await $.store.keys()) {
    if (!key.startsWith('session:')) continue
    const saved = (await $.store.get(key)) as { at?: number } | undefined
    if (!saved?.at || now - saved.at > STORE_TTL) await $.store.delete(key)
  }
}

const COLOR: Record<Tone, string | undefined> = { good: 'green', warn: 'yellow', bad: 'red', dim: undefined }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({ name: 'prs', description: 'Show this session\'s PRs and every worktree\'s status in a pane' })
    $.clock.every(POLL, () => void refresh($))
    const now = await $.clock.now()
    const saved = (await $.store.get(await storeKey($))) as { refs?: PrRef[] } | undefined
    await pruneStore($, now)
    await update($, refs, r => mergeRefs(r, saved?.refs ?? []))
    await addRefs($, await refsFromTranscript($).catch(() => []))
    if ((await read($, refs)).length > 0) ensureSessionPoll($)
    schedule($)
    scheduleSession($, true)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!e.command.includes('gh pr create') || ran.deny !== undefined) return ran
    // An existing PR is reported on stderr with a non-zero exit, so error results are read too
    try {
      await addRefs($, parsePrUrls(`${ran.text ?? ''}\n${JSON.stringify(ran.result ?? null)}`))
    } catch {
      // Tracking is best-effort; the Bash result goes back untouched
    }
    return ran
  })

  on('command.run', { command: 'prs' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session PRs' })
    schedule($)
    scheduleSession($, true)
    return { text: 'Session PRs pane opened.' }
  })

  on('classic.CwdChanged', async ($, e, next) => {
    const ran = await next(e)
    schedule($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      schedule($)
      scheduleSession($)
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { list, current, session } = await read($, view)
    const here = list.find(w => w.path === current)
    if (e.props.hasSurvey || (!here && session.length === 0)) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const tone = (l: Label) => ({ color: COLOR[l.tone], dimColor: l.tone === 'dim' })
    const herePr = here && session.length === 0 ? (here.pr.text.startsWith('#') ? `PR ${here.pr.text}` : here.pr.text) : null
    return (
      <Box flexDirection="row">
        <Text wrap="truncate-end">
          {session.length > 0 ? <Text dimColor>{session.length > 1 ? 'PRs ' : 'PR '}</Text> : null}
          {session.map((p, i) => (
            <Text key={refKey(p)}>
              {i > 0 ? <Text dimColor> · </Text> : null}
              <Text {...tone(p.state)}>{p.state.text}</Text>
              {p.checks ? <Text {...tone(p.checks)}> {p.checks.text}</Text> : null}
            </Text>
          ))}
          {herePr && here ? <Text {...tone(here.pr)}>{herePr}</Text> : null}
          {here ? (
            <Text>
              <Text dimColor> · </Text>
              <Text {...tone(here.push)}>{here.push.text}</Text>
            </Text>
          ) : null}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { list, current, error, session } = await read($, view)
    const tone = (l: Label) => ({ color: COLOR[l.tone], dimColor: l.tone === 'dim' })

    return (
      <Box flexDirection="column">
        <Text bold>This session</Text>
        {session.length === 0 ? (
          <Box marginBottom={1}>
            <Text dimColor>No PRs opened yet.</Text>
          </Box>
        ) : (
          session.map(p => (
            <Box key={refKey(p)} flexDirection="column" marginBottom={1}>
              <Text wrap="truncate-end">
                {'  '}
                <Text {...tone(p.state)}>{p.state.text}</Text>
                {p.checks ? <Text {...tone(p.checks)}> {p.checks.text}</Text> : null}
                {p.title ? <Text> {p.title}</Text> : null}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {p.url}
              </Text>
            </Box>
          ))
        )}
        <Text bold>Worktrees</Text>
        {error ? <Text color="red">{error}</Text> : null}
        {!error && list.length === 0 ? <Text dimColor>Loading worktrees…</Text> : null}
        {list.map(w => (
          <Box key={w.path} flexDirection="column" marginBottom={1}>
            <Text bold={w.path === current} wrap="truncate-end">
              {w.path === current ? '● ' : '  '}
              {w.name}
              {w.isMain ? ' (main)' : ''}
              <Text dimColor> {w.branch ?? 'detached'}</Text>
            </Text>
            <Text wrap="truncate-end">
              {'  '}
              <Text {...tone(w.pr)}>{w.pr.text}</Text>
              <Text dimColor> · </Text>
              <Text {...tone(w.push)}>{w.push.text}</Text>
            </Text>
            {w.url ? (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {w.url}
              </Text>
            ) : null}
          </Box>
        ))}
        <Button
          key="refresh"
          label="Refresh"
          hotkey="r"
          onPress={async () => {
            await Promise.all([refresh($, true), refreshSession($, true)])
          }}
        />
      </Box>
    )
  })
}
