import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BANNED_PHRASES,
  MACHINE_REVIEW,
  MachineSignals,
  bannedPhraseIn,
  medianOf,
  normalizeForMatch,
  reviewByMachine,
  screenText,
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
  trustLevel: 2,
  onProbation: false,
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

describe('Người duyệt máy — nhìn bậc uy tín (audit 1.3) và án quản chế (1.12)', () => {
  it('bậc 0 thì giữ cho người thật: người đã vi phạm không được máy duyệt hộ', () => {
    expect(judge({ trustLevel: 0 })).toEqual({ verdict: 'hold', holds: ['trust_too_low'] })
  })

  it('từ bậc MIN_TRUST_LEVEL máy duyệt được — đường leo lại không phải chờ người duyệt rảnh', () => {
    expect(judge({ trustLevel: MACHINE_REVIEW.MIN_TRUST_LEVEL })).toEqual({ verdict: 'approve' })
  })

  it('đang bị quản chế thì máy không duyệt, bất kể bậc', () => {
    expect(judge({ trustLevel: 2, onProbation: true })).toEqual({
      verdict: 'hold',
      holds: ['probation'],
    })
  })

  it('cụm cấm vẫn thắng: bậc 0 mà dính hàng cấm là từ chối, không phải giữ', () => {
    expect(judge({ trustLevel: 0, title: 'Bán tiền giả' }).verdict).toBe('reject')
  })
})

describe('Cổng cụm cấm — chuẩn hoá và mọi ô chữ (audit 1.17)', () => {
  it('normalizeForMatch: bỏ dấu, hạ chữ thường, gộp khoảng trắng', () => {
    expect(normalizeForMatch('  MA   Túy  Đá ')).toBe('ma tuy da')
    expect(normalizeForMatch('Sừng Tê Giác')).toBe('sung te giac')
  })

  it('cụm cấm viết không dấu vẫn bị bắt, trả về cụm GỐC trong từ điển', () => {
    expect(bannedPhraseIn('ban kem MA TUY da', ['ma túy'])).toBe('ma túy')
    expect(judge({ description: 'ban kem ma tuy da cho khach quen' }).verdict).toBe('reject')
  })

  it('extraText (địa chỉ, thuộc tính) đi qua cổng cụm cấm nhưng không vào phép đo gõ bừa', () => {
    expect(judge({ extraText: 'Giao tại kho có heroin' }).verdict).toBe('reject')
    expect(judge({ extraText: 'Số 12 đường Lê Lợi' })).toEqual({ verdict: 'approve' })
  })

  it('screenText ghép tiêu đề, mô tả, địa chỉ và giá trị CHỮ của thuộc tính', () => {
    const text = screenText({
      title: 'A',
      description: 'B',
      address: 'C',
      attributes: { note: 'D', year: 2020, color: null },
    })
    expect(text.split('\n')).toEqual(['A', 'B', 'C', 'D'])
    expect(screenText({ title: 'A', description: 'B', attributes: new Map([['note', 'D']]) })).toBe(
      'A\nB\n\nD',
    )
  })
})
