// 桌面独立测试配置：纯 Node 测试，不启动 Electron GUI。
// 制作人：Moriarty_Dox
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 10_000,
    restoreMocks: true,
    clearMocks: true,
  },
})
