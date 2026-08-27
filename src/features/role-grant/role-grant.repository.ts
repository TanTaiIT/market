import { Types } from 'mongoose'
import { RoleGrant, IRoleGrant, IRoleGrantDocument } from './role-grant.model'
import { SCOPE_TYPES, SYSTEM_ROLES } from '../../common/constants'

const ACTIVE = { revokedAt: null }

export const roleGrantRepository = {
  create(data: Partial<IRoleGrant>) {
    return RoleGrant.create(data)
  },

  /** Nạp toàn bộ quyền còn hiệu lực của một người — đầu vào của tầng policy. */
  listActiveByUser(userId: string | Types.ObjectId): Promise<IRoleGrantDocument[]> {
    return RoleGrant.find({ userId, ...ACTIVE }).exec()
  },

  findActiveById(id: string | Types.ObjectId): Promise<IRoleGrantDocument | null> {
    return RoleGrant.findOne({ _id: id, ...ACTIVE }).exec()
  },

  /**
   * Chủ nhân của mọi grant master còn hiệu lực.
   *
   * Trả về NGƯỜI chứ không phải số lượng grant: xoá mềm tài khoản không chạm tới grant, nên
   * `countDocuments` trên grant sẽ báo "vẫn còn master" trong khi không ai đăng nhập được nữa
   * — đúng cái tình trạng §5.4 sinh ra để chặn. Ai còn dùng được thì `userRepository` mới trả
   * lời được, nên phép đếm thật nằm ở service.
   */
  listActiveMasterUserIds(): Promise<Types.ObjectId[]> {
    return RoleGrant.distinct('userId', { role: SYSTEM_ROLES.MASTER, ...ACTIVE }).exec()
  },

  /**
   * Người này có phải master không.
   *
   * Kèm `scopeType` để khớp ĐÚNG định nghĩa của `policy.isMaster` — cái quyết định quyền
   * thật. Lỏng hơn nó thì một grant `master` phạm vi org (không có quyền gì) vẫn được che
   * như master; chặt hơn thì có master thật lọt ra ngoài, và đó mới là hướng chết người.
   *
   * Không cache: index `{ userId: 1, revokedAt: 1 }` phủ đúng câu này, và mọi call-site
   * đều là đường ghi (ghi audit, tạo báo cáo) hoặc đọc hồ sơ lẻ — không chỗ nào trong
   * vòng lặp. Cache một giá trị gần như bất biến nghe hấp dẫn, nhưng nó sẽ nói dối đúng
   * lúc `migrate:master` vừa chạy mà tiến trình chưa restart.
   */
  async isMasterUser(userId: string | Types.ObjectId): Promise<boolean> {
    const grant = await RoleGrant.exists({
      userId,
      role: SYSTEM_ROLES.MASTER,
      scopeType: SCOPE_TYPES.SYSTEM,
      ...ACTIVE,
    })
    return grant !== null
  },

  /**
   * Thu hồi sạch quyền của một người, dùng khi tài khoản bị xoá.
   *
   * `revokedBy: null` = hệ thống tự gỡ, phân biệt với một master bấm thu hồi. Không đi qua
   * `revokeById` từng cái: đây là hệ quả của một thao tác duy nhất, gỡ nửa chừng rồi lỗi sẽ để
   * lại một tài khoản đã xoá mà vẫn còn quyền.
   */
  revokeAllForUser(userId: string | Types.ObjectId) {
    return RoleGrant.updateMany(
      { userId, ...ACTIVE },
      { revokedAt: new Date(), revokedBy: null },
    ).exec()
  },

  revokeById(id: string | Types.ObjectId, revokedBy: Types.ObjectId | null) {
    return RoleGrant.findOneAndUpdate(
      { _id: id, ...ACTIVE },
      { revokedAt: new Date(), revokedBy },
      { new: true },
    ).exec()
  },

  /** Toàn bộ grant của trục danh mục, một lượt — dashboard phủ sóng tự nhóm lấy. */
  /** Grant còn hiệu lực của CẢ HAI tầng trục danh mục — ma trận phủ sóng của master. */
  listCategoryAxisGrants() {
    return RoleGrant.find({
      scopeType: { $in: [SCOPE_TYPES.CATEGORY_PROVINCE, SCOPE_TYPES.CATEGORY_WARD] },
      ...ACTIVE,
    }).exec()
  },

  /**
   * Ai đang phụ trách một ô (danh mục × tỉnh × phường) — hỏi CẢ HAI tầng một lượt.
   *
   * Tầng tỉnh: `provinceCodes` rỗng = toàn quốc nên phải nằm trong `$or`, không lọc `$in` suông
   * — bỏ sót nó là bỏ sót đúng nhóm bao phủ rộng nhất. Tầng phường: khớp đúng cặp (tỉnh, phường).
   * Tin cũ chưa có phường (`ward = null`) chỉ còn tầng tỉnh đỡ, đúng thứ tự phân cấp.
   */
  listByCategoryCell(categoryId: string | Types.ObjectId, province: string, ward: string | null) {
    const provinceTier = {
      scopeType: SCOPE_TYPES.CATEGORY_PROVINCE,
      $or: [{ provinceCodes: { $size: 0 } }, { provinceCodes: province }],
    }
    const wardTier = {
      scopeType: SCOPE_TYPES.CATEGORY_WARD,
      provinceCodes: province,
      wardCodes: ward,
    }
    return RoleGrant.find({
      categoryId,
      ...ACTIVE,
      $or: ward ? [provinceTier, wardTier] : [provinceTier],
    }).exec()
  },
}
