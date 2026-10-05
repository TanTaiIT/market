import { listingRepository } from './listing.repository'
import { PUSH_CATEGORY } from '../../common/constants'
import { runUnscoped } from '../../common/tenant/tenantContext'
import { logger } from '../../config/logger'
import { notificationService } from '../notification/notification.service'

/**
 * Hạ tin quá hạn xuống `expired` — thân job, Agenda gọi định kỳ (`config/agenda.ts`) và test
 * gọi thẳng.
 *
 * Job này TỒN TẠI VÌ đã bỏ TTL index trên `expiresAt`. Hai cách loại trừ nhau: TTL index xoá
 * thật document, còn ở đây tin chỉ đổi trạng thái. Đổi trạng thái mới là thứ sản phẩm cần —
 * tin hết hạn phải còn đó để người bán trả lời "vẫn còn" rồi gia hạn, và `expired` vốn đã nằm
 * trong `PUBLIC_LISTING_STATUSES` nên trang chi tiết vẫn xem được, chỉ rơi khỏi bảng tin
 * (`buildFilter` ép `active`).
 *
 * `runUnscoped` bắt buộc: quét chạy ngoài mọi request nên không có tenant scope, mà tin hết
 * hạn nằm ở CẢ HAI trục (org và danh mục) — ép scope ở đây là bỏ sót đúng một nửa.
 */
/** Hạn hiển thị của một tin: 30 ngày, tính từ lúc đăng HOẶC lúc gia hạn. */
export const LISTING_TTL_DAYS = 30

/**
 * Cửa sổ "sắp hết hạn" mà màn chặn-trước-khi-đăng đem ra hỏi.
 *
 * 7 ngày vì đây là lúc DUY NHẤT chắc chắn người bán đang ở trong app và đang cần thứ gì đó —
 * hỏi về tin còn hạn 3 tuần thì họ bấm bừa cho qua, hỏi về tin đã hết hạn thì đã muộn.
 */
export const RECONCILE_WINDOW_DAYS = 7

/** Số tin tối đa màn đối soát đem ra hỏi một lượt — xem `findNeedingReconcile`. */
export const RECONCILE_LIMIT = 20

const DAY_MS = 24 * 60 * 60 * 1000

/** Mốc hết hạn kể từ `from`. Một chỗ tính duy nhất cho đăng mới, gia hạn và migration. */
export const listingExpiresAt = (from: Date = new Date()) =>
  new Date(from.getTime() + LISTING_TTL_DAYS * DAY_MS)

/** Mốc "coi là sắp hết hạn" kể từ `from`. */
export const reconcileCutoff = (from: Date = new Date()) =>
  new Date(from.getTime() + RECONCILE_WINDOW_DAYS * DAY_MS)

export const listingExpiryService = {
  async sweep(): Promise<number> {
    const due = await runUnscoped('listing-expiry: liệt kê tin tới hạn', () =>
      listingRepository.findDue(new Date()),
    )
    if (due.length === 0) return 0

    const expired = await runUnscoped('listing-expiry: hạ tin quá hạn xuống expired', () =>
      listingRepository.expireByIds(due.map((l) => l._id)),
    )

    /*
     * Báo cho người bán (audit 1.20/4.9): tin rơi khỏi bảng mà không ai nói là họ tưởng app hỏng.
     * Một dòng mỗi tin — họ gia hạn từng tin, và màn đối soát đã gom sẵn. Tuần tự, không
     * `Promise.all`: job nền nhường I/O cho request thật.
     */
    for (const l of due) {
      await notificationService.notifyUser({
        organizationId: l.organizationId ?? null,
        userId: l.seller,
        push: { category: PUSH_CATEGORY.LISTING_STATUS, path: '/mylistings' },
        title: 'Tin của bạn đã hết hạn',
        body: `"${l.title}" đã rời bảng tin sau ${LISTING_TTL_DAYS} ngày — vào "Tin đã đăng" để gia hạn nếu vẫn còn.`,
      })
    }

    // Chỉ log khi CÓ việc: job này chạy mỗi giờ, log đều đặn "0 tin" chỉ làm loãng log thật.
    logger.info('listing-expiry: đã hạ tin quá hạn', { expired })
    return expired
  },
}
