// Subpath phải là 'vitest/config' — exports map của vitest không có './config.js'.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts', 'tests/**/*.{test,spec}.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Chạy tuần tự để tránh nhiều instance mongodb-memory-server tranh nhau
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.routes.ts', 'src/config/**'],
    },
  },
})
