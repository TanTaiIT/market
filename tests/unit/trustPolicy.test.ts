import { describe, it, expect } from 'vitest'
import {
  CLEAN_APPROVALS_PER_LEVEL,
  TrustState,
  ZERO_TRUST,
  nextTrust,
} from '../../src/features/trust/trust.policy'

/** Chạy n lượt duyệt sạch liên tiếp từ một trạng thái. */
const approve = (state: TrustState, times = 1): TrustState =>
  Array.from({ length: times }).reduce<TrustState>((s) => nextTrust(s, true), state)

const reject = (state: TrustState): TrustState => nextTrust(state, false)

describe('nextTrust — thăng bậc', () => {
  it(`chưa đủ ${CLEAN_APPROVALS_PER_LEVEL} bài sạch thì chưa lên bậc`, () => {
    expect(approve(ZERO_TRUST, CLEAN_APPROVALS_PER_LEVEL - 1)).toEqual({
      level: 0,
      cleanApprovals: 4,
    })
  })

  it('đủ 5 bài sạch lên bậc 1', () => {
    expect(approve(ZERO_TRUST, 5)).toEqual({ level: 1, cleanApprovals: 5 })
  })

  it('10 bài sạch lên bậc 2 — đúng mốc mở quyền tự đăng', () => {
    expect(approve(ZERO_TRUST, 10)).toEqual({ level: 2, cleanApprovals: 10 })
  })
})

describe('nextTrust — giáng bậc', () => {
  it('một lần bị từ chối: tụt đúng MỘT bậc và mất sạch chuỗi', () => {
    expect(reject({ level: 3, cleanApprovals: 15 })).toEqual({ level: 2, cleanApprovals: 0 })
  })

  it('bậc 0 bị từ chối không xuống âm', () => {
    expect(reject(ZERO_TRUST)).toEqual(ZERO_TRUST)
  })

  /**
   * Ca này khoá đúng bug của bản cũ: nó tính `level = floor(clean / 5)` mỗi lần duyệt, nên sau
   * một lần bị từ chối (chuỗi về 0) thì tin sạch TIẾP THEO cho ra `floor(1/5) = 0` — bậc 2 rơi
   * thẳng xuống 0. Một lần sai sót không được phép xoá sạch lịch sử.
   */
  it('duyệt sạch sau khi bị từ chối KHÔNG được kéo bậc xuống', () => {
    const afterReject = reject({ level: 3, cleanApprovals: 15 })
    expect(approve(afterReject).level).toBe(2)
    expect(approve(afterReject, 4).level).toBe(2)
  })

  it('làm lại đủ 5 bài sạch thì lấy lại bậc đã mất', () => {
    const afterReject = reject({ level: 3, cleanApprovals: 15 })
    expect(approve(afterReject, 5)).toEqual({ level: 3, cleanApprovals: 5 })
  })
})
