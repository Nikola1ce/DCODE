// 智谱 AI 模型清单单元测试。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { DEFAULT_ZHIPU_MODEL } from '../constants.js'
import {
  getZhipuModelHint,
  isZhipuFreeModel,
  ZHIPU_CHAT_MODELS,
  ZHIPU_FREE_MODELS,
  ZHIPU_FREE_MODEL_BADGE,
  ZHIPU_PAID_MODELS,
} from './zhipuModels.js'

describe('zhipuModels', () => {
  it('ZHIPU_CHAT_MODELS 含免费与收费模型', () => {
    expect(ZHIPU_FREE_MODELS).toContain(DEFAULT_ZHIPU_MODEL)
    expect(ZHIPU_FREE_MODELS).toContain('glm-4.7-flash')
    expect(ZHIPU_PAID_MODELS).toContain('glm-5.1')
    expect(ZHIPU_PAID_MODELS).toContain('glm-4.7')
    expect(ZHIPU_CHAT_MODELS.length).toBe(ZHIPU_FREE_MODELS.length + ZHIPU_PAID_MODELS.length)
    expect(ZHIPU_CHAT_MODELS[0]).toBe(DEFAULT_ZHIPU_MODEL)
  })

  it('getZhipuModelHint 免费模型带 ★ 标记', () => {
    expect(getZhipuModelHint(DEFAULT_ZHIPU_MODEL, DEFAULT_ZHIPU_MODEL)).toContain('★')
    expect(getZhipuModelHint(DEFAULT_ZHIPU_MODEL, DEFAULT_ZHIPU_MODEL)).toContain('默认')
    expect(getZhipuModelHint('glm-4.7-flash', DEFAULT_ZHIPU_MODEL)).toContain(ZHIPU_FREE_MODEL_BADGE)
  })

  it('getZhipuModelHint 收费模型显示按量计费', () => {
    expect(getZhipuModelHint('glm-5.1', DEFAULT_ZHIPU_MODEL)).toContain('按量计费')
    expect(getZhipuModelHint('glm-4.5-air', DEFAULT_ZHIPU_MODEL)).toContain('性价比')
  })

  it('isZhipuFreeModel 仅两个 Flash 免费', () => {
    expect(isZhipuFreeModel('glm-4-flash')).toBe(true)
    expect(isZhipuFreeModel('glm-4.7-flash')).toBe(true)
    expect(isZhipuFreeModel('glm-4.7')).toBe(false)
  })
})
