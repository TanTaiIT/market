import { ApiError } from '../../common/errors'
import { httpStatus } from '../../common/constants/httpStatus'
import {
  LISTING_STATUS,
  ListingStatus,
  LISTING_REACH,
  ListingReach,
  MODERATION_QUEUE,
  ModerationQueue,
} from '../../common/constants'

/**
 * Thuật toán định tuyến tin đăng — hàm THUẦN, không chạm DB.
 *
 * Mỗi tin thuộc ĐÚNG MỘT hàng đợi. Không có ca nào trả về hai giá trị, nên không tồn tại câu
 * hỏi "ai duyệt trước" hay "duyệt hai tầng chồng chéo".
 *
 * Hàng đợi là HÀM của bậc phủ sóng, không còn BẰNG nó: chỉ `marketplace` mới lên bàn danh mục,
 * hai bậc dưới do chính nhóm duyệt. `orgId` vẫn không phải khoá định tuyến — tin `marketplace`
 * mang badge "đăng bởi trường X" nhưng nhóm không duyệt nó (nhóm chỉ GỠ được — xem
 * `canTakedownListing`).
 *
 * | orgId | reach       | hàng đợi                              |
 * |-------|-------------|---------------------------------------|
 * | có    | members     | org (staff nhóm con → manager org)    |
 * | có    | group_open  | org — y như `members`                 |
 * | có    | marketplace | manager danh mục (category, province) |
 * | null  | marketplace | manager danh mục                      |
 * | null  | members     | VÔ NGHĨA → chặn ở validation          |
 * | null  | group_open  | VÔ NGHĨA → chặn ở validation          |
 *
 * `group_open` đi CHUNG hàng đợi với `members` chứ không sinh hàng đợi mới: nó chỉ đổi AI ĐỌC
 * ĐƯỢC, không đổi ai chịu trách nhiệm nội dung.
 */
export interface RoutingInput {
  reach: ListingReach
  /** Org đích. `null` khi người đăng không đứng trong org nào. */
  orgId: string | null
  /** Nhóm đích có công khai không — điều kiện của bậc `group_open`. */
  orgIsPublic: boolean
  isMember: boolean
  allowOutsiderPosts: boolean
  /** Có manager/staff nào phủ ô (danh mục × tỉnh) của tin này không. */
  hasCategoryModerator: boolean
  /** Nhóm con của người đăng, `null` khi org phẳng hoặc chưa được gán. */
  unitId: string | null
  /** Bậc uy tín của tài khoản — đủ cao thì tin tự đăng, chỉ hậu kiểm. Một bậc cho mọi trục. */
  autoApprove: boolean
}

export interface RoutingResult {
  queue: ModerationQueue
  status: ListingStatus
  organizationId: string | null
  unitId: string | null
}

/**
 * Định tuyến thất bại là LỖI CỦA YÊU CẦU (chọn sai tổ hợp org/reach), không phải lỗi hệ
 * thống — nên nó phải ra 400 kèm thông điệp đọc được, không rơi vào nhánh 500.
 */
export class RoutingError extends ApiError {
  constructor(message: string) {
    super(httpStatus.BAD_REQUEST, message)
  }
}

/**
 * Bậc mặc định khi client không khai — hàm THUẦN, cặp bài trùng của `routeListing`.
 *
 * Nhóm đã tự nhận là công khai thì nội dung bên trong cũng công khai theo: đó chính là điểm
 * gãy "nhóm công khai mà tin vẫn kín" mà thang này sinh ra để chữa. Người đăng vẫn hạ xuống
 * `members` được nếu muốn riêng.
 *
 * Keyed theo NHÓM chứ không theo tư cách thành viên: tin của người ngoài, một khi nhóm đã duyệt,
 * là nội dung nhóm đứng tên — và nhóm công khai thì nội dung đó công khai.
 */
export function defaultReachFor(org: { orgId: string | null; isPublic: boolean }): ListingReach {
  if (!org.orgId) return LISTING_REACH.MARKETPLACE
  return org.isPublic ? LISTING_REACH.GROUP_OPEN : LISTING_REACH.MEMBERS
}

export function routeListing(input: RoutingInput): RoutingResult {
  // Hai bậc dưới không tồn tại nếu không có nhóm để mà "trong nhóm".
  if (input.reach !== LISTING_REACH.MARKETPLACE && !input.orgId) {
    throw new RoutingError('Tin trong nhóm phải thuộc một tổ chức — chọn tổ chức hoặc đăng lên sàn')
  }

  /*
   * `group_open` đòi nhóm CÔNG KHAI. Chốt ở cả hai mép: đây là mép TẠO, còn mép kia là lúc
   * master gạt nhóm sang riêng tư (`organizationService.setVisibility` hạ mọi tin `group_open`
   * của nhóm về `members`). Thiếu một trong hai là có tin đọc công khai dưới một nhóm kín.
   */
  if (input.reach === LISTING_REACH.GROUP_OPEN && !input.orgIsPublic) {
    throw new RoutingError('Nhóm riêng tư chỉ đăng được tin cho thành viên')
  }

  if (input.reach === LISTING_REACH.MARKETPLACE) {
    /*
     * Người ngoài KHÔNG được gắn tên một nhóm mình không thuộc lên tin lên sàn.
     *
     * `organizationId` ở nhánh này chỉ là attribution — cái badge "đăng bởi nhóm X" hiện trên
     * bảng tin chung. Để người ngoài chọn nhóm tuỳ ý là cho họ mượn danh nghĩa của nhóm đó
     * trước cả trăm nghìn người, mà quản trị nhóm không có lấy một lượt duyệt nào (tin này đi
     * hàng đợi danh mục, không qua họ). Tin của người ngoài chỉ sống TRONG nhóm.
     */
    if (input.orgId && !input.isMember) {
      throw new RoutingError(
        'Tin lên sàn không mang được tên nhóm bạn chưa tham gia — bỏ chọn nhóm, hoặc đăng vào trong nhóm',
      )
    }

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
