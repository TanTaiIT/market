import mongoose, { Schema, Document, Model, Types } from 'mongoose'
import { SOCIAL_FEEDBACK_STATUS, SocialFeedbackStatus } from '../../common/constants'

/**
 * Đánh giá / phản ánh / kiến nghị do TỔ CHỨC XÃ HỘI gửi lên — **cụm TẠM THỜI, dựng để gỡ**.
 *
 * Đây là nghĩa vụ công bố của sàn thương mại điện tử, không phải một tính năng sản phẩm: sàn
 * phải có nơi tiếp nhận ý kiến của tổ chức xã hội tham gia bảo vệ quyền lợi người tiêu dùng,
 * và phải công bố lại những ý kiến đó.
 *
 * ## Gỡ cụm này — bốn bước ở repo BE
 *
 * 1. Xoá thư mục `src/features/social-feedback/`.
 * 2. Xoá `tests/integration/social-feedback.test.ts`.
 * 3. `src/features/index.ts`: bỏ dòng `import socialFeedbackRoutes` và dòng `router.use`.
 * 4. `src/common/constants/index.ts`: bỏ khối `SOCIAL_FEEDBACK_STATUS`.
 *
 * Nửa FE nằm ở repo `docs/VueSer`, công thức riêng trong `src/api/legal.ts`.
 *
 * Collection `socialfeedbacks` ở lại DB cho tới khi ai đó drop tay — không có migration nào
 * cần chạy, và giữ lại thì còn bằng chứng đã từng tiếp nhận những gì.
 *
 * ## Vì sao KHÔNG gắn `tenantPlugin`
 *
 * Cùng nhóm với `BannedPhrase`/`Category` (multi-tenant convention §1.3): ý kiến gửi về là
 * gửi cho PHÁP NHÂN vận hành sàn, không gửi cho một nhóm nào. Gắn tenant vào đây là chia
 * nghĩa vụ pháp lý của công ty thành n bản theo tổ chức — sai về nghiệp vụ, và sẽ làm trang
 * công bố rỗng với khách chưa chọn nhóm.
 */
export interface ISocialFeedback {
  /** Tên tổ chức xã hội — người gửi tự khai, không đối chiếu được với nguồn nào. */
  orgName: string
  /** Số quyết định thành lập của tổ chức đó, cũng do người gửi tự khai. */
  decisionNo: string
  content: string
  status: SocialFeedbackStatus
  /**
   * Ai duyệt/từ chối. Vắng = chưa ai đụng tới.
   *
   * Không có `submittedBy`: cửa gửi không đăng nhập, nên phía gửi KHÔNG có danh tính nào để
   * lưu ngoài chữ họ tự khai. Đừng thêm `optionalAuth` rồi ghi `req.user` vào đây — nó tạo
   * ra một cột danh tính chỉ đúng với người tình cờ đang đăng nhập, tức là một cột sai.
   */
  reviewedBy?: Types.ObjectId
  reviewedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface ISocialFeedbackDocument extends ISocialFeedback, Document {
  _id: Types.ObjectId
}

const socialFeedbackSchema = new Schema<ISocialFeedbackDocument>(
  {
    orgName: { type: String, required: true, trim: true, maxlength: 200 },
    decisionNo: { type: String, required: true, trim: true, maxlength: 100 },
    content: { type: String, required: true, trim: true, maxlength: 5000 },
    status: {
      type: String,
      enum: Object.values(SOCIAL_FEEDBACK_STATUS),
      default: SOCIAL_FEEDBACK_STATUS.PENDING,
      required: true,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        const r = ret as Record<string, unknown>
        delete r.__v
        return r
      },
    },
  },
)

/*
 * Khoá mở đầu bằng `status` chứ không `createdAt`: cả hai đường đọc đều lọc status trước
 * (trang công bố lấy `published`, bàn duyệt lấy `pending`), rồi mới sắp theo thời gian.
 * Không có `organizationId` để làm prefix vì collection này không gắn tenant — lý do ở
 * docblock đầu file.
 */
socialFeedbackSchema.index({ status: 1, createdAt: -1, _id: -1 })

export const SocialFeedback: Model<ISocialFeedbackDocument> =
  mongoose.model<ISocialFeedbackDocument>('SocialFeedback', socialFeedbackSchema)
