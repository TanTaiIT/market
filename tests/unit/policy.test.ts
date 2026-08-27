import { describe, it, expect } from 'vitest'
import {
  Grant,
  isMaster,
  canModerateOrg,
  canModerateCategory,
  canModerateListing,
  canGrant,
  canRevoke,
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

const LAMDONG = 'Lâm Đồng'
const WARD_LAGI = 'Phường La Gi'
const WARD_PHUOCHOI = 'Phường Phước Hội'
/** Phường THẬT của Lâm Đồng nhưng không được cấp — để chứng minh phạm vi vẫn hẹp. */
const WARD_DALAT = 'Phường Xuân Hương - Đà Lạt'

/** Ô của một tin. `wardCode` mặc định null: phần lớn ca dưới đây là ca của TẦNG TỈNH. */
const cell = (categoryId: string, provinceCode: string, wardCode: string | null = null) => ({
  categoryId,
  provinceCode,
  wardCode,
})

const catManagerWards: Grant = {
  role: SYSTEM_ROLES.MANAGER,
  scopeType: SCOPE_TYPES.CATEGORY_WARD,
  categoryId: CAT_JOB,
  provinceCodes: [LAMDONG],
  wardCodes: [WARD_LAGI, WARD_PHUOCHOI],
}
const catManagerLamDong: Grant = {
  role: SYSTEM_ROLES.MANAGER,
  scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
  categoryId: CAT_JOB,
  provinceCodes: [LAMDONG],
}

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
    expect(canModerateCategory([catManagerHcm], cell(CAT_JOB, HCM))).toBe(true)
  })

  it('KHÔNG thấy tin ngoài tỉnh và ngoài danh mục của mình', () => {
    expect(canModerateCategory([catManagerHcm], cell(CAT_JOB, HANOI))).toBe(false)
    expect(canModerateCategory([catManagerHcm], cell(CAT_BOOK, HCM))).toBe(false)
  })

  it('provinceCodes rỗng nghĩa là toàn quốc, không phải không tỉnh nào', () => {
    expect(canModerateCategory([catManagerNationwide], cell(CAT_JOB, HANOI))).toBe(true)
  })

  it('hai trục không giao nhau: quyền org không mở được tin trục danh mục và ngược lại', () => {
    expect(canModerateCategory([orgManager], cell(CAT_JOB, HCM))).toBe(false)
    expect(canModerateOrg([catManagerHcm], { orgId: ORG_A })).toBe(false)
  })
})

/**
 * Tầng phường — tầng dưới của tầng tỉnh.
 *
 * Đây là chỗ chốt lời hứa "phân cấp": grant tỉnh phủ mọi phường trong tỉnh, còn grant phường thì
 * hẹp đúng những phường được ghi. Thiếu vế thứ hai thì 3.321 phường × N danh mục đổ hết về master.
 */
describe('policy - trục danh mục: tầng phường', () => {
  it('manager phường duyệt đúng phường được cấp', () => {
    expect(canModerateCategory([catManagerWards], cell(CAT_JOB, LAMDONG, WARD_LAGI))).toBe(true)
    expect(canModerateCategory([catManagerWards], cell(CAT_JOB, LAMDONG, WARD_PHUOCHOI))).toBe(true)
  })

  it('KHÔNG với sang phường khác trong cùng tỉnh', () => {
    expect(canModerateCategory([catManagerWards], cell(CAT_JOB, LAMDONG, WARD_DALAT))).toBe(false)
  })

  it('KHÔNG với sang danh mục khác dù đúng phường', () => {
    expect(canModerateCategory([catManagerWards], cell(CAT_BOOK, LAMDONG, WARD_LAGI))).toBe(false)
  })

  it('grant cấp TỈNH phủ mọi phường của tỉnh đó', () => {
    expect(canModerateCategory([catManagerLamDong], cell(CAT_JOB, LAMDONG, WARD_LAGI))).toBe(true)
    expect(canModerateCategory([catManagerLamDong], cell(CAT_JOB, LAMDONG, WARD_DALAT))).toBe(true)
  })

  it('tin CHƯA có phường (dữ liệu trước migration): chỉ tầng tỉnh đỡ được', () => {
    expect(canModerateCategory([catManagerLamDong], cell(CAT_JOB, LAMDONG))).toBe(true)
    expect(canModerateCategory([catManagerWards], cell(CAT_JOB, LAMDONG))).toBe(false)
  })
})

