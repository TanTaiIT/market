import { describe, it, expect } from 'vitest'
import {
  RoutingError,
  RoutingInput,
  defaultReachFor,
  routeListing,
} from '../../src/features/listing/listing.routing'
import { LISTING_REACH, LISTING_STATUS, MODERATION_QUEUE } from '../../src/common/constants'

const ORG = 'org-1'
const UNIT = 'unit-1'

const base: RoutingInput = {
  reach: LISTING_REACH.MEMBERS,
  orgIsPublic: false,
  orgId: ORG,
  isMember: true,
  allowOutsiderPosts: false,
  hasCategoryModerator: true,
  unitId: UNIT,
  autoApprove: false,
}

const route = (patch: Partial<RoutingInput> = {}) => routeListing({ ...base, ...patch })

describe('Định tuyến tin — bảng 3×2 của thang phủ sóng', () => {
  it('org + members, tác giả là thành viên → hàng đợi org, giữ nhóm con', () => {
    expect(route()).toEqual({
      queue: MODERATION_QUEUE.ORG_MEMBER,
      status: LISTING_STATUS.PENDING,
      organizationId: ORG,
      unitId: UNIT,
    })
  })

  it('org + marketplace → hàng đợi danh mục, org chỉ còn là attribution', () => {
    const result = route({ reach: LISTING_REACH.MARKETPLACE })
    expect(result.queue).toBe(MODERATION_QUEUE.CATEGORY)
    expect(result.organizationId).toBe(ORG)
    // Nhóm con vô nghĩa ở bậc marketplace — staff nhóm con không đụng tới tin này.
    expect(result.unitId).toBeNull()
  })

  it('không org + marketplace → hàng đợi danh mục', () => {
    const result = route({ orgId: null, reach: LISTING_REACH.MARKETPLACE, isMember: false })
    expect(result.queue).toBe(MODERATION_QUEUE.CATEGORY)
    expect(result.organizationId).toBeNull()
  })

  it('không org + members là vô nghĩa → chặn', () => {
    expect(() => route({ orgId: null, isMember: false })).toThrow(RoutingError)
  })

  it('không org + group_open cũng vô nghĩa → chặn', () => {
    expect(() => route({ orgId: null, isMember: false, reach: LISTING_REACH.GROUP_OPEN })).toThrow(
      RoutingError,
    )
  })
})

/**
 * `group_open` là bậc DUY NHẤT có điều kiện nằm ngoài chính tin: nhóm phải đang công khai.
 * Chốt này có ở cả hai mép — mép tạo là đây, mép kia là `organizationService.setVisibility` hạ
 * bậc khi nhóm chuyển riêng tư. Thiếu một trong hai là có tin đọc công khai dưới một nhóm kín.
 */
describe('group_open đòi nhóm công khai', () => {
  it('nhóm riêng tư thì chặn', () => {
    expect(() => route({ reach: LISTING_REACH.GROUP_OPEN, orgIsPublic: false })).toThrow(/riêng tư/)
  })

  it('nhóm công khai thì vào HÀNG ĐỢI CỦA NHÓM, y như members', () => {
    const result = route({ reach: LISTING_REACH.GROUP_OPEN, orgIsPublic: true })
    expect(result.queue).toBe(MODERATION_QUEUE.ORG_MEMBER)
    // Bậc chỉ đổi AI ĐỌC ĐƯỢC, không đổi ai chịu trách nhiệm — nhóm con vẫn giữ nguyên.
    expect(result.unitId).toBe(UNIT)
  })

  it('người ngoài gửi vào nhóm công khai vẫn đi hàng đợi người-ngoài', () => {
    const result = route({
      reach: LISTING_REACH.GROUP_OPEN,
      orgIsPublic: true,
      isMember: false,
      allowOutsiderPosts: true,
    })
    expect(result.queue).toBe(MODERATION_QUEUE.ORG_OUTSIDER)
    expect(result.status).toBe(LISTING_STATUS.PENDING_UNVERIFIED)
  })
})

/** Bậc mặc định keyed theo NHÓM, không theo tư cách người đăng. */
describe('defaultReachFor', () => {
  it('không nhóm → marketplace', () => {
    expect(defaultReachFor({ orgId: null, isPublic: false })).toBe(LISTING_REACH.MARKETPLACE)
  })

  it('nhóm công khai → group_open, tức là người ngoài đọc được', () => {
    expect(defaultReachFor({ orgId: ORG, isPublic: true })).toBe(LISTING_REACH.GROUP_OPEN)
  })

  it('nhóm kín → members', () => {
    expect(defaultReachFor({ orgId: ORG, isPublic: false })).toBe(LISTING_REACH.MEMBERS)
  })
})

describe('Người ngoài gửi tin vào org', () => {
  it('org tắt nhận tin ngoài thì chặn', () => {
    expect(() => route({ isMember: false })).toThrow(/không nhận tin từ người ngoài/)
  })

  it('org bật thì vào hàng đợi RIÊNG với trạng thái riêng', () => {
    const result = route({ isMember: false, allowOutsiderPosts: true })
    expect(result.queue).toBe(MODERATION_QUEUE.ORG_OUTSIDER)
    expect(result.status).toBe(LISTING_STATUS.PENDING_UNVERIFIED)
    expect(result.unitId).toBeNull()
  })

  it('uy tín KHÔNG mua được quyền tự đăng vào org mình không thuộc về', () => {
    const result = route({ isMember: false, allowOutsiderPosts: true, autoApprove: true })
    expect(result.status).toBe(LISTING_STATUS.PENDING_UNVERIFIED)
  })
})

describe('Fallback về master', () => {
  it('ô (danh mục × tỉnh) chưa có ai phụ trách thì tin về master, không lửng lơ', () => {
    const result = route({ reach: LISTING_REACH.MARKETPLACE, hasCategoryModerator: false })
    expect(result.queue).toBe(MODERATION_QUEUE.MASTER)
    expect(result.status).toBe(LISTING_STATUS.PENDING)
  })
})

describe('Tự đăng khi đủ uy tín', () => {
  it('thành viên đủ uy tín thì tin lên thẳng, chỉ hậu kiểm', () => {
    expect(route({ autoApprove: true }).status).toBe(LISTING_STATUS.ACTIVE)
  })

  it('bậc marketplace cũng vậy', () => {
    expect(route({ reach: LISTING_REACH.MARKETPLACE, autoApprove: true }).status).toBe(
      LISTING_STATUS.ACTIVE,
    )
  })
})
