import { describe, it, expect } from 'vitest'
import {
  QUOTA,
  QuotaInput,
  checkQuota,
  isAutoApprove,
  pendingLimitFor,
} from '../../src/features/listing/listing.quota'

const base: QuotaInput = {
  trustLevel: 0,
  isOutsider: false,
  recentRejections: 0,
  pendingCount: 0,
}

const check = (patch: Partial<QuotaInput> = {}) => checkQuota({ ...base, ...patch })

describe('Hạn mức theo bậc uy tín', () => {
  it('người mới 3 tin, đủ uy tín thì 10', () => {
    expect(pendingLimitFor({ trustLevel: 0, isOutsider: false, recentRejections: 0 })).toBe(3)
    expect(pendingLimitFor({ trustLevel: 2, isOutsider: false, recentRejections: 0 })).toBe(10)
  })

  it('bậc vượt bảng vẫn lấy bậc cuối, không văng undefined', () => {
    expect(pendingLimitFor({ trustLevel: 99, isOutsider: false, recentRejections: 0 })).toBe(10)
  })

  it('người ngoài org có hạn mức CỨNG, không theo uy tín', () => {
    expect(pendingLimitFor({ trustLevel: 2, isOutsider: true, recentRejections: 0 })).toBe(
      QUOTA.OUTSIDER_LIMIT,
    )
  })

  it('vừa bị từ chối thì tụt về 1 dù uy tín cao', () => {
    expect(pendingLimitFor({ trustLevel: 2, isOutsider: false, recentRejections: 1 })).toBe(
      QUOTA.PENALIZED_LIMIT,
    )
  })
})

describe('Chốt quota', () => {
  it('còn slot thì cho đăng và báo còn bao nhiêu', () => {
    expect(check({ pendingCount: 1 })).toMatchObject({ allowed: true, limit: 3, remaining: 2 })
  })

  it('đầy slot thì chặn, kèm lý do đọc được', () => {
    expect(check({ pendingCount: 3 })).toMatchObject({ allowed: false, reason: 'quota_full' })
  })

  it('đủ số lần bị từ chối trong cửa sổ thì khoá hẳn, không phụ thuộc slot trống', () => {
    // Đây là chỗ bịt lỗ hổng "duyệt/từ chối xong lại có slot, đăng tiếp vô hạn".
    const verdict = check({ recentRejections: QUOTA.REJECTION_BLOCK, pendingCount: 0 })
    expect(verdict).toMatchObject({ allowed: false, reason: 'blocked_by_rejections', remaining: 0 })
  })
})

describe('Tự đăng khi đủ uy tín', () => {
  it('đạt ngưỡng thì tự đăng', () => {
    expect(isAutoApprove(QUOTA.AUTO_APPROVE_TRUST_LEVEL, 0)).toBe(true)
  })

  it('chưa đạt thì không', () => {
    expect(isAutoApprove(QUOTA.AUTO_APPROVE_TRUST_LEVEL - 1, 0)).toBe(false)
  })

  it('có tin vừa bị từ chối thì mất quyền tự đăng, dù uy tín đủ', () => {
    expect(isAutoApprove(QUOTA.AUTO_APPROVE_TRUST_LEVEL, 1)).toBe(false)
  })
})
