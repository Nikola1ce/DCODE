// 组合服务并绑定当前主进程授权，文件事件带工作区身份以过滤过期通知。
// 制作人：Moriarty_Dox
import type { DesktopController } from '../desktopController.js'
import type { DesktopEvent } from '../../shared/api.js'
import type { DesktopPreferences, ModelSettingsInput, SessionPresentation } from '../../shared/services.js'
import { ConfigurationService } from './configuration.js'
import { samePath } from '../workspaceAccess.js'
import { WorkspaceService } from './workspace.js'
import { GitService } from './git.js'
import { SessionService } from './sessions.js'
import { SettingsService } from './settings.js'
import { sessionUsage } from './usage.js'
import { ReviewService } from './review.js'
import { DesktopFault } from '../errors.js'

export class DesktopServices {
  private readonly workspace = new WorkspaceService()
  private readonly git: GitService
  private readonly sessions: SessionService
  private readonly review: ReviewService
  private readonly unsubscribe: () => void
  private watchedCwd: string | null = null
  private readonly configuration = new ConfigurationService()

  constructor(private readonly controller: DesktopController, private readonly settings: SettingsService,
    dialogs: { confirm(title: string, detail: string): Promise<boolean>; trash(path: string): Promise<void> },
    private readonly publish: (event: DesktopEvent) => void) {
    this.git = new GitService(dialogs)
    this.sessions = new SessionService(settings, dialogs)
    this.review = new ReviewService(this.sessions)
    this.unsubscribe = controller.subscribe((event) => {
      if (event.type === 'connection' && this.watchedCwd && (!event.snapshot.cwd || !samePath(event.snapshot.cwd, this.watchedCwd))) {
        this.stopWatch()
      }
    })
  }

  listFiles(path: string) { return this.controller.useWorkspace((grant) => this.workspace.list(grant.cwd, path)) }
  getModelSettings() { return this.configuration.get() }
  validateModelSettings(input: ModelSettingsInput) { return this.configuration.validate(input) }
  async saveModelSettings(input: ModelSettingsInput) {
    const result = await this.controller.configure(() => this.configuration.save(input))
    return { settings: result.value, connectionError: result.connectionError }
  }
  searchFiles(query: string) {
    return this.controller.useWorkspace(async (grant) => {
      const directories = ['']
      const entries = []
      let scanned = 0
      let truncated = false
      for (let index = 0; index < directories.length && scanned < 10_000; index++) {
        const listing = await this.workspace.list(grant.cwd, directories[index])
        truncated ||= listing.truncated
        for (const entry of listing.entries) {
          if (++scanned > 10_000) { truncated = true; break }
          if (entry.kind === 'directory') directories.push(entry.path)
          else if (entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) entries.push(entry)
          if (entries.length === 200) return { entries, truncated: true }
        }
      }
      return { entries, truncated: truncated || scanned >= 10_000 }
    })
  }
  listRecentWorkspaces() { return this.settings.recentWorkspaces() }
  async openRecentWorkspace(id: string) {
    const recent = (await this.settings.recentWorkspaces()).find((entry) => entry.id === id)
    if (!recent) throw new DesktopFault('INVALID_ARGUMENT', '最近项目记录已变化，请刷新后重试。')
    return this.controller.chooseWorkspace(recent.path)
  }
  readFile(path: string) { return this.controller.useWorkspace((grant) => this.workspace.read(grant.cwd, path)) }
  gitStatus() { return this.controller.useWorkspace((grant) => this.git.status(grant.cwd)) }
  gitDiff(path: string, staged: boolean) { return this.controller.useWorkspace((grant) => this.git.diff(grant.cwd, path, staged)) }
  gitStage(path: string, staged: boolean) {
    return this.controller.useWorkspace(async (grant) => {
      await this.git.stage(grant.cwd, path, staged)
      this.publish({ type: 'workspace_changed', cwd: grant.cwd })
    }, true)
  }
  gitDiscard(path: string) {
    return this.controller.useWorkspace(async (grant) => {
      const changed = await this.git.discard(grant.cwd, path)
      if (changed) this.publish({ type: 'workspace_changed', cwd: grant.cwd })
      return changed
    }, true)
  }
  gitStageAll(staged: boolean) {
    return this.controller.useWorkspace(async (grant) => {
      await this.git.stageAll(grant.cwd, staged)
      this.publish({ type: 'workspace_changed', cwd: grant.cwd })
    }, true)
  }
  gitCommit(message: string, revision: string) {
    return this.controller.useWorkspace(async (grant) => {
      const hash = await this.git.commit(grant.cwd, message, revision)
      this.publish({ type: 'workspace_changed', cwd: grant.cwd })
      return hash
    }, true)
  }
  gitHistory() { return this.controller.useWorkspace((grant) => this.git.history(grant.cwd)) }
  gitCommitDiff(hash: string) { return this.controller.useWorkspace((grant) => this.git.commitDiff(grant.cwd, hash)) }
  getSessionHistory(id: string) { return this.controller.useWorkspace((grant) => this.sessions.history(grant.cwd, id)) }
  openSession(id: string | null) { return this.controller.openSession(id, (cwd, session) => this.sessions.snapshot(cwd, session)) }
  listSessions(archived: boolean) { return this.controller.useWorkspace((grant) => this.sessions.list(grant.cwd, archived)) }
  updateSession(id: string, patch: SessionPresentation) { return this.controller.useWorkspace((grant) => this.sessions.update(grant.cwd, id, patch)) }
  deleteSession(id: string) {
    return this.controller.useWorkspace((grant) => this.sessions.remove(grant.cwd, id, this.controller.getSnapshot().sessionId), true)
  }
  getUsage(id: string) { return this.controller.useWorkspace(async (grant) => sessionUsage(await this.sessions.snapshot(grant.cwd, id))) }
  listReviews(sessionId: string) { return this.controller.useWorkspace((grant) => this.review.list(grant.cwd, sessionId)) }
  getReview(sessionId: string, checkpointId: string) { return this.controller.useWorkspace((grant) => this.review.get(grant.cwd, sessionId, checkpointId)) }
  revertReview(sessionId: string, checkpointId: string, revision: string, hunkIndex: number | null) {
    return this.controller.useWorkspace(async (grant) => {
      const result = await this.review.revert(grant.cwd, sessionId, checkpointId, revision, hunkIndex)
      this.publish({ type: 'workspace_changed', cwd: grant.cwd })
      return result
    }, true)
  }
  undoReview(sessionId: string, checkpointId: string) {
    return this.controller.useWorkspace(async (grant) => {
      const result = await this.review.undo(grant.cwd, sessionId, checkpointId)
      this.publish({ type: 'workspace_changed', cwd: grant.cwd })
      return result
    }, true)
  }
  getSettings() { return this.settings.get() }
  updateSettings(patch: Partial<DesktopPreferences>) { return this.settings.update(patch) }

  watchWorkspace(enabled: boolean): Promise<void> {
    return this.controller.useWorkspace(async (grant) => {
      this.stopWatch()
      if (!enabled) return
      this.watchedCwd = grant.cwd
      try {
        this.workspace.startWatch(grant.cwd,
          () => this.publish({ type: 'workspace_changed', cwd: grant.cwd }),
          () => { this.watchedCwd = null; this.publish({ type: 'workspace_watch_error', cwd: grant.cwd }) })
      } catch (error) { this.stopWatch(); throw error }
    })
  }

  private stopWatch(): void { this.workspace.dispose(); this.watchedCwd = null }
  async dispose(): Promise<void> {
    this.stopWatch()
    this.unsubscribe()
    await this.settings.flush()
    await this.configuration.flush()
  }
}
