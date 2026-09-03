import { REJECTED_IMAGE_REASON, rejectedImagePattern } from './moderation.webhook'
import { MachineHold } from './moderation.machine'
import { notifyPoster } from './moderation.service'
import { listingRepository } from '../listing/listing.repository'
import { userRepository } from '../user/user.repository'
import { organizationRepository } from '../organization/organization.repository'
import { chatRepository } from '../chat/chat.repository'
import { LISTING_STATUS } from '../../common/constants'
import { logger } from '../../config/logger'

interface RejectionResult {
  /** Tin PENDING bị rút ảnh và ghim lại chờ người thật. */
  held: number
  /** Tin ACTIVE bị rút ảnh và ẩn khỏi bảng. */
  hidden: number
  /** Tin ở trạng thái khác (hoặc thua race) — chỉ rút ảnh. */
  scrubbed: number
  posterAvatars: number
  userAvatars: number
  orgImages: number
  chatAvatars: number
}

/**
 * Thân webhook kiểm duyệt ảnh — Cloudinary báo một ảnh `rejected`, service này gỡ nó khỏi MỌI
 * chỗ DB đang trỏ tới (bốn nguồn, cùng danh sách với job dọn ảnh `upload.cleanup.service.ts`).
 *
 * Với TIN ĐĂNG, gỡ ảnh chưa đủ — tin phải đổi chỗ đứng, và mức phạt bám theo nguyên tắc của
 * người duyệt máy (`moderation.machine.ts`): máy chỉ chắc chắn về ẢNH, không chắc về cả tin.
 * - `PENDING`  → rút ảnh + ghim `held: image_rejected`: phần chữ để người thật xem nốt.
 * - `ACTIVE`   → rút ảnh + ẨN kèm lý do, báo người đăng — người duyệt xem lại rồi mở, chứ máy
 *   không REJECT thẳng: từ chối máy kéo theo án phạt quota 7 ngày (`countRecentRejections`),
 *   mà ảnh nhạy cảm có tỉ lệ oan sai thật (ảnh sản phẩm áo tắm, tượng...).
 * - Trạng thái khác (hidden/rejected/draft...) → chỉ rút ảnh, không đổi gì thêm.
 *
 * Cả cụm không đụng bậc uy tín — đúng luật "máy không cộng/trừ uy tín" của machine review.
 */
export const imageModerationService = {
  async applyRejection(publicId: string, cloudName: string): Promise<RejectionResult> {
    const pattern = rejectedImagePattern(publicId, cloudName)
    const at = new Date()
    const result: RejectionResult = {
      held: 0,
      hidden: 0,
      scrubbed: 0,
      posterAvatars: 0,
      userAvatars: 0,
      orgImages: 0,
      chatAvatars: 0,
    }

    // Tuần tự như sweep của machine review: webhook không vội (Cloudinary chờ được vài giây),
    // và một tin lỗi không được kéo sập cả lượt gỡ.
    const affected = await listingRepository.findByImageRef(pattern)
    for (const listing of affected) {
      if (listing.status === LISTING_STATUS.PENDING) {
        // Giữ các hold máy đã chấm trước đó — ảnh bẩn không được xoá vết nghi ngờ giá/trùng tin.
        const holds: MachineHold[] = [
          ...new Set<MachineHold>([...(listing.machineReview?.holds ?? []), 'image_rejected']),
        ]
        const updated = await listingRepository.scrubImageRef(listing._id, pattern, {
          ifStatus: LISTING_STATUS.PENDING,
          set: { machineReview: { at, verdict: 'held', holds } },
        })
        if (updated) {
          result.held += 1
          continue
        }
      } else if (listing.status === LISTING_STATUS.ACTIVE) {
        const updated = await listingRepository.scrubImageRef(listing._id, pattern, {
          ifStatus: LISTING_STATUS.ACTIVE,
          set: {
            status: LISTING_STATUS.HIDDEN,
            moderation: { reason: REJECTED_IMAGE_REASON, byName: 'Hệ thống', at },
          },
        })
        if (updated) {
          result.hidden += 1
          await notifyPoster(updated, LISTING_STATUS.HIDDEN, REJECTED_IMAGE_REASON)
          continue
        }
      }
      // Trạng thái không cần đổi, hoặc thua race với người duyệt tay: vẫn phải rút ảnh.
      await listingRepository.scrubImageRef(listing._id, pattern)
      result.scrubbed += 1
    }

    const [posterAvatars, userAvatars, orgImages, chatAvatars] = await Promise.all([
      listingRepository.clearPosterAvatarRef(pattern),
      userRepository.clearAvatarRef(pattern),
      organizationRepository.clearImageRefs(pattern),
      chatRepository.clearParticipantAvatarRef(pattern),
    ])
    Object.assign(result, { posterAvatars, userAvatars, orgImages, chatAvatars })

    // warn chứ không info: mỗi dòng là một ảnh người dùng thật bị máy chặn — đáng ngoái nhìn.
    logger.warn('image moderation: đã gỡ ảnh bị từ chối', { publicId, ...result })
    return result
  },
}
