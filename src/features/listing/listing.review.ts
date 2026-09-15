import { LISTING_STATUS } from '../../common/constants'
import { MACHINE_REVIEW, MachineHold } from '../moderation/moderation.machine'
import type { AutoApprovalReason } from './listing.quota'
import type { IListingDocument } from './listing.model'

/**
 * Lời giải thích cho CHÍNH CHỦ về việc tin của họ đang ở đâu trong quy trình duyệt — hàm THUẦN,
 * đọc từ hai hồ sơ đã lưu trên tin (`autoApproval` lúc đăng, `moderation` lúc bị xử) và dịch
 * mã máy thành câu người đọc được.
 *
 * Nằm ở BE, không ở app, vì ba lý do cùng lúc: câu chữ phải khớp với lời người duyệt nói ở bàn
 * quản trị (cùng một nguồn); mã hold/reason là chi tiết nội bộ không nên thành hợp đồng API; và
 * khi thêm một luật quét mới thì chỉ sửa một nơi, không phải chờ app phát hành lại.
 *
 * Trả `undefined` cho tin không cần giải thích (đang hiện, đã bán, hết hạn): vắng field rẻ hơn
 * một object rỗng mà mọi màn phải kiểm.
 */
export interface ListingReview {
  state: 'pending' | 'rejected' | 'hidden'
  /** Một dòng ngắn cho huy hiệu — "Chờ duyệt" / "Bị từ chối" / "Đã ẩn". */
  title: string
  /** Vì sao — câu đầy đủ, nói bằng ngôn ngữ của người đăng, không phải của hệ thống. */
  message: string
  /** Việc họ có thể làm ngay, nếu có. */
  hint?: string
}

/** Định dạng tiền ngắn cho câu chữ: 50.000.000 → "50 triệu". */
function millions(vnd: number): string {
  return `${Math.round(vnd / 1_000_000)} triệu`
}

/**
 * Mỗi hold một câu, và câu nào cũng phải nói được VIỆC NGƯỠI ĐĂNG LÀM ĐƯỢC — hold là nghi ngờ
 * của máy, không phải phán quyết, nên đa số họ tự sửa được ngay không cần chờ ai.
 */
const HOLD_TEXT: Record<MachineHold, { message: string; hint?: string }> = {
  price_outlier: {
    message: 'Giá của tin lệch xa mức thường thấy trong danh mục này.',
    hint: 'Kiểm tra lại đơn vị (đồng) và số 0. Nếu giá đúng, người duyệt sẽ xem trong ít giờ.',
  },
  price_over_cap: {
    message: `Tin có giá trên ${millions(MACHINE_REVIEW.MAX_AUTO_PRICE)} luôn qua người duyệt trước khi lên bảng.`,
  },
  duplicate_title: {
    message: `Bạn vừa đăng một tin cùng tiêu đề trong ${MACHINE_REVIEW.DUPLICATE_WINDOW_DAYS} ngày gần đây.`,
    hint: 'Nếu đây là món khác, đặt tiêu đề phân biệt để không bị coi là đăng trùng.',
  },
  recent_rejection: {
    message: 'Bạn có tin bị từ chối gần đây, nên tin mới cần người duyệt xem trước.',
  },
  category_manual_review: {
    message: 'Danh mục này luôn qua người duyệt, không phụ thuộc uy tín.',
  },
  image_rejected: {
    message: 'Một ảnh của tin không qua được kiểm duyệt ảnh và đã bị gỡ.',
    hint: 'Phần chữ đang chờ người duyệt xem nốt. Bạn có thể thay ảnh khác ngay.',
  },
}

/** Lý do chờ KHÔNG đến từ máy quét — về uy tín, tư cách, hay cấu hình danh mục. */
const REASON_TEXT: Partial<Record<AutoApprovalReason, { message: string; hint?: string }>> = {
  trust_too_low: {
    message: 'Tài khoản cần thêm vài tin được duyệt trước khi được tự đăng.',
    hint: 'Mỗi tin qua duyệt sạch sẽ nâng bậc uy tín; đủ bậc thì tin lên bảng ngay lúc đăng.',
  },
  recent_rejection: HOLD_TEXT.recent_rejection,
  category_manual_review: HOLD_TEXT.category_manual_review,
  outsider_post: {
    message: 'Bạn chưa là thành viên của nhóm này, nên quản trị nhóm sẽ xem tin trước.',
    hint: 'Xin vào nhóm để những tin sau lên bảng theo bậc uy tín của bạn.',
  },
}

const FALLBACK_PENDING: ListingReview = {
  state: 'pending',
  title: 'Chờ duyệt',
  message: 'Tin đang chờ người duyệt xem.',
}

export function reviewOf(
  listing: Pick<IListingDocument, 'status' | 'autoApproval' | 'moderation' | 'machineReview'>,
): ListingReview | undefined {
  switch (listing.status) {
    case LISTING_STATUS.REJECTED: {
      const m = listing.moderation
      return {
        state: 'rejected',
        title: 'Bị từ chối',
        message: m?.reason?.trim() || 'Người duyệt đã từ chối tin này.',
        // `violation` là vi phạm quy định sàn, khác "tin sai sót" — người đăng cần biết vì
        // lặp lại là bị khoá quyền đăng (REJECTION_BLOCK), không chỉ mất một tin.
        hint:
          m?.severity === 'violation'
            ? 'Đây là vi phạm quy định sàn. Lặp lại nhiều lần sẽ tạm khoá quyền đăng tin.'
            : 'Bạn có thể sửa nội dung rồi đăng lại.',
      }
    }

    case LISTING_STATUS.HIDDEN:
      return {
        state: 'hidden',
        title: 'Đã ẩn',
        message: listing.moderation?.reason?.trim() || 'Quản trị đã ẩn tin khỏi bảng.',
      }

    // Hàng đợi người-ngoài: trạng thái riêng nên không cần đọc `autoApproval`.
    case LISTING_STATUS.PENDING_UNVERIFIED:
      return { state: 'pending', title: 'Chờ duyệt', ...REASON_TEXT.outsider_post! }

    case LISTING_STATUS.PENDING: {
      const auto = listing.autoApproval
      // Tin seed hoặc tin trước ngày có hồ sơ: không có gì để dịch, nói câu chung.
      if (!auto) return FALLBACK_PENDING

      if (auto.reason === 'content_flagged') {
        /*
         * Dịch HOLD ĐẦU, kèm câu hint của nó. Máy có thể bắn nhiều hold cùng lúc, nhưng nhồi cả
         * ba câu vào một huy hiệu là không ai đọc — và hold đứng đầu mảng là hold nặng nhất
         * theo thứ tự `reviewByMachine` xếp.
         *
         * Nguồn phụ là `machineReview.holds`: tin lưu TRƯỚC ngày `autoApproval.holds` tồn tại
         * không có mảng ở đường tự-đăng, nhưng job quét đêm chấm lại đúng bộ luật đó và ghi kết
         * quả vào `machineReview` — mọi tin đang kẹt trong DB thật đều có nó. Không có cả hai
         * thì rơi về câu chung.
         */
        const first = auto.holds?.[0] ?? listing.machineReview?.holds?.[0]
        const text = first ? HOLD_TEXT[first] : undefined
        return text
          ? { state: 'pending', title: 'Chờ duyệt', ...text }
          : { ...FALLBACK_PENDING, message: 'Nội dung tin cần người duyệt xem trước khi lên bảng.' }
      }

      const text = REASON_TEXT[auto.reason]
      return text ? { state: 'pending', title: 'Chờ duyệt', ...text } : FALLBACK_PENDING
    }

    default:
      return undefined
  }
}
