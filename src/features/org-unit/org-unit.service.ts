import { Types } from 'mongoose'
import { orgUnitRepository } from './org-unit.repository'
import { IOrgUnitDocument } from './org-unit.model'
import { CreateOrgUnitInput, UpdateOrgUnitInput } from './org-unit.schema'
import { organizationRepository } from '../organization/organization.repository'
import { requireOwnOrgId } from '../../common/tenant/tenantContext'
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors'

function toDto(doc: IOrgUnitDocument) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    moderatorId: doc.moderatorId?.toString() ?? null,
    parentUnitId: doc.parentUnitId?.toString() ?? null,
  }
}

/**
 * `organizationId` không xuất hiện trong bất kỳ chữ ký nào ở đây: `OrgUnit` gắn `tenantPlugin`
 * nên scope đến từ context. Tự viết filter org ở tầng này là mở đường cho một query quên nó.
 */
export const orgUnitService = {
  async list() {
    const units = await orgUnitRepository.listByOrganization()
    return units.map(toDto)
  },

  async create(input: CreateOrgUnitInput) {
    // Đọc `capabilities`, KHÔNG đọc `orgType`. Đây là chỗ duy nhất biến cột đó thành ràng buộc
    // thật: org khai mình phẳng thì không đẻ được nhóm con, và thêm loại org mới sau này chỉ
    // là thêm một preset — không phải thêm một nhánh `if` ở đây.
    const org = await organizationRepository.findById(requireOwnOrgId('orgUnit.create'))
    if (!org?.capabilities?.hasUnits) {
      throw new BadRequestError('Tổ chức này không dùng nhóm con (capabilities.hasUnits = false)')
    }

    try {
      const doc = await orgUnitRepository.create({
        name: input.name,
        moderatorId: input.moderatorId ? new Types.ObjectId(input.moderatorId) : null,
        parentUnitId: input.parentUnitId ? new Types.ObjectId(input.parentUnitId) : null,
      })
      return toDto(doc)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new ConflictError(`Nhóm "${input.name}" đã tồn tại trong tổ chức`)
      }
      throw err
    }
  },

  async update(id: string, input: UpdateOrgUnitInput) {
    const update: Record<string, unknown> = {}
    if (input.name !== undefined) update.name = input.name
    if (input.moderatorId !== undefined) {
      update.moderatorId = input.moderatorId ? new Types.ObjectId(input.moderatorId) : null
    }
    if (input.parentUnitId !== undefined) {
      update.parentUnitId = input.parentUnitId ? new Types.ObjectId(input.parentUnitId) : null
    }

    const doc = await orgUnitRepository.updateById(id, update)
    if (!doc) throw new NotFoundError('Không tìm thấy nhóm con')
    return toDto(doc)
  },

  async remove(id: string) {
    const doc = await orgUnitRepository.softDelete(id)
    if (!doc) throw new NotFoundError('Không tìm thấy nhóm con')
    return toDto(doc)
  },
}
