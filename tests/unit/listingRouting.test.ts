import { describe, it, expect } from 'vitest'
import {
  RoutingError,
  RoutingInput,
  routeListing,
} from '../../src/features/listing/listing.routing'
import { LISTING_STATUS, MODERATION_QUEUE, POST_VISIBILITY } from '../../src/common/constants'

const ORG = 'org-1'
const UNIT = 'unit-1'

const base: RoutingInput = {
  visibility: POST_VISIBILITY.ORG_INTERNAL,
  orgId: ORG,
  isMember: true,
  allowOutsiderPosts: false,
  hasCategoryModerator: true,
  unitId: UNIT,
  autoApprove: false,
}

const route = (patch: Partial<RoutingInput> = {}) => routeListing({ ...base, ...patch })

describe('Định tuyến tin — bốn ca của bảng §0.1', () => {
  it('org + nội bộ, tác giả là thành viên → hàng đợi org, giữ nhóm con', () => {
    expect(route()).toEqual({
      queue: MODERATION_QUEUE.ORG_MEMBER,
      status: LISTING_STATUS.PENDING,
      organizationId: ORG,
      unitId: UNIT,
    })
  })

  it('org + công khai → hàng đợi danh mục, org chỉ còn là attribution', () => {
    const result = route({ visibility: POST_VISIBILITY.PUBLIC })
    expect(result.queue).toBe(MODERATION_QUEUE.CATEGORY)
    expect(result.organizationId).toBe(ORG)
    // Nhóm con vô nghĩa ở trục danh mục — staff nhóm con không đụng tới tin này.
    expect(result.unitId).toBeNull()
  })

  it('không org + công khai → hàng đợi danh mục', () => {
    const result = route({ orgId: null, visibility: POST_VISIBILITY.PUBLIC, isMember: false })
    expect(result.queue).toBe(MODERATION_QUEUE.CATEGORY)
    expect(result.organizationId).toBeNull()
  })

  it('không org + nội bộ là vô nghĩa → chặn', () => {
    expect(() => route({ orgId: null, isMember: false })).toThrow(RoutingError)
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
    const result = route({ visibility: POST_VISIBILITY.PUBLIC, hasCategoryModerator: false })
    expect(result.queue).toBe(MODERATION_QUEUE.MASTER)
    expect(result.status).toBe(LISTING_STATUS.PENDING)
  })
})

describe('Tự đăng khi đủ uy tín', () => {
  it('thành viên đủ uy tín thì tin lên thẳng, chỉ hậu kiểm', () => {
    expect(route({ autoApprove: true }).status).toBe(LISTING_STATUS.ACTIVE)
  })

  it('trục công khai cũng vậy', () => {
    expect(route({ visibility: POST_VISIBILITY.PUBLIC, autoApprove: true }).status).toBe(
      LISTING_STATUS.ACTIVE,
    )
  })
})
