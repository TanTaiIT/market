import { Types } from 'mongoose'
import { roleGrantRepository } from './role-grant.repository'
import { toPolicyGrant, toRoleGrantDto } from './role-grant.types'
import type { UpdateGrantScopeInput } from './role-grant.schema'
import { userRepository } from '../user/user.repository'
import { categoryService } from '../category/category.service'
import { Grant, canGrant, canRevoke, categoryScopesOverlap } from '../../common/authz/policy'
import {
  AXIS_LABEL,
  SCOPE_TYPES,
  SYSTEM_ROLES,
  SystemRole,
  ScopeType,
  axisOf,
} from '../../common/constants'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors'
import { logger } from '../../config/logger'

export interface GrantInput {
  /** Đúng một trong hai — `createRoleGrantSchema` chốt, `resolveRecipientId` quy về id. */
  userId?: string
  userEmail?: string
  role: SystemRole
  scopeType: ScopeType
  orgId?: string | null
  unitId?: string | null
  categoryId?: string | null
  provinceCodes?: string[]
  wardCodes?: string[]
}

/**
 * Còn bao nhiêu master ĐĂNG NHẬP ĐƯỢC nếu bỏ `excludeUserId` ra khỏi danh sách — chốt §5.4.
 *
 * Hai điểm khiến nó không phải là một phép `countDocuments` trên `role_grants`:
 * (1) xoá mềm tài khoản không thu hồi grant, nên grant còn đó mà người thì không vào được nữa;
 * (2) loại trừ chính chủ nhân của grant sắp gỡ, thay vì so tổng với 1 — đếm tổng sẽ chặn nhầm
 *     ca "gỡ grant của một master đã xoá tài khoản" trong khi vẫn còn đúng một master sống.
 *
 * Master rất ít nên hai lượt truy vấn nhỏ rẻ hơn một `$lookup`, và đọc ra ý định rõ hơn hẳn.
 */
/**
 * Org PHẢI có ít nhất một quản trị còn dùng được — bất biến của hệ thống, không phải khuyến nghị.
 *
 * Phía sinh ra đã đúng từ trước: org mới nằm ở `TENANT_STATUS.PENDING_ADMIN` và chỉ `ACTIVE` khi
 * `organizationService.grantAdmin` chạy, nên một org chưa có ai phụ trách thì phần còn lại của
 * hệ thống không nhìn thấy nó. Ba hàm dưới đây khoá phía NGƯỢC LẠI — lấy đi người phụ trách cuối
 * cùng của một org đang chạy — thứ mà trước đây không có gì chặn.
 *
 * Vì sao chặn thay vì tự hạ org về `PENDING_ADMIN`: hạ trạng thái nghĩa là một org đang hoạt
 * động đột ngột đóng cửa với toàn bộ thành viên vì một thao tác quản trị ở chỗ khác — hậu quả
 * lớn hơn hẳn nguyên nhân, và người gây ra nó không thấy gì. Từ chối kèm câu "trao quyền cho
 * người khác trước" đặt việc sửa vào đúng tay người đang có ngữ cảnh.
 *
 * Đếm theo NGƯỜI CÒN DÙNG ĐƯỢC, không theo grant — xem `listActiveOrgAdminUserIds`.
 */
export async function usableOrgAdmins(
  orgId: Types.ObjectId | string,
  exclude: { userId?: Types.ObjectId | string; grantId?: Types.ObjectId | string } = {},
): Promise<number> {
  const ids = await roleGrantRepository.listActiveOrgAdminUserIds(orgId, exclude.grantId)
  const others = exclude.userId ? ids.filter((id) => !id.equals(exclude.userId!)) : ids
  return userRepository.countUsable(others)
}

export async function usableMastersExcluding(
  excludeUserId: Types.ObjectId | string,
): Promise<number> {
  const ids = await roleGrantRepository.listActiveMasterUserIds()
  const others = ids.filter((id) => !id.equals(excludeUserId))
  return userRepository.countUsable(others)
}

function toId(value?: string | null): Types.ObjectId | null {
  return value ? new Types.ObjectId(value) : null
}

