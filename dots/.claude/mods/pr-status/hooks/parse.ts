import type { Label, PrRef, SessionPr } from '../types'

export type PorcelainEntry = {
  path: string
  branch: string | null
  isBare: boolean
}

// `git worktree list --porcelain`: one block per worktree, blank-line separated.
export function parsePorcelain(text: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = []
  for (const block of text.split(/\n\s*\n/)) {
    let path = ''
    let branch: string | null = null
    let isBare = false
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'bare') isBare = true
    }
    if (path) entries.push({ path, branch, isBare })
  }
  return entries
}

// `git rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>".
export function parseAheadBehind(text: string): { ahead: number; behind: number } | null {
  const m = text.trim().match(/^(\d+)\s+(\d+)$/)
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null
}

// null means the branch has no upstream
export function pushLabel(ab: { ahead: number; behind: number } | null): Label {
  if (ab === null) return { text: 'not pushed', tone: 'warn' }
  if (ab.ahead > 0 && ab.behind > 0) return { text: `↑${ab.ahead} ↓${ab.behind}`, tone: 'warn' }
  if (ab.ahead > 0) return { text: `↑${ab.ahead} unpushed`, tone: 'warn' }
  if (ab.behind > 0) return { text: `↓${ab.behind} behind`, tone: 'warn' }
  return { text: 'pushed', tone: 'good' }
}

export type GhPr = {
  number: number
  state: string
  isDraft?: boolean
  reviewDecision?: string | null
  mergedAt?: string | null
  url?: string
}

// What `gh pr view --json ...` answered: a PR, no PR for the branch, or a failure
export type PrLookup = { kind: 'pr'; pr: GhPr } | { kind: 'none' } | { kind: 'error' }

export function prLabel(lookup: PrLookup): Label {
  if (lookup.kind === 'none') return { text: 'no PR', tone: 'dim' }
  if (lookup.kind === 'error') return { text: 'PR ?', tone: 'dim' }
  const { pr } = lookup
  const n = `#${pr.number}`
  if (pr.state === 'MERGED' || pr.mergedAt) return { text: `${n} merged`, tone: 'good' }
  if (pr.state === 'CLOSED') return { text: `${n} closed`, tone: 'dim' }
  if (pr.isDraft) return { text: `${n} draft`, tone: 'dim' }
  if (pr.reviewDecision === 'APPROVED') return { text: `${n} approved`, tone: 'good' }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { text: `${n} changes requested`, tone: 'bad' }
  return { text: `${n} review required`, tone: 'warn' }
}

// gh exits 1 both for "no PR" and for auth/network failures; only the first is "no PR"
export function parseGh(exitCode: number, stdout: string, stderr: string): PrLookup {
  if (exitCode !== 0) {
    return /no (pull requests|open pull requests) found/i.test(stderr) ? { kind: 'none' } : { kind: 'error' }
  }
  try {
    const pr = JSON.parse(stdout) as GhPr
    return typeof pr.number === 'number' ? { kind: 'pr', pr } : { kind: 'error' }
  } catch {
    return { kind: 'error' }
  }
}

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g

// Every PR URL in a command's output; `gh pr create` prints the new one on stdout, or the existing one on stderr
export function parsePrUrls(text: string): PrRef[] {
  const seen = new Map<string, PrRef>()
  for (const m of text.matchAll(PR_URL)) {
    const ref = { repo: m[1] ?? '', number: Number(m[2]) }
    seen.set(refKey(ref), ref)
  }
  return [...seen.values()]
}

export const refKey = (ref: PrRef) => `${ref.repo}#${ref.number}`

export function mergeRefs(a: PrRef[], b: PrRef[]): PrRef[] {
  const out = new Map(a.map(r => [refKey(r), r]))
  for (const r of b) out.set(refKey(r), r)
  return [...out.values()]
}

export type GhCheck = { __typename?: string; status?: string | null; conclusion?: string | null; state?: string | null }

// CANCELLED / SKIPPED / NEUTRAL are not failures: superseded runs cancel routinely
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

export function checksLabel(rollup: GhCheck[] | null | undefined): Label | null {
  if (!rollup || rollup.length === 0) return null
  let failing = 0
  let pending = 0
  for (const c of rollup) {
    const outcome = c.conclusion ?? c.state ?? null
    if (outcome && FAILED.has(outcome)) failing++
    else if ((c.status && c.status !== 'COMPLETED') || outcome === 'PENDING' || outcome === 'EXPECTED') pending++
  }
  if (failing > 0) return { text: `✗${failing} failing`, tone: 'bad' }
  if (pending > 0) return { text: `…${pending} running`, tone: 'warn' }
  return { text: '✓ checks', tone: 'good' }
}

export type GhPrFull = GhPr & {
  title?: string
  mergeStateStatus?: string
  statusCheckRollup?: GhCheck[] | null
}

export function sessionPr(ref: PrRef, exitCode: number, stdout: string): SessionPr {
  const url = `https://github.com/${ref.repo}/pull/${ref.number}`
  const unknown = { ...ref, title: null, state: { text: `#${ref.number} ?`, tone: 'dim' as const }, checks: null, url, isFinal: false }
  if (exitCode !== 0) return unknown
  let pr: GhPrFull
  try {
    pr = JSON.parse(stdout) as GhPrFull
  } catch {
    return unknown
  }
  if (typeof pr.number !== 'number') return unknown
  const isFinal = pr.state === 'MERGED' || pr.state === 'CLOSED' || Boolean(pr.mergedAt)
  const state =
    !isFinal && pr.mergeStateStatus === 'DIRTY'
      ? { text: `#${pr.number} conflicts`, tone: 'bad' as const }
      : prLabel({ kind: 'pr', pr })
  return {
    ...ref,
    title: pr.title ?? null,
    state,
    checks: isFinal ? null : checksLabel(pr.statusCheckRollup),
    url: pr.url ?? url,
    isFinal,
  }
}
