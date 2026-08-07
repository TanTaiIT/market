import { PlatformAdmin, IPlatformAdmin, IPlatformAdminDocument } from './platform-admin.model'

export const platformAdminRepository = {
  create(data: Partial<IPlatformAdmin>) {
    return PlatformAdmin.create(data)
  },

  findByEmail(email: string): Promise<IPlatformAdminDocument | null> {
    return PlatformAdmin.findOne({ email: email.toLowerCase(), deletedAt: null })
      .select('+password')
      .exec()
  },
}
