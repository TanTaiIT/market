import mongoose, { FilterQuery, Schema, Document, Model, Types } from 'mongoose'
import {
  REPORT_KIND,
  REPORT_STATUS,
  REPORT_TARGET,
  ReportKind,
  ReportStatus,
  ReportTarget,
} from '../../common/constants'
import { coverageOf, tenantPlugin } from '../../common/tenant/tenantPlugin'
import type { TenantScope } from '../../common/tenant/tenantContext'

/**
 * Báo cáo của người dùng về một tin hoặc một người.
 *
 * `targetTitle` và `reporterName` là **snapshot**: §2.3 cấm populate sang `User`, và tin bị gỡ
 * rồi thì báo cáo vẫn phải đọc được — đây là hồ sơ xử lý, không phải một cái link.
 *
 * KHÔNG có field đếm: "3 lượt báo cáo" là `$group` theo `targetId` lúc đọc. Counter sẽ lệch
 * ngay lần đầu có người rút báo cáo.
 */
export interface IReport {
  /** Trục của ĐỐI TƯỢNG bị báo cáo: org của tin, hoặc `null` = trục danh mục. Không phải org của người tố. */
  organizationId: Types.ObjectId | null
  /**
   * Toạ độ ô của TIN bị báo cáo — chỉ khi `organizationId: null`, còn lại `null`. Snapshot lúc
   * gửi để vế đọc của người phụ trách ô (`coverageOf`) lọc được ngay trên báo cáo, không phải
   * join sang tin. Tên field cố ý trùng `Listing`: cùng một vế, hai collection.
   */
  category: Types.ObjectId | null
  provinceCode: string | null
  wardCode: string | null
  targetType: ReportTarget
  targetId: Types.ObjectId
  targetTitle: string
  kind: ReportKind
  quote: string
  reporterId: Types.ObjectId
  reporterName: string
  status: ReportStatus
  resolution?: {
    action: string
    byUserId: Types.ObjectId
    byName: string
    at: Date
  }
  createdAt: Date
  updatedAt: Date
}

export interface IReportDocument extends IReport, Document {
  _id: Types.ObjectId
}

const reportSchema = new Schema<IReportDocument>(
  {
    targetType: { type: String, enum: Object.values(REPORT_TARGET), required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    targetTitle: { type: String, required: true, trim: true, maxlength: 150 },
    kind: { type: String, enum: Object.values(REPORT_KIND), required: true },
    quote: { type: String, required: true, trim: true, maxlength: 1000 },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reporterName: { type: String, required: true, trim: true, maxlength: 100 },
    category: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    provinceCode: { type: String, default: null, trim: true },
    wardCode: { type: String, default: null, trim: true },
    status: { type: String, enum: Object.values(REPORT_STATUS), default: REPORT_STATUS.OPEN },
    resolution: {
      type: new Schema(
        {
          action: { type: String, required: true, trim: true, maxlength: 30 },
          byUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          byName: { type: String, required: true, trim: true, maxlength: 100 },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
)

/**
 * Vế trục danh mục của báo cáo. Khoá trục là `organizationId: null` — báo cáo không có
 * `visibility`. Người thường (`mode: 'approved'`) KHÔNG đọc báo cáo nào: hàng đợi báo cáo lộ ra
 * ai tố ai, nên vế này chỉ mở cho người duyệt, và chỉ trong ô của họ; master thì `cells: null`
 * = cả trục.
 */
function reportPublicPredicate(scope: TenantScope): FilterQuery<unknown> | null {
  const axis = scope.publicAxis
  return axis?.mode === 'moderator' ? coverageOf(axis, { organizationId: null }) : null
}

// Báo cáo đóng dấu TRỤC CỦA TIN, không phải org của người tố: tin nội bộ → org đó xử; tin công
// khai (`organizationId: null`) → người phụ trách ô, master là fallback. Xem `report.service`.
reportSchema.plugin(tenantPlugin, { dualAxis: true, publicPredicate: reportPublicPredicate })

reportSchema.index({ organizationId: 1, status: 1, createdAt: -1 })
// Gom nhóm "N lượt báo cáo" + chặn một người báo cáo cùng đối tượng hai lần khi chưa xử xong.
reportSchema.index({ organizationId: 1, targetType: 1, targetId: 1 })
reportSchema.index(
  { organizationId: 1, targetId: 1, reporterId: 1 },
  { unique: true, partialFilterExpression: { status: REPORT_STATUS.OPEN } },
)

export const Report: Model<IReportDocument> = mongoose.model<IReportDocument>(
  'Report',
  reportSchema,
)
