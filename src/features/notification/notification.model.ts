import mongoose, { Schema, Document, Model, Types } from 'mongoose'

export interface INotification {
  /**
   * Org phát ra thông báo này. `null` = việc xảy ra ngoài mọi tổ chức — tin trên trục danh mục
   * được duyệt, lời mời từ một org mà người nhận chưa thuộc về.
   */
  organizationId: Types.ObjectId | null
  /**
   * Người nhận ĐÍCH DANH. `null` = thông báo phát chung cho tổ chức/nhóm con như trước.
   *
   * Có mặt vì trước đây model chỉ có `organizationId` + `unitId`, tức chỉ phát được theo nhóm.
   * Mọi sự kiện thuộc về MỘT người — tin bị từ chối kèm lý do, đơn xin vào org được duyệt —
   * không có chỗ đáp: lý do từ chối nằm im trong `listing.moderation.reason` và người đăng
   * phải tự mở tin ra mới biết.
   */
  userId: Types.ObjectId | null
  /**
   * Nhóm con nhận thông báo. `null` = cả tổ chức.
   *
   * Có mặt vì quyền duyệt trong org vốn đã phân tầng (§7.2a): `staff` scope `org_unit` chỉ với
   * tới nhóm của mình. Thiếu cột này thì họ vẫn `POST /notifications` được và chạm tới toàn bộ
   * tổ chức — rộng hơn hẳn phạm vi được cấp.
   */
  unitId: Types.ObjectId | null
  /**
   * NGƯỜI GÂY RA thông báo. `null` = hệ thống hoặc quản trị nhóm (thông báo tự soạn).
   *
   * Ba việc, không phải một:
   *
   * 1. Vẽ được câu "Tài vừa đăng …" — thứ phân biệt một thông báo có ích với một dòng "có tin
   *    mới" vô danh.
   * 2. LOẠI người gây ra khỏi hộp thư của chính họ. Nhánh phát chung (`userId: null`) không có
   *    danh sách người nhận nên không loại trừ được ai — trừ khi biết ai là tác giả. Thiếu
   *    field này thì Tài nhận thông báo "Tài vừa đăng…" về chính tin của mình.
   * 3. Phân loại trạng thái đọc: `actorId` khác `null` nghĩa là dòng SINH TỰ ĐỘNG, tần suất cao
   *    — nó dùng mốc `Membership.notificationsSeenAt` chứ không tích vào `readBy`. Xem `readBy`.
   */
  actorId: Types.ObjectId | null
  /** Tên người gây ra, snapshot lúc tạo — §2.3 cấm populate sang `User`. */
  actorName: string
  /** Tin đăng mà thông báo nói về. `null` = thông báo không dẫn tới tin nào. */
  listingId: Types.ObjectId | null
  title: string
  body: string
  readBy: Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}

export interface INotificationDocument extends INotification, Document {
  _id: Types.ObjectId
}

const notificationSchema = new Schema<INotificationDocument>(
  {
    /*
     * Khai TƯỜNG MINH, vì `tenantPlugin` không còn thêm nó hộ nữa.
     *
     * Đây là cái bẫy của việc gỡ plugin: interface vẫn khai `organizationId` nên TypeScript im
     * lặng, nhưng Mongoose vứt mọi field không có trong schema lúc ghi — thông báo phát chung
     * lưu xuống mất org, và không ai đọc lại được nó. Test bắt được, typecheck thì không.
     */
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    unitId: { type: Schema.Types.ObjectId, ref: 'OrgUnit', default: null },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '', trim: true, maxlength: 100 },
    listingId: { type: Schema.Types.ObjectId, ref: 'Listing', default: null },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 2000 },
    /*
     * CHỈ dùng cho thông báo do người soạn: đích danh (`userId`), và thông báo quản trị tự gửi
     * cho cả nhóm. Ở đó nó rẻ và cần thiết — `readCount` là con số duy nhất cho quản trị biết
     * thông báo của mình có ai đọc.
     *
     * Dòng SINH TỰ ĐỘNG (`actorId` khác `null`) KHÔNG dùng nó, mà so `createdAt` với mốc
     * `Membership.notificationsSeenAt`. Lý do là kích thước: nhóm 500 người đọc hết một dòng là
     * 500 ObjectId ≈ 6 KB, phình document lên ~20 lần — nhân với mỗi tin mỗi ngày thì đó là
     * ~180 MB/tháng cho 100 nhóm, trên một cluster 512 MB. Mốc thời gian tốn 0 byte mỗi lượt
     * đọc và "đánh dấu đã đọc tất cả" chỉ là một lượt ghi.
     *
     * ponytail: khi cần biết AI đọc dòng tự động lúc nào thì tách bảng `NotificationRead`,
     * đừng nới mảng này.
     */
    readBy: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
  },
  { timestamps: true },
)

/*
 * KHÔNG gắn `tenantPlugin` — hộp thư thuộc về NGƯỜI NHẬN, không thuộc tổ chức.
 *
 * Bản trước gắn plugin và `organizationId` bắt buộc, nên toàn bộ trục danh mục không có thông
 * báo nào: tin công khai có `organizationId: null`, `notifyUser` lặng lẽ trả `null`, và người
 * đăng không bao giờ biết tin mình được duyệt hay bị từ chối. Người thuộc hai org cũng chỉ đọc
 * được hộp thư của org đang chọn.
 *
 * Cách ly không vì thế mà thủng: nhánh PHÁT CHUNG (`userId: null`) vẫn lọc `organizationId`
 * tường minh theo org của request — xem `broadcastFilter`. Chỉ thông báo đích danh mới đi
 * theo người.
 */

// `createdAt` đứng TRƯỚC `unitId`/`userId` dù hai cái sau mới là thứ được lọc: đường đọc phổ
// biến nhất (`scope=managed` của quản lý cấp org) chỉ ràng `organizationId` rồi sort
// `createdAt`. Xếp chúng chen vào giữa thì index không phục vụ được sort đó nữa và Mongo phải
// sort trong bộ nhớ. Ở thứ tự này MỌI đường đọc dùng chung một index: `organizationId` cho
// bounds, `createdAt` cho thứ tự, còn `unitId`/`userId` lọc ngay trên khoá index (không fetch).
notificationSchema.index({ organizationId: 1, createdAt: -1, unitId: 1, userId: 1 })

// Hộp thư ĐÍCH DANH: nhánh này giờ không còn ràng `organizationId` nên index trên không phục
// vụ nó — thiếu dòng dưới thì mỗi lần mở màn thông báo là một lượt quét cả bảng.
notificationSchema.index({ userId: 1, createdAt: -1 })

export const Notification: Model<INotificationDocument> = mongoose.model<INotificationDocument>(
  'Notification',
  notificationSchema,
)
