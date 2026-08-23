import mongoose, { Schema, Document, Model, Types } from 'mongoose'

/**
 * Từ điển cụm cấm — master quản qua API, thay cho danh sách hardcode trong
 * `moderation.machine.ts` (bản hardcode giờ chỉ còn là SEED khởi điểm).
 *
 * KHÔNG gắn `tenantPlugin` — cùng nhóm với `Category` (multi-tenant convention §1.3): luật
 * nội dung áp toàn nền tảng, một org không được tự nới cho khu vực của mình.
 *
 * Xoá là xoá CỨNG, khác các entity nghiệp vụ: đây là từ điển, gỡ một cụm nghĩa là luật đổi —
 * không có tin nào trỏ vào nó để mà mồ côi, và vết ai-gỡ-gì đã nằm ở log của service.
 */
export interface IBannedPhrase {
  /** Đã chuẩn hoá lowercase + trim từ tầng schema — so khớp là `includes` trên text thường. */
  phrase: string
  addedBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

export interface IBannedPhraseDocument extends IBannedPhrase, Document {
  _id: Types.ObjectId
}

const bannedPhraseSchema = new Schema<IBannedPhraseDocument>(
  {
    phrase: { type: String, required: true, trim: true, lowercase: true, maxlength: 100 },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
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

bannedPhraseSchema.index({ phrase: 1 }, { unique: true })

export const BannedPhrase: Model<IBannedPhraseDocument> = mongoose.model<IBannedPhraseDocument>(
  'BannedPhrase',
  bannedPhraseSchema,
)