function asPolicyGrant(input: GrantInput): Grant {
  return {
    role: input.role,
    scopeType: input.scopeType,
    orgId: input.orgId ?? null,
    unitId: input.unitId ?? null,
    categoryId: input.categoryId ?? null,
    provinceCodes: input.provinceCodes ?? [],
    wardCodes: input.wardCodes ?? [],
  }
}

/**
 * Quy người nhận về `userId`.
 *
 * Email tồn tại vì không phải người cấp nào cũng có danh bạ để chọn ra id: manager trục
 * (danh mục × tỉnh) không thuộc tổ chức nào, mà email là thứ họ thật sự biết về người mình
 * định giao việc. Cùng đường `organization.grantAdmin` đã đi cho người phụ trách org — và
 * cũng cùng giới hạn: người nhận phải CÓ TÀI KHOẢN trước, đây không phải đường mời người mới.
 *
 * Quy đổi trước khi `canGrant` chạy, nên email không nới thêm một chút thẩm quyền nào: vẫn
 * đúng luật `covers()` như khi truyền id.
 */
async function resolveRecipientId(input: GrantInput): Promise<string> {
  if (input.userId) return input.userId
  // Zod đã chặn ca thiếu cả hai; giữ nhánh này để service còn đúng khi được gọi ngoài route.
  if (!input.userEmail) throw new BadRequestError('Cần userId hoặc userEmail')

  const user = await userRepository.findByEmail(input.userEmail)
  if (!user) {
    throw new NotFoundError(
      `Chưa có tài khoản nào dùng email ${input.userEmail} — người nhận phải đăng ký trước`,
    )
  }
  return user._id.toString()
}

/**
 * Lỗi hình dạng phạm vi từ `enforceScopeShape` → 400, không phải 500.
 *
 * Hook `pre('validate')` của model gọi `next(new Error(...))` với một Error TRƠN. Nó không
 * phải `mongoose.Error.ValidationError`, nên error handler không nhận ra và trả 500 — trong
 * khi đây đúng là lỗi của người gửi ("category_ward cần ít nhất một phường").
 *
 * Nhận diện bằng `constructor === Error`, không bằng chuỗi thông điệp: thông điệp nằm rải
 * trong model và sẽ đổi, còn mọi lỗi KHÁC ở đường này đều là lớp con — `ValidationError`,
 * `CastError`, `MongoServerError`, `MongoNetworkError`. Bắt theo chuỗi là bỏ sót luật mới
 * thêm; bắt tất cả là biến một sự cố mạng thành 400.
 */
function asScopeShapeError(err: unknown): never {
  if (err instanceof Error && err.constructor === Error) throw new BadRequestError(err.message)
  throw err
}

const CATEGORY_AXIS: ScopeType[] = [SCOPE_TYPES.CATEGORY_PROVINCE, SCOPE_TYPES.CATEGORY_WARD]

/**
 * MỘT NGƯỜI, MỘT TRỤC — quản trị nhóm và phụ trách danh mục loại trừ nhau.
 *
 * Lý do nghiệp vụ nằm ở `axisOf` bên constants. Ở đây chỉ nói phần kỹ thuật:
 *
 * Chốt phải là một hàm DÙNG CHUNG chứ không nằm gọn trong `roleGrantService.grant`, vì có HAI
 * đường tạo grant và chúng không đi qua nhau: đường này, và `organizationService.grantAdmin`
 * (gọi thẳng `roleGrantRepository.create` — đó là lượt cấp dựng nên quản trị đầu tiên của một
 * nhóm, và cũng là lượt đưa org từ `pending_admin` sang `active`). Chặn một đường là để hở đường
 * kia, mà đường kia lại chính là nơi một người phụ trách danh mục dễ được trao thêm nhóm nhất.
 *
 * KHÔNG đặt trong hook của model dù mọi lượt ghi đều qua đó: hook sẽ chạy cả với seed và
 * migration — hai thứ có quyền dựng dữ liệu ở trạng thái mà API không cho phép — và một chốt
 * async trong `pre('validate')` biến mỗi lượt ghi thành thêm một vòng DB. Cùng lập luận đã đặt
 * `assertNoManagerOverlap` ở tầng service.
 *
 * Chỉ xét grant CÒN HIỆU LỰC: thu hồi quyền cũ rồi giao trục kia là đường đi hợp lệ, và phải
 * thông. `revokedAt` đã lọc sẵn trong `listActiveByUser`.
 */
