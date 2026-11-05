// 主进程服务的可序列化契约，渲染进程仅持有相对路径与会话摘要。
// 制作人：Moriarty_Dox
import type { ConnectionSnapshot, Result } from './api.js'
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
export interface SessionHistory {
  messages: { id: string; role: 'user' | 'assistant'; text: string }[]
  truncated: boolean
}
export interface TextDiff { text: string; truncated: boolean }
export interface SessionPresentation { title?: string; pinned?: boolean; archived?: boolean }
export interface DesktopSession extends SessionPresentation {
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
}
export interface ServicesApi {
  listRecentWorkspaces(): Promise<Result<RecentWorkspace[]>>
  openRecentWorkspace(id: string): Promise<Result<ConnectionSnapshot | null>>
  listReviews(sessionId: string): Promise<Result<ReviewListing>>
  getReview(sessionId: string, checkpointId: string): Promise<Result<CheckpointReviewResult>>
  revertReview(sessionId: string, checkpointId: string, revision: string, hunkIndex: number | null): Promise<Result<CheckpointReviewMutation>>
  undoReview(sessionId: string, checkpointId: string): Promise<Result<SessionUndoResult>>
  listFiles(path: string): Promise<Result<FileListing>>
  readFile(path: string): Promise<Result<FilePreview>>
  watchWorkspace(enabled: boolean): Promise<Result<void>>
  gitStatus(): Promise<Result<GitStatus>>
  gitDiff(path: string, staged: boolean): Promise<Result<TextDiff>>
  gitStage(path: string, staged: boolean): Promise<Result<void>>
  gitDiscard(path: string): Promise<Result<boolean>>
  gitStageAll(staged: boolean): Promise<Result<void>>
  gitCommit(message: string, revision: string): Promise<Result<string>>
  gitHistory(): Promise<Result<GitCommit[]>>
  gitCommitDiff(hash: string): Promise<Result<TextDiff>>
  getSessionHistory(id: string): Promise<Result<SessionHistory>>
  openSession(id: string | null): Promise<Result<void>>
  listSessions(archived: boolean): Promise<Result<SessionListing>>
  updateSession(id: string, patch: SessionPresentation): Promise<Result<void>>
  deleteSession(id: string): Promise<Result<boolean>>
  getUsage(id: string): Promise<Result<SessionUsage>>
  getSettings(): Promise<Result<DesktopPreferences>>
  updateSettings(patch: Partial<DesktopPreferences>): Promise<Result<DesktopPreferences>>
}
