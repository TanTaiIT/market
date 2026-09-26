import {
  MACHINE_REVIEW,
  MachineVerdict,
  medianOf,
  reviewByMachine,
  screenText,
} from './moderation.machine'
import { notifyPoster } from './moderation.service'
import { bannedPhraseService } from '../banned-phrase/banned-phrase.service'
import { listingRepository } from '../listing/listing.repository'
import { listingExpiresAt } from '../listing/listing.expiry.service'
import { QUOTA } from '../listing/listing.quota'
import { IListingDocument } from '../listing/listing.model'
import { categoryRepository } from '../category/category.repository'
import { trustRepository } from '../trust/trust.repository'
import { LISTING_STATUS, REJECTION_SEVERITY } from '../../common/constants'
import { logger } from '../../config/logger'

interface SweepResult {
  scanned: number
  approved: number
  rejected: number
  held: number
}

/**
 * Người duyệt MÁY — thân job, được Agenda gọi định kỳ (`config/agenda.ts`) và test gọi thẳng.
 *
 * Đứng sau hàng đợi chứ không thay fast-path: tin của người bậc 2 đã ACTIVE ngay trong request
 * đăng, không bao giờ tới đây. Máy chỉ dọn phần `PENDING` đang chờ người duyệt.
 *
 * KHÔNG đi qua `setListingStatus` của người duyệt tay — cố tình: đường đó ghi audit theo actor
 * thật và trừ bậc khi từ chối, mà máy thì không được trừ bậc (xem `moderation.machine.ts`). Nó có
 * đường ghi riêng với chốt race ở repository; phần cộng uy tín khi duyệt sạch gọi thẳng
 * `trustRepository.record` ở `apply`.
 */
export const machineReviewService = {
  async sweep(): Promise<SweepResult> {
    const batch = await listingRepository.findMachineQueue(MACHINE_REVIEW.BATCH_SIZE)
    const result: SweepResult = { scanned: batch.length, approved: 0, rejected: 0, held: 0 }

    // Một bản từ điển cho CẢ lượt quét: luật phải nhất quán trong một lượt — master gỡ một cụm
    // giữa chừng không được làm tin thứ 30 bị xử bằng luật khác tin thứ 3.
    const bannedPhrases = await bannedPhraseService.phrases()

    // Tuần tự chứ không Promise.all cả lô: job nền nhường I/O cho request thật, và một tin
    // hỏng (category bị xoá giữa chừng…) không được kéo sập cả lượt quét.
    for (const listing of batch) {
      try {
        const verdict = await judge(listing, bannedPhrases)
        // Chỉ đếm khi ghi THẬT — thua race với người duyệt tay thì lượt này không làm gì cả,
        // và log của sweep không được nhận công thay người khác.
        const applied = await apply(listing, verdict)
        if (applied) {
          result[
            verdict.verdict === 'approve'
              ? 'approved'
              : verdict.verdict === 'reject'
                ? 'rejected'
                : 'held'
          ] += 1
        }
      } catch (err) {
        logger.error('machine review: một tin lỗi, bỏ qua tin đó', {
          listingId: listing._id.toString(),
          err,
        })
      }
    }

    // Lượt quét rỗng không đáng một dòng log — job chạy vài phút một lần, đừng spam.
    if (result.scanned > 0) logger.info('machine review sweep', { ...result })
    return result
  },
}

