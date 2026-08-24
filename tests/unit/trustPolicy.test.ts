import { describe, it, expect } from 'vitest'
import {
  CLEAN_APPROVALS_PER_LEVEL,
  INITIAL_TRUST,
  MAX_TRUST_LEVEL,
  TrustState,
  nextTrust,
} from '../../src/features/trust/trust.policy'

/**
 * Đáy thang. KHÔNG còn là điểm xuất phát của ai cả — tài khoản mới bắt đầu ở `INITIAL_TRUST`
 * (bậc trần). Tới được đây nghĩa là đã bị tụt hết, nên các ca dưới đây đọc là "người đã vi
 * phạm đang leo lại", không phải "người mới đang leo lên".
 */
const BOTTOM: TrustState = { level: 0, cleanApprovals: 0 }

/** Chạy n lượt duyệt sạch liên tiếp từ một trạng thái. */
const approve = (state: TrustState, times = 1): TrustState =>
  Array.from({ length: times }).reduce<TrustState>((s) => nextTrust(s, true), state)

const reject = (state: TrustState): TrustState => nextTrust(state, false)

describe('Điểm xuất phát — tin trước, thu lại sau', () => {
  it('tài khoản mới đứng ngay ở trần, không phải leo', () => {
    expect(INITIAL_TRUST).toEqual({ level: MAX_TRUST_LEVEL, cleanApprovals: 0 })
  })

  it('CANARY: mặc định PHẢI đủ để tự đăng — lệch là cả chính sách thành vô nghĩa', async () => {
    const { isAutoApprove } = await import('../../src/features/listing/listing.quota')
    expect(isAutoApprove(INITIAL_TRUST.level, 0)).toBe(true)
  })

  it('một lần vi phạm là mất quyền tự đăng ngay', async () => {
    const { isAutoApprove } = await import('../../src/features/listing/listing.quota')
    const after = nextTrust(INITIAL_TRUST, false)

    expect(after.level).toBe(MAX_TRUST_LEVEL - 1)
    expect(isAutoApprove(after.level, 0)).toBe(false)
  })

  it('leo lại đúng 5 tin sạch là về trần', () => {
    let state = nextTrust(INITIAL_TRUST, false)
    for (let i = 0; i < 5; i += 1) state = nextTrust(state, true)

    expect(state.level).toBe(MAX_TRUST_LEVEL)
  })
})

describe('nextTrust — thăng bậc', () => {
  it(`chưa đủ ${CLEAN_APPROVALS_PER_LEVEL} bài sạch thì chưa lên bậc`, () => {
    expect(approve(BOTTOM, CLEAN_APPROVALS_PER_LEVEL - 1)).toEqual({
      level: 0,
      cleanApprovals: 4,
    })
  })

  it('đủ 5 bài sạch lên bậc 1', () => {
    expect(approve(BOTTOM, 5)).toEqual({ level: 1, cleanApprovals: 5 })
  })

  it('10 bài sạch lên bậc 2 — đúng mốc mở quyền tự đăng', () => {
    expect(approve(BOTTOM, 10)).toEqual({ level: 2, cleanApprovals: 10 })
  })
})

describe('nextTrust — giáng bậc', () => {
  it('một lần bị từ chối: tụt đúng MỘT bậc và mất sạch chuỗi', () => {
    expect(reject({ level: 3, cleanApprovals: 15 })).toEqual({ level: 2, cleanApprovals: 0 })
  })

  it('bậc 0 bị từ chối không xuống âm', () => {
    expect(reject(BOTTOM)).toEqual(BOTTOM)
  })

  /**
   * Ca này khoá đúng bug của bản cũ: nó tính `level = floor(clean / 5)` mỗi lần duyệt, nên sau
   * một lần bị từ chối (chuỗi về 0) thì tin sạch TIẾP THEO cho ra `floor(1/5) = 0` — bậc 2 rơi
   * thẳng xuống 0. Một lần sai sót không được phép xoá sạch lịch sử.
   */
  it('duyệt sạch sau khi bị từ chối KHÔNG được kéo bậc xuống', () => {
    // Bậc 2 là trần (`MAX_TRUST_LEVEL`), nên đây là trạng thái cao nhất có thật.
    const afterReject = reject({ level: 2, cleanApprovals: 10 })
    expect(afterReject.level).toBe(1)
    expect(approve(afterReject).level).toBe(1)
    expect(approve(afterReject, 4).level).toBe(1)
  })

  it('làm lại đủ 5 bài sạch thì lấy lại bậc đã mất', () => {
    const afterReject = reject({ level: 2, cleanApprovals: 10 })
    expect(approve(afterReject, 5)).toEqual({ level: 2, cleanApprovals: 5 })
  })
})

describe('Trần bậc — người đăng nhiều không được miễn nhiễm', () => {
  it('CANARY: trần bậc PHẢI bằng ngưỡng tự đăng, nếu không hệ thưởng/phạt lệch nhau', async () => {
    const { QUOTA } = await import('../../src/features/listing/listing.quota')
    expect(MAX_TRUST_LEVEL).toBe(QUOTA.AUTO_APPROVE_TRUST_LEVEL)
  })

  it('bậc dừng ở trần dù chuỗi sạch dài bao nhiêu', () => {
    let state = BOTTOM
    for (let i = 0; i < 50; i += 1) state = nextTrust(state, true)

    expect(state.level).toBe(MAX_TRUST_LEVEL)
    // Chuỗi vẫn đếm tiếp — nó là thống kê riêng, chỉ có bậc là dừng.
    expect(state.cleanApprovals).toBe(50)
  })

  it('MỌI người bán đứng cách hình phạt đúng một khoảng như nhau', () => {
    // Người mới: đúng 10 bài sạch để tới trần.
    let rookie = BOTTOM
    for (let i = 0; i < 10; i += 1) rookie = nextTrust(rookie, true)
    // Người kỳ cựu: 50 bài sạch.
    let veteran = BOTTOM
    for (let i = 0; i < 50; i += 1) veteran = nextTrust(veteran, true)

    // Cùng một lượt từ chối, cùng một cái giá — đây là điều trước bản vá KHÔNG đúng.
    expect(nextTrust(rookie, false).level).toBe(nextTrust(veteran, false).level)
    expect(nextTrust(veteran, false).level).toBeLessThan(MAX_TRUST_LEVEL)
  })
})
