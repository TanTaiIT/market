import { MembershipRole } from '../constants'
import { Grant } from '../authz/policy'

// Augment Express Request để gắn actor sau khi authenticate.
declare global {
  namespace Express {
    interface Request {
      /** Danh tính. KHÔNG mang org/role: cả hai đều đến từ request hiện tại, không từ token. */
      user?: {
        id: string
      }
      /**
       * Quan hệ của actor với org hoạt động. `undefined` khi request không có org scope, hoặc
       * khi actor chạm org này bằng quyền hệ thống (master/manager) chứ không phải bằng
       * tư cách thành viên.
       */
      membership?: {
        id: string
        role: MembershipRole
        unitId: string | null
        trustLevel: number
      }
      /** Quyền hạn hệ thống, nạp một lần mỗi request để không truy vấn lại ở từng tầng. */
      grants?: Grant[]
    }
  }
}