async function judge(
  listing: IListingDocument,
  bannedPhrases: readonly string[],
): Promise<MachineVerdict> {
  const since = new Date(Date.now() - QUOTA.REJECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const dupSince = new Date(Date.now() - MACHINE_REVIEW.DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [category, prices, recentRejections, hasDuplicateTitle, standing] = await Promise.all([
    categoryRepository.findById(listing.category.toString()).exec(),
    listingRepository.sampleActivePrices(listing.category, MACHINE_REVIEW.PRICE_SAMPLE_SIZE),
    // Không bọc `runUnscoped` ở đây nữa: `countRecentRejections` tự bọc từ trong repository,
    // vì phép đếm đó sai với MỌI caller có scope hẹp, không riêng job này.
    listingRepository.countRecentRejections(listing.seller, since),
    listingRepository.hasRecentDuplicateTitle(listing.seller, listing.title, listing._id, dupSince),
    trustRepository.standingOf(listing.seller),
  ])

  return reviewByMachine({
    title: listing.title,
    description: listing.description,
    bannedPhrases,
    price: listing.price,
    categoryMedianPrice: medianOf(prices),
    hasRecentRejection: recentRejections > 0,
    hasDuplicateTitle,
    categoryRequiresReview: category?.requireManualReview ?? false,
    trustLevel: standing.level,
    onProbation: standing.onProbation,
    extraText: screenText({
      title: '',
      description: '',
      address: listing.location?.address,
      attributes: listing.attributes,
    }),
  })
}

/** `true` = phán quyết ghi được vào DB; `false` = thua race với người duyệt tay, máy im lặng rút. */
async function apply(listing: IListingDocument, verdict: MachineVerdict): Promise<boolean> {
  const at = new Date()

  if (verdict.verdict === 'approve') {
    const updated = await listingRepository.applyMachineVerdict(listing._id, {
      status: LISTING_STATUS.ACTIVE,
      // 30 ngày tính từ lúc LÊN BẢNG — cùng lý do với `setModerationStatus`.
      expiresAt: listingExpiresAt(),
      machineReview: { at, verdict: 'approved' },
    })
    if (updated) {
      await notifyPoster(updated, LISTING_STATUS.ACTIVE)
      // Duyệt sạch bằng máy CÓ tính là một bài sạch — xem đầu `moderation.machine.ts` cho cái giá
      // đã cân. Chỉ khi ghi THẬT: thua race với người duyệt tay thì lượt cộng là của người đó.
      await trustRepository.record(listing.seller, true)
      await listingRepository.appendModerationHistory(listing._id, {
        status: LISTING_STATUS.ACTIVE,
        byName: 'Hệ thống',
        at,
        machine: true,
      })
    }
    return updated !== null
  }

  if (verdict.verdict === 'reject') {
    const updated = await listingRepository.applyMachineVerdict(listing._id, {
      status: LISTING_STATUS.REJECTED,
      machineReview: { at, verdict: 'rejected' },
      // `moderation.at` là thứ `countRecentRejections` đếm — nhờ nó lượt từ chối máy tự động
      // khoá cửa tự-đăng và bóp quota của người này 7 ngày, không cần đụng tới bậc uy tín.
      moderation: {
        reason: verdict.reason,
        byName: 'Hệ thống',
        at,
        severity: REJECTION_SEVERITY.VIOLATION,
      },
    })
    if (updated) {
      await notifyPoster(updated, LISTING_STATUS.REJECTED, verdict.reason)
      await listingRepository.appendModerationHistory(listing._id, {
        status: LISTING_STATUS.REJECTED,
        reason: verdict.reason,
        byName: 'Hệ thống',
        at,
        severity: REJECTION_SEVERITY.VIOLATION,
        machine: true,
      })
    }
    return updated !== null
  }

  // Giữ lại cho người thật: tin ở nguyên PENDING, chỉ đóng dấu đã-chấm kèm lý do nghi ngờ —
  // dấu này cũng là cái chặn job chấm lại cùng một tin mỗi lượt quét.
  const held = await listingRepository.applyMachineVerdict(listing._id, {
    machineReview: { at, verdict: 'held', holds: verdict.holds },
  })
  if (held) {
    await listingRepository.appendModerationHistory(listing._id, {
      status: LISTING_STATUS.PENDING,
      reason: `Máy giữ lại: ${verdict.holds.join(', ')}`,
      byName: 'Hệ thống',
      at,
      machine: true,
    })
  }
  return held !== null
}