export async function assertSingleAxis(
  userId: Types.ObjectId | string,
  nextScope: ScopeType,
): Promise<void> {
  const next = axisOf(nextScope)
  // `system` đứng ngoài cả hai trục — master phủ mọi thứ theo thiết kế, không phải một chân
  // trong bàn duyệt nào.
  if (!next) return

  const active = await roleGrantRepository.listActiveByUser(userId)
  const clash = active.find((doc) => {
    const held = axisOf(doc.scopeType)
    return held !== null && held !== next
  })
  if (!clash) return

  const heldAxis = axisOf(clash.scopeType)!
  throw new ConflictError(
    `Tài khoản này đang là ${AXIS_LABEL[heldAxis]} — một người chỉ đứng trên MỘT trục duyệt. ` +
      `Thu hồi quyền đang có trước khi giao vai ${AXIS_LABEL[next]}.`,
  )
}

/**
 * MỘT Ô, MỘT NGƯỜI PHỤ TRÁCH — chặn hai manager cùng phủ một ô (danh mục × tỉnh × phường).
 *
 * Index unique trên model KHÔNG thay được chốt này: nó khoá theo `userId`, nên nó chỉ chặn một
 * người được cấp hai lần, còn hai NGƯỜI khác nhau cùng một ô thì lọt. Mà Mongo cũng không có
 * unique index nào diễn đạt được 'hai mảng giao nhau', nên chốt phải nằm ở đây.
 *
 * Lọc `manager` ở CẢ HAI vế không phải để chừa chỗ cho vai khác: `staff` đã bị bỏ khỏi trục này
 * (`createRoleGrantSchema` trả 400 nếu gửi lên), nên qua API mọi grant ở đây đều là manager.
 * Vế lọc chỉ để những dòng `staff` CŨ còn sót trong DB — do seed hoặc do thời còn cấp phó —
 * không chặn nhầm một lượt cấp hợp lệ.
 *
 * Không loại trừ chính người đang giữ: một người ôm cả grant tỉnh lẫn grant phường trong cùng
 * tỉnh là dữ liệu thừa, không phải quyền rộng hơn — đường đúng là `updateScope`.
 *
 * ĐÁNH ĐỔI, nói rõ: kiểm-rồi-ghi, nên hai lượt cấp chạy song song vẫn lọt được cả hai. Chấp
 * nhận vì đây là thao tác tay của master trên một bảng vài chục dòng, không phải đường nóng.
 */
async function assertNoManagerOverlap(next: Grant, exceptGrantId?: Types.ObjectId) {
  if (next.role !== SYSTEM_ROLES.MANAGER || !CATEGORY_AXIS.includes(next.scopeType)) return

  const active = await roleGrantRepository.listCategoryAxisGrantsFiltered({
    categoryId: next.categoryId!,
  })
  const clash = active.find(
    (doc) =>
      doc.role === SYSTEM_ROLES.MANAGER &&
      !doc._id.equals(exceptGrantId ?? new Types.ObjectId()) &&
      categoryScopesOverlap(toPolicyGrant(doc), next),
  )
  if (!clash) return

  // Nêu TÊN người đang giữ: 'ô đã có người' mà không nói ai thì master phải đi mò bảng phủ
  // sóng để biết cần thu hồi của ai.
  const holder = await userRepository.findById(clash.userId.toString())
  throw new ConflictError(
    `Ô đó đã do ${holder?.name ?? 'một tài khoản khác'} phụ trách — thu hồi hoặc sửa phạm vi của họ trước`,
  )
}

