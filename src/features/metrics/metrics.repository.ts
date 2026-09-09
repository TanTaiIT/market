import { Types } from 'mongoose'
import { Listing } from '../listing/listing.model'
import { Organization } from '../organization/organization.model'
import { User } from '../user/user.model'
import { reportRepository } from '../report/report.repository'
import { roleGrantRepository } from '../role-grant/role-grant.repository'
import { runUnscoped } from '../../common/tenant/tenantContext'
import { LISTING_STATUS, POST_VISIBILITY, TENANT_STATUS } from '../../common/constants'

/**
 * Số đếm TOÀN HỆ THỐNG cho bàn của master. Mọi truy vấn ở đây cố ý bỏ qua trục tenant.
 *
 * Ranh giới `runUnscoped` không phải chọn cho chắc — nó đúng theo từng model, và đo được:
 * chỉ `Listing` (`dualAxis`) và `Report` gắn `tenantPlugin`; `Organization`, `User`,
 * `Membership`, `Category` thì không (chính chúng là thứ định nghĩa tenant). Vì vậy chỉ hai
 * model đầu cần khai, và khai thừa ở bốn model kia sẽ làm `grep -rn "runUnscoped"` — cái danh
 * sách dùng để soát mọi lối đi xuyên tenant — loãng đi.
 *
 * Đây là chỗ dễ đọc ra số SAI nhất trong cả module, nên nói thẳng cái bẫy: `requireMaster`
 * KHÔNG mở tenant scope. Master không chọn tổ chức thì `resolveTenant` đã đặt
 * `publicOnlyScope()`, nên một câu `Listing.countDocuments({})` viết hồn nhiên ở đây chỉ đếm
 * tin CÔNG KHAI ĐÃ DUYỆT — dashboard hiện một con số nhỏ hơn thực tế, không exception, không
 * log, không ai biết. Thiếu `runUnscoped` ở đây là một lỗi thầm lặng, không phải một lỗi 500.
 *
 * `estimatedDocumentCount` bị cấm ở tầng plugin (nó bỏ qua filter tenant), nên mọi chỗ dưới
 * đây dùng `countDocuments` — chậm hơn nhưng đúng, và bàn này mở vài lần một ngày.
 */

/** Mốc `n` ngày trước, dùng chung cho mọi ô "mới trong N ngày". */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