describe('policy - ai cấp được quyền cho ai', () => {
  const actorMaster = { userId: 'u-master', grants: [master] }
  const actorOrgManager = { userId: 'u-org-mgr', grants: [orgManager] }
  const actorCatManager = { userId: 'u-cat-mgr', grants: [catManagerHcm] }

  const staffInOrgA: Grant = { role: SYSTEM_ROLES.STAFF, scopeType: SCOPE_TYPES.ORG, orgId: ORG_A }

  it('master cấp được manager và quản lý danh mục cho người khác', () => {
    expect(canGrant(actorMaster, { userId: 'u1', grant: orgManager })).toBe(true)
    expect(canGrant(actorMaster, { userId: 'u1', grant: catManagerHcm })).toBe(true)
  })

  /**
   * TRẦN của bất biến một-master. Chốt `§5.4` bên `role-grant.service` chỉ giữ SÀN (luôn còn
   * ≥1 master); không có vế này thì một master bấm nhầm là hệ thống có hai người nắm quyền cao
   * nhất, mà không phép kiểm nào phân biệt được cái nào mới đúng.
   *
   * Master là dữ liệu mặc định do `scripts/migrate-master.ts` dựng cùng database — không có
   * đường runtime nào sinh ra nó, kể cả từ chính master.
   */
  it('KHÔNG ai cấp được role master, kể cả master', () => {
    expect(canGrant(actorMaster, { userId: 'u1', grant: master })).toBe(false)
    expect(canGrant(actorOrgManager, { userId: 'u1', grant: master })).toBe(false)
    expect(canGrant(actorCatManager, { userId: 'u1', grant: master })).toBe(false)
  })

  /** `canRevoke === canGrant`, nên cấm cấp cũng là cấm thu hồi: master không gỡ được qua API. */
  it('KHÔNG ai thu hồi được role master', () => {
    expect(canRevoke(actorMaster, { userId: 'u1', grant: master })).toBe(false)
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

  /**
   * §5.3 ở tầng phường: manager TỈNH chia tải xuống từng phường, manager PHƯỜNG chỉ chia lại
   * trong chính phường mình giữ. Không có vế này thì người phụ trách tỉnh vẫn phải tự duyệt hết.
   */
  it('manager tỉnh cấp được staff cho phường TRONG tỉnh mình', () => {
    const actorLamDong = { userId: 'u-ld-mgr', grants: [catManagerLamDong] }
    const staffWard: Grant = {
      role: SYSTEM_ROLES.STAFF,
      scopeType: SCOPE_TYPES.CATEGORY_WARD,
      categoryId: CAT_JOB,
      provinceCodes: [LAMDONG],
      wardCodes: [WARD_LAGI],
    }
    expect(canGrant(actorLamDong, { userId: 'u1', grant: staffWard })).toBe(true)

    // Phường của TỈNH KHÁC thì không: phạm vi địa lý không nới ra được bằng cách xuống tầng.
    const staffWardOtherProvince: Grant = { ...staffWard, provinceCodes: [HCM] }
    expect(canGrant(actorLamDong, { userId: 'u1', grant: staffWardOtherProvince })).toBe(false)
  })

  it('manager phường chỉ cấp lại được trong chính phường mình giữ', () => {
    const actorWards = { userId: 'u-ward-mgr', grants: [catManagerWards] }
    const staffLaGi: Grant = {
      role: SYSTEM_ROLES.STAFF,
      scopeType: SCOPE_TYPES.CATEGORY_WARD,
      categoryId: CAT_JOB,
      provinceCodes: [LAMDONG],
      wardCodes: [WARD_LAGI],
    }
    expect(canGrant(actorWards, { userId: 'u1', grant: staffLaGi })).toBe(true)

    const staffDaLat: Grant = { ...staffLaGi, wardCodes: [WARD_DALAT] }
    expect(canGrant(actorWards, { userId: 'u1', grant: staffDaLat })).toBe(false)

    // Cấp CẢ TỈNH trong khi mình chỉ giữ hai phường là cấp quá cấp mình.
    const staffWholeProvince: Grant = {
      role: SYSTEM_ROLES.STAFF,
      scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
      categoryId: CAT_JOB,
      provinceCodes: [LAMDONG],
    }
    expect(canGrant(actorWards, { userId: 'u1', grant: staffWholeProvince })).toBe(false)
  })
  it('user thường không cấp được gì', () => {
    expect(canGrant({ userId: 'u-plain', grants: [] }, { userId: 'u1', grant: staffInOrgA })).toBe(
      false,
    )
  })
})

/**
 * `canModerateListing` chọn nhánh theo TRỤC CỦA TIN. Nó là chốt duy nhất đứng giữa
 * `listingService.setModerationStatus` và mọi người gọi — kể cả `report.service`, vốn từng đi
 * vòng qua phép kiểm khi nó còn nằm trong `moderation.service`.
 */
describe('canModerateListing — trục của tin chọn người có thẩm quyền', () => {
  const publicInJobHcm = {
    visibility: 'public' as const,
    organizationId: null,
    unitId: null,
    categoryId: CAT_JOB,
    provinceCode: HCM,
    wardCode: null,
  }
  const internalOfOrgA = {
    visibility: 'org_internal' as const,
    organizationId: ORG_A,
    unitId: UNIT_1,
    categoryId: CAT_JOB,
    provinceCode: null,
    wardCode: null,
  }

  const orgManagerA: Grant[] = [
    { role: SYSTEM_ROLES.MANAGER, scopeType: SCOPE_TYPES.ORG, orgId: ORG_A },
  ]
  const catManagerJobHcm: Grant[] = [
    {
      role: SYSTEM_ROLES.MANAGER,
      scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
      categoryId: CAT_JOB,
      provinceCodes: [HCM],
    },
  ]

  it('quyền org KHÔNG với tới tin trục danh mục', () => {
    expect(canModerateListing(orgManagerA, publicInJobHcm)).toBe(false)
  })

  it('quyền đúng ô (danh mục × tỉnh) thì với tới', () => {
    expect(canModerateListing(catManagerJobHcm, publicInJobHcm)).toBe(true)
  })

  it('sai danh mục hoặc sai tỉnh thì không', () => {
    expect(canModerateListing(catManagerJobHcm, { ...publicInJobHcm, categoryId: CAT_BOOK })).toBe(
      false,
    )
    expect(canModerateListing(catManagerJobHcm, { ...publicInJobHcm, provinceCode: HANOI })).toBe(
      false,
    )
  })

  it('ngược lại: quyền danh mục KHÔNG với tới tin nội bộ của org', () => {
    expect(canModerateListing(catManagerJobHcm, internalOfOrgA)).toBe(false)
    expect(canModerateListing(orgManagerA, internalOfOrgA)).toBe(true)
  })

  it('staff nhóm con chỉ duyệt được tin của nhóm mình', () => {
    const staffUnit1: Grant[] = [
      {
        role: SYSTEM_ROLES.STAFF,
        scopeType: SCOPE_TYPES.ORG_UNIT,
        orgId: ORG_A,
        unitId: UNIT_1,
      },
    ]
    expect(canModerateListing(staffUnit1, internalOfOrgA)).toBe(true)
    expect(canModerateListing(staffUnit1, { ...internalOfOrgA, unitId: UNIT_2 })).toBe(false)
    // Tin không ghi nhóm con phải đẩy lên manager org, không rơi vào tay staff bất kỳ.
    expect(canModerateListing(staffUnit1, { ...internalOfOrgA, unitId: null })).toBe(false)
  })

  it('tin công khai thiếu tỉnh: chỉ grant toàn quốc mới với tới', () => {
    const nationwide: Grant[] = [
      {
        role: SYSTEM_ROLES.MANAGER,
        scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
        categoryId: CAT_JOB,
        provinceCodes: [],
      },
    ]
    const noProvince = { ...publicInJobHcm, provinceCode: null }
    expect(canModerateListing(catManagerJobHcm, noProvince)).toBe(false)
    expect(canModerateListing(nationwide, noProvince)).toBe(true)
  })
})

/**
 * `canModerateListing` ở tầng phường: trục của TIN vẫn là thứ chọn người có thẩm quyền, chỉ khác
 * là ô của tin giờ hẹp tới phường.
 */
describe('canModerateListing — tầng phường', () => {
  const publicInLagi = {
    visibility: 'public' as const,
    organizationId: null,
    unitId: null,
    categoryId: CAT_JOB,
    provinceCode: LAMDONG,
    wardCode: WARD_LAGI,
  }

  it('quyền đúng phường thì với tới, sai phường thì không', () => {
    expect(canModerateListing([catManagerWards], publicInLagi)).toBe(true)
    expect(canModerateListing([catManagerWards], { ...publicInLagi, wardCode: WARD_DALAT })).toBe(
      false,
    )
  })

  it('quyền cấp tỉnh vẫn phủ tin của mọi phường trong tỉnh', () => {
    expect(canModerateListing([catManagerLamDong], publicInLagi)).toBe(true)
    expect(canModerateListing([catManagerLamDong], { ...publicInLagi, wardCode: WARD_DALAT })).toBe(
      true,
    )
  })

  it('master vẫn là fallback của mọi ô', () => {
    expect(canModerateListing([master], { ...publicInLagi, wardCode: WARD_DALAT })).toBe(true)
  })
})
