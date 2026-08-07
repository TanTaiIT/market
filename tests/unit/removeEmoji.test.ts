import { describe, it, expect } from 'vitest'
import { removeEmoji } from '../../src/common/utils/removeEmoji'

describe('removeEmoji', () => {
  it('giữ chữ số (regression: \\p{Emoji} từng nuốt cả 0-9, mất status code trong access log)', () => {
    expect(removeEmoji('POST /api/v1/auth/login 201')).toBe('POST /api/v1/auth/login 201')
  })

  it('giữ dấu tiếng Việt', () => {
    expect(removeEmoji('Đã cập nhật hồ sơ người bán')).toBe('Đã cập nhật hồ sơ người bán')
  })

  it('bỏ emoji thật', () => {
    expect(removeEmoji('✅ MongoDB connected')).toBe(' MongoDB connected')
    expect(removeEmoji('⚠️ MongoDB disconnected')).toBe(' MongoDB disconnected')
  })
})
