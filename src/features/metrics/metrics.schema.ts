import { z } from 'zod'
import { registry } from '../../config/openapi'

/**
 * Hình dạng response của bàn master. Khai bằng Zod dù không validate input nào: SDK của app
 * sinh ra từ OpenAPI (`npm run api:sync`), nên schema này chính là type mà FE nhận được —
 * không khai thì FE nhận `unknown` và tự đoán lại từng field.
 */

const countBlock = z.object({
  total: z.number().int(),
  new7d: z.number().int(),
  new30d: z.number().int(),
})

export const systemMetricsSchema = registry.register(
  'SystemMetrics',
  z.object({
    /** Mốc chụp số liệu. Bàn này không cache, nhưng FE cần nó để nói "số liệu lúc HH:mm". */
    generatedAt: z.string().datetime(),

    organizations: countBlock.extend({
      active: z.number().int(),
      suspended: z.number().int(),
      /** Đã tạo, chưa trao quyền cho ai — một bước bình thường của luồng tạo org. */
      pendingAdmin: z.number().int(),
      /** Org ĐANG MỞ mà không còn manager nào. Khác `pendingAdmin`: đây là sự cố. */
      withoutManager: z.number().int(),
    }),

    users: countBlock.extend({
      active: z.number().int(),
      locked: z.number().int(),
    }),

    listings: countBlock.extend({
      /** Theo TRỤC, không theo tổ chức — `public` là trục danh mục, `orgInternal` là trục org. */
      publicAxis: z.number().int(),
      orgInternal: z.number().int(),
      active: z.number().int(),
      pending: z.number().int(),
      hidden: z.number().int(),
      rejected: z.number().int(),
      trend: z.array(
        z.object({
          day: z.string(),
          approved: z.number().int(),
          pending: z.number().int(),
        }),
      ),
      topCategories: z.array(
        z.object({
          categoryId: z.string(),
          name: z.string(),
          count: z.number().int(),
        }),
      ),
    }),

    /**
     * Khối phát hiện tồn đọng — lý do bàn này tồn tại sau khi master rời việc duyệt hằng ngày.
     */
    moderation: z.object({
      pendingPublicAxis: z.number().int(),
      pendingOrgAxis: z.number().int(),
      /** Tuổi tin chờ LÂU NHẤT, theo ngày. Cao mà tổng thấp = tin không ai nhận. */
      oldestPendingDays: z.number().int(),
      openReports: z.number().int(),
      /** Ô (danh mục × tỉnh) chưa có người phụ trách — tin ở đó rơi về master. */
      uncoveredCells: z.number().int(),
      totalCells: z.number().int(),
      /** Tổng tin đang chờ trong những ô bất thường của ma trận phủ sóng. */
      coverageBacklog: z.number().int(),
    }),
  }),
)

export type SystemMetrics = z.infer<typeof systemMetricsSchema>
