import { describe, it, expect } from 'vitest'
import {
  QUOTA,
  QuotaInput,
  autoApprovalReason,
  checkQuota,
  isAutoApprove,
  pendingLimitFor,
  touchesReviewedContent,
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

describe('autoApprovalReason', () => {
  const noBlock = {
    autoApproved: false,
    trustLevel: 0,
    recentRejections: 0,
    categoryRequiresReview: false,
    isOutsider: false,
  }

  it('tin tự đăng thì lý do là chính nó, không dò tiếp', () => {
    // Kể cả khi các cờ khác trông như đang chặn: kết quả thật mới là nguồn sự thật.
    expect(autoApprovalReason({ ...noBlock, autoApproved: true, trustLevel: 0 })).toBe('approved')
  })

  it('người ngoài luôn bị giữ, bất kể uy tín', () => {
    expect(autoApprovalReason({ ...noBlock, trustLevel: 9, isOutsider: true })).toBe(
      'outsider_post',
    )
  })

  it('có tin bị từ chối gần đây thì đó là lý do, trước cả cờ danh mục', () => {
    expect(
      autoApprovalReason({
        ...noBlock,
        trustLevel: 9,
        recentRejections: 1,
        categoryRequiresReview: true,
      }),
    ).toBe('recent_rejection')
  })

  it('danh mục bắt duyệt tay phủ quyết uy tín cao', () => {
    expect(autoApprovalReason({ ...noBlock, trustLevel: 9, categoryRequiresReview: true })).toBe(
      'category_manual_review',
    )
  })

  it('không vướng gì khác thì là do bậc chưa đủ', () => {
    expect(autoApprovalReason({ ...noBlock, trustLevel: 1 })).toBe('trust_too_low')
  })

  it('đủ bậc nhưng cổng nội dung FLAG thì lý do là content_flagged', () => {
    expect(autoApprovalReason({ ...noBlock, trustLevel: 2, contentFlagged: true })).toBe(
      'content_flagged',
    )
  })

  it('án từ chối đứng TRƯỚC flag — kể đúng chốt chặn thật', () => {
    expect(
      autoApprovalReason({ ...noBlock, trustLevel: 2, recentRejections: 1, contentFlagged: true }),
    ).toBe('recent_rejection')
  })
})

describe('Sửa gì thì phải duyệt lại', () => {
  const live = {
    title: 'Xe máy Honda Wave 2020',
    description: 'Xe đi giữ gìn, còn bảo hành',
    price: 15_000_000,
    images: ['https://cdn.local/a.jpg', 'https://cdn.local/b.jpg'],
    categoryId: '65f000000000000000000001',
  }

  it('PATCH gửi lại nguyên giá trị cũ KHÔNG tính là sửa', () => {
    expect(touchesReviewedContent(live, { title: live.title, images: [...live.images] })).toBe(
      false,
    )
  })

  it('bản vá rỗng, hoặc chỉ chạm field ngoài vùng duyệt, cũng không tính', () => {
    expect(touchesReviewedContent(live, {})).toBe(false)
  })

  it('đổi tiêu đề, mô tả, giá hay danh mục đều tính', () => {
    expect(touchesReviewedContent(live, { title: 'iPhone 15 Pro Max' })).toBe(true)
    expect(touchesReviewedContent(live, { description: 'Hàng khác hẳn' })).toBe(true)
    expect(touchesReviewedContent(live, { price: 1000 })).toBe(true)
    expect(touchesReviewedContent(live, { categoryId: '65f000000000000000000002' })).toBe(true)
  })

  it('giá về 0 vẫn là sửa — `0` không được rơi vào nhánh "không gửi"', () => {
    expect(touchesReviewedContent(live, { price: 0 })).toBe(true)
  })

  it('đảo thứ tự ảnh là sửa: ảnh đầu tiên là ảnh đại diện', () => {
    expect(touchesReviewedContent(live, { images: [live.images[1], live.images[0]] })).toBe(true)
  })

  it('thêm hay bớt ảnh là sửa', () => {
    expect(touchesReviewedContent(live, { images: [live.images[0]] })).toBe(true)
  })
})
