import { metricsRepository } from './metrics.repository'
import { listingService } from '../listing/listing.service'
import { categoryService } from '../category/category.service'
import { moderationService } from '../moderation/moderation.service'
import { runUnscoped } from '../../common/tenant/tenantContext'
import { LISTING_STATUS } from '../../common/constants'

/**
 * Bàn tổng quan của MASTER — số liệu toàn nền tảng, không thuộc tổ chức nào.
 *
 * Tách hẳn khỏi `moderationService.overview` / `publicOverview` thay vì nới scope của chúng, và
 * đó là quyết định về CÁCH LY, không phải về gọn gàng: `publicOverview` gác
 * `requireCategoryModerator`, nên mọi manager danh mục vào được. Nới nó ra để lấy số toàn hệ
 * thống là phát số liệu xuyên org cho vài chục người phụ trách danh mục. Route mới +
 * `requireMaster` là cách duy nhất giữ được cả hai.
 *
 * Ba khối đầu (tổ chức / người dùng / tin đăng) là thứ được hỏi. Khối thứ tư (`moderation`) thì
 * KHÔNG được hỏi nhưng là lý do bàn này tồn tại: master vừa rời việc duyệt hằng ngày, nên đây
 * là đường duy nhất còn lại để họ thấy tồn đọng — ô (danh mục × tỉnh) chưa có người phụ trách,
 * org không còn manager, tin chờ lâu nhất. Bỏ khối đó đi thì việc dọn menu biến tồn đọng thành
 * vô hình, chứ không phải biến nó thành việc của người khác.
 */

/** Hai cửa sổ "mới trong N ngày", theo đúng thứ tự này ở mọi khối. */
const NEW_WINDOWS = [7, 30] as const
/** Số ngày của biểu đồ nhịp đăng tin — khớp `TREND_DAYS` của bàn org để hai bàn đọc cùng nhịp. */
const TREND_DAYS = 14
/** Bao nhiêu danh mục sôi động nhất được liệt kê. Quá 8 là một cái bảng, không phải một chỉ số. */
const TOP_CATEGORIES = 8

export const metricsService = {
  async system() {
    const [orgs, orgsWithoutManager, users, listings, health, stats, categories, coverage] =
      await Promise.all([
        metricsRepository.organizations([...NEW_WINDOWS]),
        metricsRepository.orgsWithoutManager(),
        metricsRepository.users([...NEW_WINDOWS]),
        metricsRepository.listings([...NEW_WINDOWS]),
        metricsRepository.moderationHealth(),
        // `statsForModeration` chạy `Listing.aggregate` qua plugin — cùng lý do với
        // `metricsRepository.listings`, phải unscoped hoặc số trả về chỉ là phần công khai.
        runUnscoped('metrics: nhịp đăng tin toàn hệ thống', () =>
          listingService.moderationStats(TREND_DAYS),
        ),
        categoryService.list({ includeInactive: true }),
        // `coverage()` đọc `pendingByCategoryProvince()` — cũng là `Listing`. Không bọc thì cột
        // tồn đọng của mọi ô về 0 và ma trận báo "không có gì phải lo".
        runUnscoped('metrics: ma trận phủ sóng cho bàn master', () => moderationService.coverage()),
      ])

    const countOf = (status: string) => stats.byStatus.find((row) => row._id === status)?.count ?? 0
    const nameOf = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Khác'

    return {
      generatedAt: new Date().toISOString(),

      organizations: {
        total: orgs.total,
        active: orgs.active,
        suspended: orgs.suspended,
        pendingAdmin: orgs.pendingAdmin,
        new7d: orgs.fresh[0],
        new30d: orgs.fresh[1],
        withoutManager: orgsWithoutManager,
      },

      users: {
        total: users.total,
        active: users.active,
        locked: users.locked,
        new7d: users.fresh[0],
        new30d: users.fresh[1],
      },

      listings: {
        total: listings.total,
        publicAxis: listings.publicAxis,
        orgInternal: listings.orgInternal,
        new7d: listings.fresh[0],
        new30d: listings.fresh[1],
        active: countOf(LISTING_STATUS.ACTIVE),
        pending: countOf(LISTING_STATUS.PENDING),
        hidden: countOf(LISTING_STATUS.HIDDEN),
        rejected: countOf(LISTING_STATUS.REJECTED),
        trend: stats.byDay.map((row) => ({
          day: row._id,
          approved: row.approved,
          pending: row.pending,
        })),
        topCategories: [...stats.byCategory]
          .sort((a, b) => b.count - a.count)
          .slice(0, TOP_CATEGORIES)
          .map((row) => ({
            categoryId: row._id.toString(),
            name: nameOf(row._id.toString()),
            count: row.count,
          })),
      },

      moderation: {
        pendingPublicAxis: health.pendingPublicAxis,
        pendingOrgAxis: health.pendingOrgAxis,
        oldestPendingDays: health.oldestPendingDays,
        openReports: health.openReports,
        /*
         * Chỉ ba con số tóm tắt, KHÔNG mang cả mảng `cells` sang.
         *
         * `coverage()` trả về mọi ô bất thường — với 34 tỉnh × N danh mục thì đó là một payload
         * dài, mà bàn này chỉ cần trả lời "có phải đi dọn không". Cần chi tiết thì đã có sẵn màn
         * Phủ sóng (`/admin/coverage`) đọc đúng endpoint đó; nhân đôi dữ liệu sang đây là hẹn
         * một ngày hai chỗ nói hai số khác nhau.
         */
        uncoveredCells: coverage.uncovered,
        totalCells: coverage.totalCells,
        coverageBacklog: coverage.backlog,
      },
    }
  },
}
