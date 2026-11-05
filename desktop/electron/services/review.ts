// 审阅服务按已授权工作区与会话隔离，文件写入和失败补偿由内核检查点模块负责。
// 制作人：Moriarty_Dox
import {
  getCheckpointReview, listCheckpointSummaries, revertCheckpointReview, undoCheckpointReview,
} from '../../../src/core/checkpoint.js'
import type { ReviewListing } from '../../shared/services.js'
import { DesktopFault } from '../errors.js'
import type { SessionService } from './sessions.js'
import { workspacePath } from './workspace.js'

export class ReviewService {
  constructor(private readonly sessions: SessionService) {}

  async list(cwd: string, sessionId: string): Promise<ReviewListing> {
    await this.sessions.snapshot(cwd, sessionId)
    const checkpoints = listCheckpointSummaries(cwd, sessionId, true)
    const turns = new Map<string, ReviewListing['turns'][number]>()
    for (const checkpoint of checkpoints) {
      if (checkpoint.reviewOf) continue
      const key = JSON.stringify([checkpoint.turnId ?? null, checkpoint.turnId ? null : checkpoint.id])
      let turn = turns.get(key)
      if (!turn) {
        turn = { turnId: checkpoint.turnId ?? null, timestamp: checkpoint.timestamp, files: [] }
        turns.set(key, turn)
      }
      const file = turn.files.find((item) => process.platform === 'win32'
        ? item.path.toLowerCase() === checkpoint.path.toLowerCase() : item.path === checkpoint.path)
      if (file) {
        file.checkpointCount++
        file.complete = file.complete && checkpoint.complete
      } else {
        turn.files.push({ checkpointId: checkpoint.id, path: checkpoint.path, checkpointCount: 1, complete: checkpoint.complete })
      }
    }
    return {
      turns: [...turns.values()].reverse(),
      undoCheckpoints: checkpoints.filter((checkpoint) => checkpoint.reviewOf).reverse(),
    }
  }

  private async authorize(cwd: string, sessionId: string, checkpointId: string): Promise<void> {
    await this.sessions.snapshot(cwd, sessionId)
    const checkpoint = listCheckpointSummaries(cwd, sessionId, true).find((item) => item.id === checkpointId)
    if (!checkpoint) throw new DesktopFault('FORBIDDEN', '检查点属于其他会话或已经清理。')
    await workspacePath(cwd, checkpoint.path, true)
  }

  async get(cwd: string, sessionId: string, checkpointId: string) {
    await this.authorize(cwd, sessionId, checkpointId)
    return getCheckpointReview(cwd, checkpointId, sessionId)
  }

  async revert(cwd: string, sessionId: string, checkpointId: string, revision: string, hunkIndex: number | null) {
    await this.authorize(cwd, sessionId, checkpointId)
    return revertCheckpointReview(cwd, checkpointId, sessionId, revision, hunkIndex ?? undefined)
  }

  async undo(cwd: string, sessionId: string, checkpointId: string) {
    await this.authorize(cwd, sessionId, checkpointId)
    return undoCheckpointReview(cwd, checkpointId, sessionId)
  }
}
