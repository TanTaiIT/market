import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BANNED_PHRASES,
  MACHINE_REVIEW,
  MachineSignals,
  bannedPhraseIn,
  medianOf,
  reviewByMachine,
} from '../../src/features/moderation/moderation.machine'

const clean: MachineSignals = {
  title: 'Xe máy Honda Wave 2020',
  description: 'Xe đi giữ gìn, còn bảo hành chính hãng',
  bannedPhrases: DEFAULT_BANNED_PHRASES,
  price: 15_000_000,
  categoryMedianPrice: 14_000_000,
  hasRecentRejection: false,
  hasDuplicateTitle: false,
  categoryRequiresReview: false,
}

const judge = (patch: Partial<MachineSignals> = {}) => reviewByMachine({ ...clean, ...patch })

describe('Người duyệt máy — phán quyết', () => {
  it('tin sạch mọi phép kiểm thì được duyệt', () => {
    expect(judge()).toEqual({ verdict: 'approve' })
  })

  it('cụm từ cấm là đường DUY NHẤT dẫn tới từ chối, và không phân hoa thường', () => {
    const res = judge({ description: 'Bán kèm MA TÚY đá số lượng lớn' })
    expect(res.verdict).toBe('reject')
    if (res.verdict === 'reject') expect(res.reason).toContain('ma túy')
  })

  it('cụm cấm trong tiêu đề cũng bị bắt', () => {
    expect(judge({ title: 'Sừng tê giác thật 100%' }).verdict).toBe('reject')
  })

  it('cụm cấm thắng mọi nghi ngờ khác — từ chối chứ không giữ lại', () => {
    const res = judge({ description: 'tiền giả như thật', hasRecentRejection: true })
    expect(res.verdict).toBe('reject')
  })

  it('giá vượt trần tuyệt đối thì giữ cho người thật, không dám tự duyệt', () => {
    expect(judge({ price: MACHINE_REVIEW.MAX_AUTO_PRICE + 1, categoryMedianPrice: null })).toEqual({
      verdict: 'hold',
      holds: ['price_over_cap'],
    })
  })

  it('giá lệch quá xa median danh mục (cả hai phía) là bất thường', () => {
    expect(judge({ price: 300_000, categoryMedianPrice: 14_000_000 })).toEqual({
      verdict: 'hold',
      holds: ['price_outlier'],
    })
    // Phía trên: 45tr chỉ hơn 3× median nên sạch, nhưng median 300k thì 45tr là 150×.
    expect(judge({ price: 45_000_000, categoryMedianPrice: 300_000 })).toEqual({
      verdict: 'hold',
      holds: ['price_outlier'],
    })
  })

  it('median null (danh mục mỏng) thì bỏ phép kiểm tương đối — không giữ oan tin đầu đàn', () => {
    expect(judge({ price: 45_000_000, categoryMedianPrice: null })).toEqual({
      verdict: 'approve',
    })
  })

  it('mọi nghi ngờ được gom đủ, không dừng ở cái đầu tiên', () => {
    const res = judge({
      hasRecentRejection: true,
      hasDuplicateTitle: true,
      categoryRequiresReview: true,
    })
    expect(res.verdict).toBe('hold')
    if (res.verdict === 'hold') {
      expect(res.holds).toEqual(
        expect.arrayContaining(['recent_rejection', 'duplicate_title', 'category_manual_review']),
      )
    }
  })
})

describe('Người duyệt máy — dụng cụ', () => {
  it('bannedPhraseIn trả cụm đầu tiên khớp, hoặc null khi sạch', () => {
    expect(bannedPhraseIn('bằng cấp giả rẻ nhất', DEFAULT_BANNED_PHRASES)).toBe('bằng cấp giả')
    expect(bannedPhraseIn('súng phun nước đồ chơi trẻ em', DEFAULT_BANNED_PHRASES)).toBeNull()
  })

  it('từ điển rỗng thì không gì bị cấm — luật sống trong DB, không có fallback ngầm', () => {
    expect(bannedPhraseIn('bằng cấp giả rẻ nhất', [])).toBeNull()
  })

  it('medianOf cần đủ mẫu tối thiểu, thiếu thì trả null', () => {
    expect(medianOf([1, 2, 3, 4])).toBeNull()
    expect(medianOf([500, 100, 300, 200, 400])).toBe(300)
  })
})
