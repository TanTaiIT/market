import { describe, it, expect } from 'vitest'
import {
  MASK,
  maskEmail,
  maskPhone,
  redactMeta,
  redactValue,
  sanitizeUrl,
} from '../../src/common/observability/redact'

/** Che dữ liệu nhạy cảm trong log (audit 7.8). */
describe('redact — meta của dòng log', () => {
  it('email chỉ còn ký tự đầu và domain, SĐT chỉ còn 3 số cuối', () => {
    expect(maskEmail('tai.nguyen@example.com')).toBe('t***@example.com')
    expect(maskEmail('không phải email')).toBe(MASK)
    expect(maskPhone('0901234567')).toBe('***567')
    expect(maskPhone('12')).toBe(MASK)
  })

  it('khoá bí mật bị thay hẳn, không phân biệt hoa/thường, đệ quy vào object lồng và mảng', () => {
    const out = redactMeta({
      userId: 'u1',
      email: 'a@b.vn',
      Password: 'hunter2',
      body: { refreshToken: 'rt', nested: [{ code: '123456', keep: 1 }] },
    })
    expect(out).toEqual({
      userId: 'u1',
      email: 'a***@b.vn',
      Password: MASK,
      body: { refreshToken: MASK, nested: [{ code: MASK, keep: 1 }] },
    })
  })

  it('Error và Date giữ nguyên — stack là thứ cần đọc, không phải thứ cần che', () => {
    const err = new Error('boom')
    const at = new Date()
    expect(redactValue('err', err)).toBe(err)
    expect(redactValue('at', at)).toBe(at)
    expect(redactValue('token', null)).toBeNull()
  })

  it('URL: che giá trị của `code`/`token` trên query, giữ nguyên phần còn lại', () => {
    expect(sanitizeUrl('/api/v1/auth/verify-email?code=123456&next=%2Fhome')).toBe(
      `/api/v1/auth/verify-email?code=${MASK}&next=%2Fhome`,
    )
    expect(sanitizeUrl('/api/v1/listings?page=2')).toBe('/api/v1/listings?page=2')
    expect(sanitizeUrl('/api/v1/listings')).toBe('/api/v1/listings')
  })
})
