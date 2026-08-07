import { OrgRole, PlatformAdminRole } from '../constants'

// Augment Express Request để gắn actor sau khi authenticate.
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string
        organizationId: string
        role: OrgRole
      }
      /** Chỉ set trên nhánh /platform-admin — cố tình tách khỏi `user` để không lẫn quyền. */
      platformAdmin?: {
        id: string
        role: PlatformAdminRole
      }
    }
  }
}