export const roleGrantService = {
  /**
   * AI ĐANG PHỤ TRÁCH DANH MỤC NÀO — bảng master mở để biết gọi ai, và để thu hồi.
   *
   * Tồn tại vì trước đó không có đường nào trả lời câu này: ma trận phủ sóng chỉ nói ô CÓ hay
   * KHÔNG có người (`hasModerator`), còn `/role-grants/mine` chỉ trả quyền của chính người gọi.
   * Hệ quả nặng hơn là `DELETE /role-grants/:id` vốn đã cho master thu hồi quyền của bất kỳ ai
   * nhưng master không có cách nào lấy được `id` đó — một khả năng nằm im không dùng được, và
   * cấp quyền trên thực tế là đường một chiều.
   *
   * `id` của grant nằm trong DTO chính vì vậy: nó là thứ duy nhất `revoke` nhận.
   *
   * Ghép danh tính và tên danh mục theo LÔ, không phải một truy vấn cho mỗi dòng — bảng này
   * liệt kê mọi grant trục danh mục của cả hệ thống.
   */
  async listCategoryAxis(filter: { categoryId?: string; province?: string }) {
    const grants = await roleGrantRepository.listCategoryAxisGrantsFiltered(filter)
    if (grants.length === 0) return []

    const [users, categories] = await Promise.all([
      userRepository.findByIds(
        [...new Set(grants.map((g) => g.userId.toString()))].map((id) => new Types.ObjectId(id)),
      ),
      categoryService.list({ includeInactive: true }),
    ])

    const userById = new Map(users.map((u) => [u._id.toString(), u]))
    const categoryName = new Map(categories.map((c) => [c.id, c.name]))

    return grants.map((g) => {
      const holder = userById.get(g.userId.toString())
      return {
        ...toRoleGrantDto(g),
        /*
         * Tài khoản đã xoá mềm vẫn giữ grant (xoá tài khoản KHÔNG thu hồi quyền — xem
         * `usableMastersExcluding`). Bảng phải nói ra thay vì giấu dòng đó: một ô do một tài
         * khoản chết phụ trách nhìn như "đã có người" ở mọi chỗ khác, và đó chính là ô master
         * cần thấy nhất.
         */
        holderName: holder?.name ?? 'Tài khoản không còn',
        holderEmail: holder?.email ?? '',
        /*
         * `isActive`, đúng cờ mà `countUsable` dùng để đếm "người còn dùng được". Tài khoản
         * xoá mềm không lọt tới đây: model có hook `this.where({ deletedAt: null })`, nên
         * `holder` vắng mặt và rơi vào nhánh "Tài khoản không còn" ngay trên.
         */
        holderActive: Boolean(holder?.isActive),
        categoryName: g.categoryId ? (categoryName.get(g.categoryId.toString()) ?? 'Khác') : '',
      }
    })
  },

  /** Nạp quyền của một người về dạng tầng policy hiểu được. */
  async grantsOf(userId: string): Promise<Grant[]> {
    const docs = await roleGrantRepository.listActiveByUser(userId)
    return docs.map(toPolicyGrant)
  },

  async grant(actorId: string, input: GrantInput) {
    const userId = await resolveRecipientId(input)
    const actorGrants = await this.grantsOf(actorId)
    const grant = asPolicyGrant(input)

    if (!canGrant({ userId: actorId, grants: actorGrants }, { userId, grant })) {
      throw new ForbiddenError('Không đủ thẩm quyền để cấp quyền này')
    }
    await assertSingleAxis(userId, input.scopeType)
    await assertNoManagerOverlap(grant)

    try {
      const doc = await roleGrantRepository.create({
        userId: new Types.ObjectId(userId),
        role: input.role,
        scopeType: input.scopeType,
        orgId: toId(input.orgId),
        unitId: toId(input.unitId),
        categoryId: toId(input.categoryId),
        provinceCodes: input.provinceCodes ?? [],
        wardCodes: input.wardCodes ?? [],
        grantedBy: new Types.ObjectId(actorId),
      })
      logger.info('role-grant granted', { actorId, targetUserId: userId, ...grant })
      return toRoleGrantDto(doc)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // Index unique không phân biệt danh sách phường, nên grant phường thứ hai trong cùng
        // danh mục đụng nó. Đường đúng giờ là SỬA grant sẵn có (`updateScope`) với đủ danh
        // sách phường — nó giữ nguyên `grantedAt` và ghi cả phạm vi trước lẫn sau vào log,
        // nên không còn đánh đổi "sửa tại chỗ thì mất vết" như hồi chỉ có cấp/thu hồi.
        if (input.scopeType === SCOPE_TYPES.CATEGORY_WARD) {
          throw new ConflictError(
            'Người này đã có quyền phường trong danh mục đó — thu hồi rồi cấp lại với đủ danh sách phường',
          )
        }
        throw new ConflictError('Người này đã có đúng quyền đó')
      }
      // Hình dạng phạm vi sai cũng từng ra 500 ở đường CẤP — cùng một hook, cùng một lỗi trơn.
      return asScopeShapeError(err)
    }
  },

  /**
   * Đổi PHẠM VI của một grant trục danh mục — nâng từ vài phường lên cả tỉnh, đổi danh mục,
   * thêm bớt tỉnh.
   *
   * Trước đây không có đường này: role-grant chỉ có cấp và thu hồi, nên "sửa" nghĩa là gỡ rồi
   * cấp lại — đứt vết kiểm toán (`grantedAt` nhảy về hôm nay), và có một khoảng thời gian ô đó
   * KHÔNG ai phụ trách. Giữ nguyên `_id` và `grantedAt` là giữ nguyên lịch sử.
   *
   * CHỈ trục danh mục, và chỉ đổi qua lại giữa hai tầng của nó. Đây không phải giới hạn cho
   * gọn mà là một chốt an toàn: cho phép biến một grant `org` thành `category_province` sẽ lấy
   * đi người quản trị cuối cùng của một nhóm mà KHÔNG chạm chốt `usableOrgAdmins` — chốt đó
   * nằm trong `revoke`, và một lượt sửa thì không đi qua đó. Đổi trục = thu hồi rồi cấp lại,
   * để đúng chốt kia chạy.
   *
   * Thay TOÀN BỘ phạm vi, không vá từng field: hạ từ tầng phường xuống tầng tỉnh đòi phải xoá
   * `wardCodes`, và một PATCH bán phần khiến việc đó thành thao tác dễ quên nhất trong form.
   *
   * Hình dạng phạm vi (tỉnh nào hợp lệ, phường có thuộc tỉnh không) do hook `enforceScopeShape`
   * của model kiểm — không lặp lại ở đây, một luật ở hai chỗ là một luật sẽ lệch.
   */
  async updateScope(actorId: string, grantId: string, input: UpdateGrantScopeInput) {
    const doc = await roleGrantRepository.findActiveById(grantId)
    if (!doc) throw new NotFoundError('Không tìm thấy quyền này')

    const axis: ScopeType[] = [SCOPE_TYPES.CATEGORY_PROVINCE, SCOPE_TYPES.CATEGORY_WARD]
    if (!axis.includes(doc.scopeType)) {
      throw new BadRequestError(
        'Chỉ sửa được phạm vi của quyền trục danh mục — đổi trục thì thu hồi rồi cấp lại',
      )
    }

    const actorGrants = await this.grantsOf(actorId)
    const target = { userId: doc.userId.toString(), grant: toPolicyGrant(doc) }
    if (!canGrant({ userId: actorId, grants: actorGrants }, target)) {
      throw new ForbiddenError('Không đủ thẩm quyền để sửa quyền này')
    }

    /*
     * Chụp phạm vi CŨ trước khi ghi đè — đây là câu trả lời cho lập luận "bảng này append-only"
     * ở `grant()`.
     *
     * Sửa tại chỗ thật sự xoá phạm vi cũ khỏi bản ghi, nên vết phải nằm ở chỗ khác. `AuditLog`
     * là collection CÓ TENANT nên trục danh mục không ghi vào đó được (món nợ đã biết — xem
     * `moderation.service`), và log hệ thống là đúng cái mà trục này vẫn dùng. Ghi cả trước
     * lẫn sau, không chỉ sau: chỉ có cặp đó mới dựng lại được "ai đổi gì".
     */
    const before = {
      scopeType: doc.scopeType,
      categoryId: doc.categoryId?.toString() ?? null,
      provinceCodes: [...doc.provinceCodes],
      wardCodes: [...doc.wardCodes],
    }

    doc.scopeType = input.scopeType
    doc.categoryId = new Types.ObjectId(input.categoryId)
    doc.provinceCodes = input.provinceCodes
    doc.wardCodes = input.wardCodes

    /*
     * Hình dạng TRƯỚC, đè nhau SAU — và thứ tự này có nghĩa, không phải tuỳ tiện.
     *
     * Một phạm vi méo (`category_ward` không phường nào) thì câu hỏi 'nó có đè ai không' chưa
     * có nghĩa để mà trả lời, và trả 409 cho một yêu cầu sai cú pháp là chỉ sai đường cho người
     * sửa. `validate()` chạy đúng `enforceScopeShape` mà `save()` sẽ chạy lại — trong bộ nhớ,
     * không chạm DB.
     */
    await doc.validate().catch(asScopeShapeError)

    // Loại CHÍNH nó ra: câu hỏi là 'sau khi sửa thì ô có đụng ai không', không phải 'bây giờ'
    // — không loại thì mọi lượt sửa đều tự đụng phạm vi cũ của mình.
    await assertNoManagerOverlap(toPolicyGrant(doc), doc._id)
    // `save()` chạy `enforceScopeShape`; lỗi hình dạng ra 400 chứ không 500 — xem hàm đó.
    await doc.save().catch(asScopeShapeError)

    logger.info('role-grant scope updated', {
      actorId,
      grantId,
      targetUserId: target.userId,
      before,
      after: {
        scopeType: doc.scopeType,
        categoryId: doc.categoryId?.toString() ?? null,
        provinceCodes: doc.provinceCodes,
        wardCodes: doc.wardCodes,
      },
    })
    return toRoleGrantDto(doc)
  },

  async revoke(actorId: string, grantId: string) {
    const doc = await roleGrantRepository.findActiveById(grantId)
    if (!doc) throw new NotFoundError('Grant not found')

    const actorGrants = await this.grantsOf(actorId)
    const target = { userId: doc.userId.toString(), grant: toPolicyGrant(doc) }
    if (!canRevoke({ userId: actorId, grants: actorGrants }, target)) {
      throw new ForbiddenError('Không đủ thẩm quyền để thu hồi quyền này')
    }

    // Không còn chốt §5.4 ở đây: `canRevoke` đã chặn MỌI grant role `master` từ trên, nên
    // nhánh "thu hồi master cuối cùng" không tới được. Master là data mặc định của hệ
    // thống (`scripts/migrate-master.ts`), đổi nó là việc ở tầng dữ liệu chứ không ở API.

    /*
     * Không thu hồi quyền quản trị CUỐI CÙNG của một org.
     *
     * Chốt ở đây chứ không ở tầng route: chỉ tới lúc này mới biết grant đang thu hồi thuộc trục
     * nào. Loại chính grant này ra khỏi phép đếm — câu hỏi là "sau khi thu hồi thì org còn ai",
     * không phải "bây giờ org có ai".
     */
    if (doc.scopeType === SCOPE_TYPES.ORG && doc.orgId) {
      const remaining = await usableOrgAdmins(doc.orgId, { grantId: doc._id })
      if (remaining === 0) {
        throw new ConflictError(
          'Đây là quản trị duy nhất của nhóm — trao quyền cho người khác trước khi thu hồi',
        )
      }
    }

    const revoked = await roleGrantRepository.revokeById(grantId, new Types.ObjectId(actorId))
    if (!revoked) throw new NotFoundError('Grant not found')

    logger.info('role-grant revoked', { actorId, grantId, targetUserId: target.userId })
    return toRoleGrantDto(revoked)
  },
}