export const metricsRepository = {
  /** `Organization` không gắn plugin — đếm thẳng, không cần khai unscoped. */
  async organizations(newWindows: number[]) {
    const [total, active, suspended, pendingAdmin, ...fresh] = await Promise.all([
      Organization.countDocuments({}).exec(),
      Organization.countDocuments({ status: TENANT_STATUS.ACTIVE }).exec(),
      Organization.countDocuments({ status: TENANT_STATUS.SUSPENDED }).exec(),
      Organization.countDocuments({ status: TENANT_STATUS.PENDING_ADMIN }).exec(),
      ...newWindows.map((d) =>
        Organization.countDocuments({ createdAt: { $gte: daysAgo(d) } }).exec(),
      ),
    ])

    return { total, active, suspended, pendingAdmin, fresh }
  },

  /**
   * Org đang mở mà KHÔNG còn manager nào — thứ hệ thống hiện không có chốt nào ngăn.
   *
   * `canRevoke` chỉ chặn thu hồi role `master`, không giữ sàn "mỗi org ≥1 manager", nên một org
   * mất người quản cuối (rời nhóm, bị khoá, xoá tài khoản) là hàng đợi duyệt tin / báo cáo /
   * đơn gia nhập của nó không còn ai mở. Hôm nay master là lưới đỡ, nhưng master không có cách
   * nào BIẾT điều đó đang xảy ra — nên nó phải là một con số trên bàn quản trị.
   *
   * `pending_admin` cố ý không tính: org ở trạng thái đó CHƯA từng có admin, đó là một bước
   * bình thường của luồng tạo org chứ không phải sự cố. Trộn hai thứ vào một số là biến một
   * cảnh báo thật thành con số lúc nào cũng khác 0, và rồi không ai nhìn nó nữa.
   */
  async orgsWithoutManager(): Promise<number> {
    const [activeIds, managedIds] = await Promise.all([
      Organization.distinct('_id', { status: TENANT_STATUS.ACTIVE }).exec(),
      roleGrantRepository.orgIdsWithActiveManager(),
    ])

    const managed = new Set(managedIds.map((id) => id.toString()))
    return activeIds.filter((id: Types.ObjectId) => !managed.has(id.toString())).length
  },

  /**
   * `User` không gắn plugin, nhưng có `pre('countDocuments', excludeDeleted)` — nên `total` ở
   * đây nghĩa là "tài khoản chưa xoá", không phải mọi dòng trong collection. Đúng thứ cần đếm.
   */
  async users(newWindows: number[]) {
    const [total, active, ...fresh] = await Promise.all([
      User.countDocuments({}).exec(),
      User.countDocuments({ isActive: true }).exec(),
      ...newWindows.map((d) => User.countDocuments({ createdAt: { $gte: daysAgo(d) } }).exec()),
    ])

    return { total, active, locked: total - active, fresh }
  },

  /** `Listing` gắn plugin `dualAxis` → mọi câu dưới đây BẮT BUỘC unscoped (xem đầu file). */
  listings(newWindows: number[]) {
    return runUnscoped('metrics: đếm tin toàn hệ thống cho bàn master', async () => {
      const [total, byVisibility, ...fresh] = await Promise.all([
        Listing.countDocuments({ deletedAt: null }).exec(),
        Listing.aggregate<{ _id: string; count: number }>([
          { $match: { deletedAt: null } },
          { $group: { _id: '$visibility', count: { $sum: 1 } } },
        ]),
        ...newWindows.map((d) =>
          Listing.countDocuments({ deletedAt: null, createdAt: { $gte: daysAgo(d) } }).exec(),
        ),
      ])

      const visibilityOf = (v: string) => byVisibility.find((r) => r._id === v)?.count ?? 0
      return {
        total,
        publicAxis: visibilityOf(POST_VISIBILITY.PUBLIC),
        orgInternal: visibilityOf(POST_VISIBILITY.ORG_INTERNAL),
        fresh,
      }
    })
  },

  /**
   * Sức khoẻ hàng đợi duyệt: bao nhiêu tin chờ ở mỗi trục, và tin chờ LÂU NHẤT bao nhiêu ngày.
   *
   * Tuổi tin chờ lâu nhất quan trọng hơn tổng số tin chờ: 200 tin chờ 2 giờ là bàn duyệt đang
   * chạy, còn 3 tin chờ 40 ngày là ba tin không ai nhận — đúng cái tồn đọng mà master phải dọn
   * sau khi rời việc duyệt hằng ngày. Tổng số thì đã có ở `pending` mỗi trục.
   */
  moderationHealth() {
    return runUnscoped('metrics: sức khoẻ hàng đợi duyệt toàn hệ thống', async () => {
      const pending = { status: LISTING_STATUS.PENDING, deletedAt: null }
      const [pendingPublicAxis, pendingOrgAxis, oldest, openReports] = await Promise.all([
        Listing.countDocuments({ ...pending, visibility: POST_VISIBILITY.PUBLIC }).exec(),
        Listing.countDocuments({ ...pending, visibility: POST_VISIBILITY.ORG_INTERNAL }).exec(),
        Listing.findOne(pending).sort({ createdAt: 1 }).select('createdAt').lean().exec(),
        // `countOpen()` trả về Query CHƯA `exec()`. Không gọi `.exec()` ngay trong callback là
        // pre hook của plugin chạy SAU khi AsyncLocalStorage đã thoát ngữ cảnh → "Missing
        // tenant context". Cùng cái bẫy đã cắn một lần ở `chat.open`.
        reportRepository.countOpen().exec(),
      ])

      const oldestPendingDays = oldest
        ? Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 86_400_000)
        : 0

      return { pendingPublicAxis, pendingOrgAxis, oldestPendingDays, openReports }
    })
  },
}
