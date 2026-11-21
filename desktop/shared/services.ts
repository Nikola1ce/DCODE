// 主进程服务的可序列化契约，渲染进程仅持有相对路径与会话摘要。
// 制作人：Moriarty_Dox
import type { ConnectionSnapshot, Result } from './api.js'
import type { ProviderId } from '../../src/providers/types.js'
import type { ReasoningEffort } from '../../src/constants.js'

export interface ProviderSettings {
  id: ProviderId; name: string; baseURL: string; model: string
  models: { value: string; label: string; hint?: string }[]
  hasApiKey: boolean; requiresApiKey: boolean; environmentKey: boolean; hasProxy: boolean
}
export interface ModelSettings {
  provider: ProviderId; model: string; reasoningEffort: ReasoningEffort; showThinking: boolean
  providers: ProviderSettings[]; environmentOverrides: string[]
}
export interface ModelSettingsInput {
  provider: ProviderId; model: string; baseURL: string; reasoningEffort: ReasoningEffort; showThinking: boolean
  apiKey?: string; proxy?: string
}
export interface ConfigurationSave { settings: ModelSettings; connectionError?: string }
import type {
  CheckpointReviewResult, CheckpointReviewMutation, CheckpointSummary, SessionUndoResult,
} from '../../src/core/checkpoint.js'

export interface ReviewListing {
  turns: {
    turnId: string | null
    timestamp: number
    files: { checkpointId: string; path: string; checkpointCount: number; complete: boolean }[]
  }[]
  undoCheckpoints: CheckpointSummary[]
}

export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' }
export interface RecentWorkspace { id: string; path: string; openedAt: number }
export interface FileListing { entries: FileEntry[]; truncated: boolean }
export type FilePreview =
  | { kind: 'text'; path: string; text: string; size: number; truncated: boolean }
  | { kind: 'binary'; path: string; size: number }
export interface GitEntry { path: string; originalPath?: string; index: string; worktree: string }
export interface GitStatus { branch: string; entries: GitEntry[]; revision?: string; upstream?: string; ahead?: number; behind?: number }
export interface GitCommit { hash: string; parents: string[]; author: string; timestamp: number; subject: string; refs: string }
export interface GitBranch {
  name: string; ref: string; remote: boolean; current: boolean; checkedOut: boolean
  upstream?: string; remoteName?: string; remoteBranch?: string
}
export interface GitBranches {
  current: string | null; head: string | null; revision: string; branches: GitBranch[]; remotes: string[]
}
export interface GitBranchInput {
  action: 'switch' | 'create' | 'rename' | 'delete'
  name: string; revision: string; newName?: string; startPoint?: string
}
export interface ManagedWorktree {
  id: string; branch: string | null; base: string | null; ahead: number; behind: number
  dirty: boolean; merging: boolean; conflicts: string[]; revision: string
}
export interface WorktreeInput {
  id: string; revision: string
  action: 'open' | 'sync' | 'integrate' | 'remove' | 'ours' | 'theirs' | 'resolved' | 'preview' | 'abort' | 'finish'
  path?: string
}
export interface GitRemoteInput { action: 'fetch' | 'pull' | 'push'; remote: string; revision: string }
export interface HistoryCursor { id: string; offset: number; direction: 'before' | 'after' }
export interface HistoryMessage {
  id: string; role: 'user' | 'assistant' | 'tool'; text: string; offset: number
  continued: boolean; tool?: string; failed?: boolean; highlight?: [number, number]
}
export interface SessionHistory {
  messages: HistoryMessage[]; truncated: boolean; before?: HistoryCursor; after?: HistoryCursor
}
export interface TextDiff { text: string; truncated: boolean }
export interface SessionPresentation { title?: string; pinned?: boolean; archived?: boolean }
export interface DesktopSession extends SessionPresentation {
  match?: { id: string; snippet: string }
  id: string; createdAt: string; updatedAt: number; title: string; messageCount: number
}
export interface SessionListing { sessions: DesktopSession[]; skipped: number; truncated: boolean }
export interface UsageTotals {
  requests: number; promptTokens: number; completionTokens: number; cacheHitTokens: number
  costUsd: number; unpricedRequests: number
}
export interface SessionUsage {
  sessionId: string; total: UsageTotals
  turns: { turnId: string; timestamp: number; usage: UsageTotals }[]
}
export interface DesktopPreferences {
  theme: 'system' | 'light' | 'dark'
  sendKey: 'enter' | 'mod-enter'
  notifications: boolean
  preventSleep: boolean
  closeBehavior: 'ask' | 'tray' | 'quit'
  notifyPermission: boolean
  notifyComplete: boolean
  notifyError: boolean
}
export type TerminalAction =
  | { type: 'open'; id: string; session: string }
  | { type: 'input'; id: string; data: string }
  | { type: 'resize'; id: string; cols: number; rows: number }
  | { type: 'close'; id: string }

export interface ServicesApi {
  terminal(action: TerminalAction): Promise<Result<void>>
  getModelSettings(): Promise<Result<ModelSettings>>
  validateModelSettings(input: ModelSettingsInput): Promise<Result<string>>
  saveModelSettings(input: ModelSettingsInput): Promise<Result<ConfigurationSave>>
  searchFiles(query: string): Promise<Result<FileListing>>
  listRecentWorkspaces(): Promise<Result<RecentWorkspace[]>>
  openRecentWorkspace(id: string): Promise<Result<ConnectionSnapshot | null>>
  listReviews(sessionId: string): Promise<Result<ReviewListing>>
  getReview(sessionId: string, checkpointId: string): Promise<Result<CheckpointReviewResult>>
  revertReview(sessionId: string, checkpointId: string, revision: string, hunkIndex: number | null): Promise<Result<CheckpointReviewMutation>>
  undoReview(sessionId: string, checkpointId: string): Promise<Result<SessionUndoResult>>
  listFiles(path: string): Promise<Result<FileListing>>
  readFile(path: string): Promise<Result<FilePreview>>
  watchWorkspace(enabled: boolean): Promise<Result<void>>
  listWorktrees(): Promise<Result<ManagedWorktree[]>>
  manageWorktree(input: WorktreeInput): Promise<Result<string>>
  openWorktree(): Promise<Result<void>>
  gitStatus(): Promise<Result<GitStatus>>
  gitBranches(): Promise<Result<GitBranches>>
  gitBranch(input: GitBranchInput): Promise<Result<boolean>>
  gitRemote(input: GitRemoteInput): Promise<Result<void>>
  gitDiff(path: string, staged: boolean): Promise<Result<TextDiff>>
  gitStage(path: string, staged: boolean): Promise<Result<void>>
  gitDiscard(path: string): Promise<Result<boolean>>
  gitStageAll(staged: boolean): Promise<Result<void>>
  gitCommit(message: string, revision: string): Promise<Result<string>>
  gitHistory(): Promise<Result<GitCommit[]>>
  gitCommitDiff(hash: string): Promise<Result<TextDiff>>
  forkSession(id: string, messageId: string): Promise<Result<string>>
  getSessionHistory(id: string, target?: string | HistoryCursor, query?: string): Promise<Result<SessionHistory>>
  openSession(id: string | null): Promise<Result<void>>
  listSessions(archived: boolean, query?: string): Promise<Result<SessionListing>>
  updateSession(id: string, patch: SessionPresentation): Promise<Result<void>>
  deleteSession(id: string): Promise<Result<boolean>>
  getUsage(id: string): Promise<Result<SessionUsage>>
  getSettings(): Promise<Result<DesktopPreferences>>
  updateSettings(patch: Partial<DesktopPreferences>): Promise<Result<DesktopPreferences>>
}
