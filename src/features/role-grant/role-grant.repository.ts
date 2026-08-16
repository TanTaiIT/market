import { Types } from 'mongoose'
import { RoleGrant, IRoleGrant, IRoleGrantDocument } from './role-grant.model'
import { SYSTEM_ROLES } from '../../common/constants'

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

  /** §5.4: gọi TRƯỚC khi thu hồi một master, không phải sau. */
  countActiveMasters(): Promise<number> {
    return RoleGrant.countDocuments({ role: SYSTEM_ROLES.MASTER, ...ACTIVE }).exec()
  },

  revokeById(id: string | Types.ObjectId, revokedBy: Types.ObjectId | null) {
    return RoleGrant.findOneAndUpdate(
      { _id: id, ...ACTIVE },
      { revokedAt: new Date(), revokedBy },
      { new: true },
    ).exec()
  },

  /** Toàn bộ grant của trục danh mục, một lượt — dashboard phủ sóng tự nhóm lấy. */
  listCategoryProvinceGrants() {
    return RoleGrant.find({ scopeType: 'category_province', ...ACTIVE }).exec()
  },

  /**
   * Ai đang phụ trách một ô (danh mục × tỉnh). `provinceCodes` rỗng = toàn quốc nên phải nằm
   * trong điều kiện `$or`, không lọc bằng `$in` suông — bỏ sót nó là bỏ sót đúng nhóm manager
   * bao phủ rộng nhất.
   */
  listByCategoryProvince(categoryId: string | Types.ObjectId, provinceCode: string) {
    return RoleGrant.find({
      scopeType: 'category_province',
      categoryId,
      ...ACTIVE,
      $or: [{ provinceCodes: { $size: 0 } }, { provinceCodes: provinceCode }],
    }).exec()
  },
}
