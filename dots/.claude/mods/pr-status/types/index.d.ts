export type Tone = 'good' | 'warn' | 'bad' | 'dim'

export type Label = { text: string; tone: Tone }

export type WorktreeStatus = {
  path: string
  name: string
  branch: string | null
  isMain: boolean
  push: Label
  pr: Label
  url: string | null
}

// A PR this session opened (or worked on from its worktree), by `owner/repo` and number
export type PrRef = { repo: string; number: number }

export type SessionPr = PrRef & {
  title: string | null
  state: Label
  // CI rollup; null when the PR has no checks or gh could not say
  checks: Label | null
  url: string
  // Merged or closed: no longer polled
  isFinal: boolean
}

export type PrView = {
  list: WorktreeStatus[]
  // The session's current worktree (git rev-parse --show-toplevel), null outside a repo
  current: string | null
  error: string | null
  session: SessionPr[]
}

declare module 'claude-code' {
  interface PluginState {
    'pr-status': { view: PrView; refs: PrRef[] }
  }
}
