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
