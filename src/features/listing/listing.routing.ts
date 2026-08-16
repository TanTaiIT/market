import { ApiError } from '../../common/errors'
import { httpStatus } from '../../common/constants/httpStatus'
import {
  LISTING_STATUS,
  ListingStatus,
  MODERATION_QUEUE,
  ModerationQueue,
  POST_VISIBILITY,
  PostVisibility,
} from '../../common/constants'

/**
 * Thuật toán định tuyến tin đăng — hàm THUẦN, không chạm DB.
 *
 * Mỗi tin thuộc ĐÚNG MỘT hàng đợi. Không có ca nào trả về hai giá trị, nên không tồn tại câu
 * hỏi "ai duyệt trước" hay "duyệt hai tầng chồng chéo".
 *
 * Khoá định tuyến là `visibility`, KHÔNG phải `orgId` (quyết định Q3 — "giới hạn hiển thị"):
 * tin muốn ra trang công khai phải qua manager danh mục kể cả khi nó thuộc một org. `orgId`
 * từ đó chỉ còn là attribution — cái badge "đăng bởi trường X".
 *
 * | orgId | visibility     | hàng đợi                                  |
 * |-------|----------------|-------------------------------------------|
 * | có    | org_internal   | org (staff nhóm con → manager org)        |
 * | có    | public         | manager danh mục (category, province)     |
 * | null  | public         | manager danh mục                          |
 * | null  | org_internal   | VÔ NGHĨA → chặn ở validation              |
 */
export interface RoutingInput {
  visibility: PostVisibility
  /** Org đích. `null` khi người đăng không đứng trong org nào. */
  orgId: string | null
  isMember: boolean
  allowOutsiderPosts: boolean
  /** Có manager/staff nào phủ ô (danh mục × tỉnh) của tin này không. */
  hasCategoryModerator: boolean
  /** Nhóm con của người đăng, `null` khi org phẳng hoặc chưa được gán. */
  unitId: string | null
  /** Bậc uy tín ở trục tương ứng — đủ cao thì tin tự đăng, chỉ hậu kiểm (§8.3). */
  autoApprove: boolean
}

export interface RoutingResult {
  queue: ModerationQueue
  status: ListingStatus
  organizationId: string | null
  unitId: string | null
}

/**
 * Định tuyến thất bại là LỖI CỦA YÊU CẦU (chọn sai tổ hợp org/visibility), không phải lỗi hệ
 * thống — nên nó phải ra 400 kèm thông điệp đọc được, không rơi vào nhánh 500.
 */
export class RoutingError extends ApiError {
  constructor(message: string) {
    super(httpStatus.BAD_REQUEST, message)
  }
}

export function routeListing(input: RoutingInput): RoutingResult {
  if (input.visibility === POST_VISIBILITY.PUBLIC) {
    return {
      // Ô chưa có ai phụ trách thì tin rơi về master — dòng chảy đó phải NHÌN THẤY được, nên
      // nó là một hàng đợi thật chứ không phải trạng thái lửng lơ (§11.1).
      queue: input.hasCategoryModerator ? MODERATION_QUEUE.CATEGORY : MODERATION_QUEUE.MASTER,
      status: input.autoApprove ? LISTING_STATUS.ACTIVE : LISTING_STATUS.PENDING,
      // Giữ org để hiển thị nguồn gốc; nó KHÔNG cho org quyền duyệt tin này.
      organizationId: input.orgId,
      unitId: null,
    }
  }

  if (!input.orgId) {
    throw new RoutingError('Tin nội bộ phải thuộc một tổ chức — chọn tổ chức hoặc đăng công khai')
  }

  if (input.isMember) {
    return {
      queue: MODERATION_QUEUE.ORG_MEMBER,
      status: input.autoApprove ? LISTING_STATUS.ACTIVE : LISTING_STATUS.PENDING,
      organizationId: input.orgId,
      unitId: input.unitId,
    }
  }

  if (!input.allowOutsiderPosts) {
    throw new RoutingError('Tổ chức này không nhận tin từ người ngoài')
  }

  return {
    queue: MODERATION_QUEUE.ORG_OUTSIDER,
    // Người ngoài KHÔNG bao giờ được tự đăng, bất kể uy tín: uy tín kiếm được ở chỗ khác
    // không mua được quyền đăng thẳng vào một tổ chức mình không thuộc về.
    status: LISTING_STATUS.PENDING_UNVERIFIED,
    organizationId: input.orgId,
    unitId: null,
  }
}
