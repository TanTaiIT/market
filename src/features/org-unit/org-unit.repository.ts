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

  findById(id: string | Types.ObjectId): Promise<IOrgUnitDocument | null> {
    return OrgUnit.findOne({ _id: id }).exec()
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
