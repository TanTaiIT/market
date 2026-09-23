import { Types } from 'mongoose'
import { OrgUnit, IOrgUnit, IOrgUnitDocument } from './org-unit.model'

export const orgUnitRepository = {
  create(data: Partial<IOrgUnit>) {
    return OrgUnit.create(data)
  },

  /** Danh sách nhóm để gán ngay trong màn duyệt request tham gia (§7.2a). */
  listByOrganization(): Promise<IOrgUnitDocument[]> {
    return OrgUnit.find().sort({ name: 1 }).exec()
  },

  /**
   * Tra nhóm con TRONG một org, và `organizationId` là BẮT BUỘC.
   *
   * Hai call-site (`join-request.approve`, `notification.broadcast`) đều coi "tra ra unit" là
   * bằng chứng nó thuộc org đang thao tác, rồi ghi `unitId` đó vào membership / thông báo. Bản
   * cũ chỉ lọc theo `_id` và giao toàn bộ phần org cho `tenantPlugin` — đúng, nhưng đó là một
   * chốt an toàn nằm ở tầng khác hẳn tầng đưa ra kết luận. Nêu điều kiện ngay tại chỗ tra thì
   * kết luận và bằng chứng nằm cùng một dòng, và không phụ thuộc scope của request còn hẹp hay
   * đã nới ra.
   */
  findInOrg(
    id: string | Types.ObjectId,
    organizationId: Types.ObjectId,
  ): Promise<IOrgUnitDocument | null> {
    return OrgUnit.findOne({ _id: id, organizationId }).exec()
  },

  updateById(id: string | Types.ObjectId, update: Partial<IOrgUnit>) {
    return OrgUnit.findOneAndUpdate({ _id: id }, update, {
      new: true,
      runValidators: true,
    }).exec()
  },

  softDelete(id: string | Types.ObjectId) {
    return OrgUnit.findOneAndUpdate({ _id: id }, { deletedAt: new Date() }, { new: true }).exec()
  },
}
