import { describe, it, expect } from 'vitest'
import {
  Grant,
  isMaster,
  canModerateOrg,
  canModerateCategory,
  canGrant,
} from '../../src/common/authz/policy'
import { SYSTEM_ROLES, SCOPE_TYPES } from '../../src/common/constants'

// Phân quyền là ranh giới bảo mật: tầng policy thuần nên không có cớ gì để không test kín.
const ORG_A = 'org-a'
const ORG_B = 'org-b'
const UNIT_1 = 'unit-1'
const UNIT_2 = 'unit-2'
const CAT_JOB = 'cat-job'
const CAT_BOOK = 'cat-book'
const HCM = 'Hồ Chí Minh'
const HANOI = 'Hà Nội'

const master: Grant = { role: SYSTEM_ROLES.MASTER, scopeType: SCOPE_TYPES.SYSTEM }
const orgManager: Grant = {
  role: SYSTEM_ROLES.MANAGER,
  scopeType: SCOPE_TYPES.ORG,
  orgId: ORG_A,
}
const unitStaff: Grant = {
  role: SYSTEM_ROLES.STAFF,
  scopeType: SCOPE_TYPES.ORG_UNIT,
  orgId: ORG_A,
  unitId: UNIT_1,
}
const catManagerHcm: Grant = {
  role: SYSTEM_ROLES.MANAGER,
  scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
  categoryId: CAT_JOB,
  provinceCodes: [HCM],
}
const catManagerNationwide: Grant = {
  role: SYSTEM_ROLES.MANAGER,
  scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
  categoryId: CAT_JOB,
  provinceCodes: [],
}

describe('policy - nhận diện master', () => {
  it('chỉ master scope system mới là master', () => {
    expect(isMaster([master])).toBe(true)
    expect(isMaster([orgManager, unitStaff])).toBe(false)
  })
})

describe('policy - trục org', () => {
  it('manager org duyệt được mọi tin trong org, kể cả tin không có nhóm con', () => {
    expect(canModerateOrg([orgManager], { orgId: ORG_A, unitId: UNIT_1 })).toBe(true)
    expect(canModerateOrg([orgManager], { orgId: ORG_A, unitId: null })).toBe(true)
  })

  it('manager org KHÔNG với sang org khác', () => {
    expect(canModerateOrg([orgManager], { orgId: ORG_B })).toBe(false)
  })

  it('staff nhóm con chỉ duyệt đúng nhóm của mình', () => {
    expect(canModerateOrg([unitStaff], { orgId: ORG_A, unitId: UNIT_1 })).toBe(true)
    expect(canModerateOrg([unitStaff], { orgId: ORG_A, unitId: UNIT_2 })).toBe(false)
    // Tin không thuộc nhóm nào phải đẩy lên manager org, không rơi vào tay staff nhóm con.
    expect(canModerateOrg([unitStaff], { orgId: ORG_A, unitId: null })).toBe(false)
  })

  it('master duyệt được mọi org', () => {
    expect(canModerateOrg([master], { orgId: ORG_B, unitId: UNIT_2 })).toBe(true)
  })
})

describe('policy - trục danh mục', () => {
  it('manager danh mục duyệt đúng danh mục tại đúng tỉnh được cấp', () => {
    expect(canModerateCategory([catManagerHcm], { categoryId: CAT_JOB, provinceCode: HCM })).toBe(
      true,
    )
  })

  it('KHÔNG thấy tin ngoài tỉnh và ngoài danh mục của mình', () => {
    expect(canModerateCategory([catManagerHcm], { categoryId: CAT_JOB, provinceCode: HANOI })).toBe(
      false,
    )
    expect(canModerateCategory([catManagerHcm], { categoryId: CAT_BOOK, provinceCode: HCM })).toBe(
      false,
    )
  })

  it('provinceCodes rỗng nghĩa là toàn quốc, không phải không tỉnh nào', () => {
    expect(
      canModerateCategory([catManagerNationwide], { categoryId: CAT_JOB, provinceCode: HANOI }),
    ).toBe(true)
  })

  it('hai trục không giao nhau: quyền org không mở được tin trục danh mục và ngược lại', () => {
    expect(canModerateCategory([orgManager], { categoryId: CAT_JOB, provinceCode: HCM })).toBe(
      false,
    )
    expect(canModerateOrg([catManagerHcm], { orgId: ORG_A })).toBe(false)
  })
})

describe('policy - ai cấp được quyền cho ai', () => {
  const actorMaster = { userId: 'u-master', grants: [master] }
  const actorOrgManager = { userId: 'u-org-mgr', grants: [orgManager] }
  const actorCatManager = { userId: 'u-cat-mgr', grants: [catManagerHcm] }

  const staffInOrgA: Grant = { role: SYSTEM_ROLES.STAFF, scopeType: SCOPE_TYPES.ORG, orgId: ORG_A }

  it('master cấp được mọi thứ cho người khác', () => {
    expect(canGrant(actorMaster, { userId: 'u1', grant: orgManager })).toBe(true)
    expect(canGrant(actorMaster, { userId: 'u1', grant: catManagerHcm })).toBe(true)
    expect(canGrant(actorMaster, { userId: 'u1', grant: master })).toBe(true)
  })

  it('không ai tự nâng quyền cho chính mình, kể cả master', () => {
    expect(canGrant(actorMaster, { userId: actorMaster.userId, grant: master })).toBe(false)
  })

  it('manager cấp staff trong scope mình, không cấp quá cấp mình', () => {
    expect(canGrant(actorOrgManager, { userId: 'u1', grant: staffInOrgA })).toBe(true)
    expect(canGrant(actorOrgManager, { userId: 'u1', grant: unitStaff })).toBe(true)
    // Cấp manager = cấp ngang cấp mình -> chỉ master làm được.
    expect(canGrant(actorOrgManager, { userId: 'u1', grant: orgManager })).toBe(false)
  })

  it('manager org không cấp được quyền ở org khác', () => {
    const staffInOrgB: Grant = { ...staffInOrgA, orgId: ORG_B }
    expect(canGrant(actorOrgManager, { userId: 'u1', grant: staffInOrgB })).toBe(false)
  })

  it('manager danh mục không cấp được staff phủ rộng hơn phạm vi của mình', () => {
    const staffHcm: Grant = {
      role: SYSTEM_ROLES.STAFF,
      scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
      categoryId: CAT_JOB,
      provinceCodes: [HCM],
    }
    expect(canGrant(actorCatManager, { userId: 'u1', grant: staffHcm })).toBe(true)

    const staffTwoProvinces: Grant = { ...staffHcm, provinceCodes: [HCM, HANOI] }
    expect(canGrant(actorCatManager, { userId: 'u1', grant: staffTwoProvinces })).toBe(false)

    // Toàn quốc trong khi mình chỉ có TP.HCM cũng là cấp quá cấp mình.
    const staffNationwide: Grant = { ...staffHcm, provinceCodes: [] }
    expect(canGrant(actorCatManager, { userId: 'u1', grant: staffNationwide })).toBe(false)
  })

  it('user thường không cấp được gì', () => {
    expect(canGrant({ userId: 'u-plain', grants: [] }, { userId: 'u1', grant: staffInOrgA })).toBe(
      false,
    )
  })
})
