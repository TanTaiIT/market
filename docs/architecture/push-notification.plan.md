# Push notification — kế hoạch triển khai

> Trạng thái (2026-09-27): **P1–P3 đã code, gate xanh; P0 chờ tài khoản.** Push TẮT trên server
> (`PUSH_ENABLED=false`) tới khi có dev build Android kèm credential FCM — xem §11.
> Phạm vi: `docs/market` (BE) + `docs/VueSer` (app Ghim).
> Nguồn: audit 2026-09-26 mục 4.6 ("Push notification: chưa, cần FCM"). Ngày lập: 2026-09-27.

## 0. Tóm tắt một đoạn

App hiện báo tin qua hai kênh: **hộp thư** (collection `notifications`, đọc khi mở app) và
**socket** (`notif:new`, `chat:inbox`, `support:reply` — chỉ tới khi app đang mở và còn kết
nối). Đóng app là im lặng. Kế hoạch thêm kênh thứ ba — **push qua Expo Push Service** — bằng
cách móc vào đúng hai điểm đã gom mọi thông báo (`notificationService.notifyUser` và
`createForOrganization`) cộng tin nhắn chat. Gửi **bất đồng bộ qua outbox** để request không
bao giờ chờ mạng ngoài, có retry và đọc receipt để dọn token chết. App chuyển từ Expo Go sang
**development build** (bắt buộc: Expo Go trên Android không nhận push từ SDK 53).

---

## 1. Hiện trạng (đã đọc code)

| Kênh                   | Ở đâu                                                                                                 | Tới được khi nào                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Hộp thư                | `notificationService.notifyUser` / `createForOrganization` / `notifyGroupOfListing` → `notifications` | Người dùng tự mở tab Thông báo                         |
| Socket `notif:new`     | cùng ba hàm trên, `emitToUser` / `emitToOrgMembers`                                                   | App đang mở, socket còn nối                            |
| Socket `chat:inbox`    | `chatService.send`                                                                                    | như trên — **tin nhắn chat không có dòng hộp thư nào** |
| Socket `support:reply` | `supportService.reply`                                                                                | như trên — cố ý không vào hộp thư                      |

Điểm phát thông báo đích danh hiện có (đều đi qua `notifyUser`):

| Sự kiện                                                                 | Nguồn                                                                                                    | Nhóm push đề xuất |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------- |
| Tin được duyệt / bị từ chối / bị ẩn / bị gỡ                             | `moderation.service` `notifyPoster`, `notifyRemoved`; máy duyệt; cổng cụm cấm ở `listing.service.create` | `listing_status`  |
| Tin hết hạn                                                             | `listing.expiry.service`                                                                                 | `listing_status`  |
| Đơn vào nhóm được duyệt / bị từ chối                                    | `join-request.service`                                                                                   | `membership`      |
| Được mời vào nhóm                                                       | `invite.service`                                                                                         | `membership`      |
| Được giao phụ trách tổ chức                                             | `organization.service.grantAdmin`                                                                        | `membership`      |
| Báo cáo của bạn đã xử lý / đã xem xét                                   | `report.service.resolve`                                                                                 | `report`          |
| Khoá / mở khoá, quản chế / gỡ quản chế, gỡ án đăng tin, phục hồi uy tín | `user.service`                                                                                           | `account`         |
| Ví Xu cộng / trừ                                                        | `wallet.service`                                                                                         | `wallet`          |
| Thông báo quản trị soạn cho nhóm / nhóm con                             | `createForOrganization`                                                                                  | `group_notice`    |
| "X vừa đăng một tin mới" (phát chung cả nhóm)                           | `notifyGroupOfListing`                                                                                   | `group_activity`  |
| Tin nhắn chat mới                                                       | `chatService.send` (chỉ socket)                                                                          | `chat`            |
| Master trả lời hỗ trợ                                                   | `supportService.reply` (chỉ socket)                                                                      | `support`         |

Hạ tầng liên quan đã có: Agenda (job nền, retry), `user.sessions` + `bumpTokenVersion` (đăng
xuất = thu hồi mọi phiên), `disconnectUser`, `redact.ts` (che dữ liệu nhạy cảm trong log),
TTL index, `apiLimiter`. App: expo-router, TanStack Query (`qk`), `useNotifSignal`, màn
`(tabs)/notif.tsx` đã điều hướng theo `listingId` / `orgId`.

---

## 2. Mục tiêu và ngoài phạm vi

**Mục tiêu**

1. Mọi sự kiện ở bảng trên tới được điện thoại khi app đóng/chạy nền, trong vài giây.
2. Chạm vào push mở **đúng màn** (tin, hội thoại, hộp thư, ví…), kể cả khi app đang tắt hẳn.
3. Người dùng tắt được theo **nhóm** (chat, trạng thái tin, hoạt động nhóm…) và tắt hết.
4. Không bao giờ gửi nhầm người: đổi tài khoản trên cùng máy, đăng xuất, bị khoá/xoá → máy đó
   ngừng nhận ngay.
5. Không làm chậm request nào; Expo sập thì nghiệp vụ vẫn chạy, push gửi bù khi Expo sống lại.
6. Không spam: gộp chat dồn dập, mặc định tắt push "hoạt động nhóm" (fan-out lớn, giá trị thấp).

**Ngoài phạm vi đợt này** (ghi để khỏi trôi vào): giờ yên lặng (quiet hours), gộp push theo
ngày (digest), push web, rich push (ảnh, nút hành động), đếm badge chính xác tuyệt đối trên
nhiều org (làm bản xấp xỉ ở giai đoạn 4), A/B nội dung.

---

## 3. Quyết định kiến trúc

### 3.1 Expo Push Service, không gọi thẳng FCM/APNs

- **Chọn:** app lấy `ExpoPushToken`, BE gửi qua `https://exp.host/--/api/v2/push/send`, Expo
  chuyển tiếp sang FCM (Android) / APNs (iOS).
- **Vì sao:** một API và một loại token cho cả hai nền tảng; không phải giữ khoá service
  account của Firebase hay khoá APNs trên server (chúng nằm ở EAS); app Expo lấy token này
  sẵn có.
- **Cái giá:** phụ thuộc thêm Expo làm trung gian. Chấp nhận được — app đã phụ thuộc Expo toàn
  bộ. Đường thoát nếu cần: `getDevicePushTokenAsync` + `firebase-admin`, schema thiết bị dưới
  đây đã chừa cột `provider`.
- **Client BE:** tự viết bằng `fetch` của Node 20 (`push.client.ts`), KHÔNG dùng `expo-server-sdk`:
  bản hiện hành (7.x) chỉ phát hành ESM và đòi Node ≥ 22.12, backend là CommonJS trên Node 20. API
  chỉ có hai endpoint (`send`, `getReceipts`); chia lô 100 tin nằm ở dispatcher. Không thêm dependency.
- **Bảo mật:** bật _Enhanced push security_ trên EAS và cấu hình `EXPO_ACCESS_TOKEN` ở BE —
  không có nó thì ai lấy được một push token cũng gửi push giả mạo tới máy đó được.

### 3.2 Gửi bất đồng bộ qua outbox

`notifyUser` hiện chạy trong request (duyệt tin, xử báo cáo…). Gọi Expo đồng bộ ở đó là cộng
thêm độ trễ mạng ngoài và biến "Expo chậm" thành "duyệt tin chậm".

```
notifyUser / createForOrganization / chat.send
        │  (đã ghi xong dữ liệu nghiệp vụ)
        ▼
pushService.enqueue(userIds, message)      ← chỉ ghi Mongo, không gọi mạng
        │  ghi `push_outbox` (1 dòng / người nhận / sự kiện)
        │  rồi đánh thức dispatcher (setImmediate)
        ▼
pushDispatcher.run()                       ← claim CAS: pending → sending
        │  lọc theo tuỳ chọn + thiết bị còn sống
        │  gửi lô ≤100 qua expo-server-sdk
        ▼
ticket ok  → sent (lưu ticketId)           ticket lỗi → xử lý ngay (xem §3.5)
        │
job `push:receipts` (mỗi 15 phút)          ← đọc receipt, DeviceNotRegistered → tắt thiết bị
job `push:dispatch` (mỗi 1 phút)           ← vét dòng pending/sending quá hạn (sập giữa chừng)
```

- **Tại sao outbox mà không `agenda.now()` mỗi push:** Agenda ghi một job document cho mỗi lần,
  fan-out 500 người là 500 job; outbox là collection riêng, index gọn, TTL tự dọn, và đếm được
  "đang tồn bao nhiêu" để giám sát.
- **Độ trễ:** đường nóng là `setImmediate` ngay sau khi ghi → vài trăm ms. Job 1 phút chỉ là
  lưới an toàn.
- **Nhiều instance:** hiện chấp nhận 1 instance (audit 7.11), nhưng claim bằng
  `findOneAndUpdate({status: pending}) → sending + lockedAt` nên thêm instance vẫn không gửi đôi.

### 3.3 Lọc ở lúc GỬI, không ở lúc ghi

Tuỳ chọn tắt/bật, tài khoản bị khoá, thiết bị bị tắt — đều kiểm ở dispatcher, ngay trước khi
gửi. Người dùng tắt chat lúc 10:00:00 thì push chat còn tồn từ 09:59:59 cũng không đi.

### 3.4 Push là CÁI BÓNG của hộp thư, không phải nguồn sự thật

- Nội dung push = `title` + `body` của dòng hộp thư (cắt ngắn), cộng `data.path` để điều hướng.
- Chạm vào push → app mở màn đích và `invalidate` hộp thư; đánh dấu đã đọc vẫn đi qua API hiện
  có. Không có trạng thái "đã đọc" riêng cho push.
- Chat và hỗ trợ không có dòng hộp thư → push của chúng dẫn thẳng vào hội thoại / màn hỗ trợ.

### 3.5 Xử lý lỗi từ Expo

| Lỗi                                         | Xử lý                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DeviceNotRegistered` (ticket hoặc receipt) | Đặt `disabledAt` cho thiết bị, không gửi nữa                                           |
| `MessageTooBig` (>4096 byte)                | Bug phía BE → log `error` + Sentry, bỏ dòng. Chặn trước bằng giới hạn độ dài ở builder |
| `MessageRateExceeded`                       | Lùi dần (1, 5, 15 phút), tối đa 3 lần rồi `failed`                                     |
| `InvalidCredentials` / `MismatchSenderId`   | Sai cấu hình EAS/Firebase → Sentry cảnh báo ngay, giữ `pending` để gửi bù sau khi sửa  |
| Lỗi mạng / 5xx của Expo                     | Retry theo lịch lùi dần như trên                                                       |

---

## 4. Thiết kế phía BE (`docs/market`)

### 4.1 Module mới `src/features/push/`

Theo khuôn module hiện có: `push.model.ts`, `push.repository.ts`, `push.service.ts`,
`push.dispatcher.ts`, `push.schema.ts`, `push.controller.ts`, `push.routes.ts`,
`push.constants.ts`, `push.types.ts`.

**`PushDevice`** (collection `push_devices`, KHÔNG gắn `tenantPlugin` — thiết bị thuộc về người):

| Field                       | Ghi chú                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `userId`                    | ObjectId, index                                                                      |
| `token`                     | `ExponentPushToken[...]`, **unique** — một máy chỉ thuộc một người tại một thời điểm |
| `provider`                  | `'expo'` (chừa đường thoát sang FCM trực tiếp)                                       |
| `platform`                  | `'ios' \| 'android'`                                                                 |
| `appVersion`, `deviceName?` | để hỗ trợ ("máy nào đang nhận")                                                      |
| `lastSeenAt`                | cập nhật mỗi lần app đăng ký lại (mỗi lần mở app)                                    |
| `disabledAt`                | `null` = còn sống; đặt khi `DeviceNotRegistered`                                     |

- Đăng ký = **upsert theo `token`**: máy đang thuộc A mà B đăng nhập → dòng chuyển sang B. Đây
  là chốt của mục tiêu 4 — không có nó thì B đăng nhập trên máy của A vẫn nhận push của A.
- Trần `PUSH_DEVICES_MAX = 10` / người; vượt thì bỏ thiết bị `lastSeenAt` cũ nhất.
- Job dọn: thiết bị `lastSeenAt` quá 90 ngày hoặc `disabledAt` quá 30 ngày → xoá.

**`PushOutbox`** (collection `push_outbox`):

| Field                                                                                        | Ghi chú                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `userId`, `category`, `title`, `body`, `data` (`path`, `notificationId?`, `conversationId?`) | nội dung đã dựng sẵn                            |
| `collapseKey?`                                                                               | gộp chat: `chat:<conversationId>`               |
| `status`                                                                                     | `pending → sending → sent \| failed \| skipped` |
| `attempts`, `nextAttemptAt`, `lockedAt`                                                      | retry + claim                                   |
| `tickets[]`                                                                                  | `{ deviceId, ticketId?, error? }`               |
| `receiptCheckedAt?`                                                                          |                                                 |
| `createdAt`                                                                                  | **TTL 7 ngày**                                  |

Index: `{status, nextAttemptAt}` (dispatcher), `{userId, collapseKey, createdAt}` (gộp chat),
`{ 'tickets.ticketId': 1 }` sparse (receipt).

**Tuỳ chọn trên `User`:** `pushPrefs: { enabled, chat, listing_status, membership, report,
account, wallet, group_notice, group_activity, support }`. Mặc định bật hết trừ
`group_activity` (xem §6 câu hỏi 3). `account` **không tắt được** — khoá tài khoản, quản chế là
thông tin người dùng buộc phải biết.

### 4.2 API mới (đều `authenticate` + limiter, khai OpenAPI → app sinh SDK)

| Method   | Path                   | Việc                                                                                 |
| -------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `POST`   | `/push/devices`        | Đăng ký/đăng ký lại `{token, platform, appVersion, deviceName?}` — upsert theo token |
| `DELETE` | `/push/devices/:token` | Gỡ máy này (gọi trước khi đăng xuất)                                                 |
| `GET`    | `/push/preferences`    | Đọc tuỳ chọn                                                                         |
| `PATCH`  | `/push/preferences`    | Sửa tuỳ chọn (zod `.strict()`, chỉ nhận key đã biết)                                 |
| `POST`   | `/push/test`           | Gửi một push thử tới chính mình — cho màn cài đặt và cho QA; limiter chặt (3/giờ)    |

Validate token bằng `Expo.isExpoPushToken`. Không có endpoint nào nhận `userId` từ client.

### 4.3 Móc vào điểm phát

1. **`notificationService.notifyUser`** — thêm tham số `push: { category, path }` (bắt buộc về
   kiểu, để call site mới không quên chọn nhóm). Sau khi ghi hộp thư: `pushService.enqueue`.
   Sửa ~20 call site ở bảng §1 để truyền `category` + `path` (ví dụ tin → `/listing/<id>`,
   ví → `/profile`, đơn nhóm → `/org/<orgId>`).
2. **`createForOrganization`** — `group_notice`; người nhận = thành viên active của org / nhóm
   con (đã có `listActiveUserIdsByUnit`; thêm `listActiveUserIdsByOrg`). Fan-out ghi outbox
   theo lô `insertMany` 500 dòng.
3. **`notifyGroupOfListing`** — `group_activity`, trừ người đăng. Chỉ enqueue cho người đã BẬT
   nhóm này (lọc ngay lúc enqueue để khỏi ghi 500 dòng `skipped`).
4. **`chatService.send`** — `chat`, `path = /chat/<id>`, `collapseKey = chat:<id>`. **Gộp:** nếu
   đã có dòng cùng `collapseKey` trong 30 giây gần nhất còn `pending` → cập nhật body thành
   "N tin nhắn mới từ X" thay vì thêm dòng.
5. **`supportService.reply`** — `support`, `path = /settings` (hoặc màn hỗ trợ).

Không móc ở tầng repository hay middleware: push là quyết định nghiệp vụ ("sự kiện này đáng làm
phiền người ta không"), nên nằm ở service cạnh chỗ đã quyết định ghi hộp thư.

### 4.4 Nội dung push

- `title` ≤ 60 ký tự, `body` ≤ 150 ký tự (cắt có dấu "…") — tổng payload luôn dưới 4096 byte.
- **Chat không kèm nội dung tin nhắn**, chỉ "Tài gửi bạn một tin nhắn" — màn hình khoá là nơi
  người khác nhìn thấy được; comment hiện có ở `chat.service` cũng chốt payload mỏng vì lý do
  này (xem §6 câu hỏi 4).
- `data`: `{ path, category, notificationId? }` — không id nội bộ nào khác, không email/SĐT.
- Android `channelId` = category (người dùng chỉnh được âm thanh/ưu tiên từng kênh trong cài
  đặt hệ thống); iOS `threadId` = category để gom trong Notification Center.
- `priority: 'high'` cho `chat`, `account`; `'default'` cho phần còn lại. `ttl`: chat 1 giờ,
  còn lại 24 giờ — push trễ quá mức đó thì vô nghĩa, hộp thư đã giữ bản gốc.

### 4.5 Vòng đời thiết bị gắn với phiên

| Sự kiện                                                           | Việc với `push_devices`                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Đăng xuất (`auth.logout` → `bumpTokenVersion`, thu hồi mọi phiên) | Xoá **mọi** thiết bị của người đó — đăng xuất hiện đã đá mọi máy            |
| Đổi mật khẩu (thu hồi phiên khác)                                 | Xoá mọi thiết bị trừ máy đang gọi (app gửi token kèm header `X-Push-Token`) |
| Refresh token bị dùng lại (reuse → thu hồi hết)                   | Xoá mọi thiết bị                                                            |
| Khoá tài khoản                                                    | Dispatcher bỏ qua (`isActive: false`); mở khoá thì nhận lại                 |
| Xoá tài khoản (`deleteAccount`)                                   | Xoá mọi thiết bị + dòng outbox pending                                      |
| App đăng nhập tài khoản khác                                      | Upsert theo token chuyển máy sang người mới                                 |

### 4.6 Cấu hình và vận hành

- Env mới: `PUSH_ENABLED` (mặc định `false` — bật dần), `EXPO_ACCESS_TOKEN`,
  `PUSH_DISPATCH_EVERY` (1 phút), `PUSH_RECEIPTS_EVERY` (15 phút). Thêm vào cả ba file example.
- `PUSH_ENABLED=false` → `enqueue` là no-op; test tích hợp mock client Expo.
- Log: che token trong `redact.ts` (`ExponentPushToken[...]` → `[redacted]`). Log một dòng mỗi
  lô: số gửi, số lỗi theo loại.
- Giám sát: đếm `push_outbox` theo `status` trong `GET /metrics/system` (màn admin-system của app đã đọc endpoint này);
  cảnh báo Sentry khi `InvalidCredentials` hoặc tồn `pending` > 1000.
- Index mới → `npm run sync-indexes:prod -- --apply` khi deploy.

---

## 5. Thiết kế phía app (`docs/VueSer`)

### 5.1 Build và credential — việc làm trước tiên

1. `npx expo install expo-notifications expo-device expo-dev-client`.
2. Tạo project EAS (`eas init`) → `app.json` có `extra.eas.projectId` (bắt buộc cho
   `getExpoPushTokenAsync`).
3. Thêm config plugin `expo-notifications` vào `app.json` (icon thông báo đơn sắc cho Android,
   màu `#B98851`, `defaultChannel`).
4. **Android:** tạo project Firebase → `google-services.json` (khai `android.googleServicesFile`)
   → tạo service account key FCM V1 → tải lên EAS (`eas credentials`).
5. **iOS:** cần tài khoản Apple Developer (trả phí) → `eas credentials` tạo APNs key.
6. `eas.json` với profile `development` (dev client), `preview` (APK nội bộ), `production`.
7. Cập nhật `README.md`: bỏ hướng dẫn "chạy bằng Expo Go", thay bằng cài dev build. (README
   hiện còn ghi SDK 54 trong khi `package.json` là 57 — sửa luôn.)

### 5.2 Code

| File                                                         | Việc                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src/api/push.ts`                                            | Gọi SDK sinh từ OpenAPI: register, unregister, getPrefs, patchPrefs, test                                 |
| `src/queries/push.ts`                                        | `usePushPrefs`, `useUpdatePushPrefs`, `useRegisterPushDevice` (qua `qk`)                                  |
| `src/lib/push/` hoặc `src/queries/push-setup.ts`             | `setNotificationHandler`, tạo Android channel theo category, xin quyền, lấy token, `addPushTokenListener` |
| `app/_layout.tsx`                                            | `usePushRegistration()` sau `useChatSocket()` — chỉ khi đã đăng nhập; `usePushNavigation()`               |
| `app/settings.tsx` → thêm `src/components/PushPrefsCard.tsx` | Công tắc theo nhóm + "Gửi thử" + trạng thái quyền hệ thống (nút mở Cài đặt nếu đã từ chối)                |
| `src/queries/auth.ts` `useSignOut`                           | Gọi `DELETE /push/devices/:token` TRƯỚC `api.signOut()`                                                   |

Luật kiến trúc của VueSer giữ nguyên: mutation chỉ gọi từ `app/**`, query key qua `qk`, LOC cap
(`settings.tsx` đang 221/250 dòng → phần push phải nằm trong component riêng).

### 5.3 Hành vi

- **Xin quyền đúng lúc, không lúc mở app:** hỏi sau thao tác đầu tiên có lý do rõ ràng — đăng
  tin xong ("Bật thông báo để biết khi tin được duyệt?") hoặc gửi tin nhắn đầu tiên. Hiện một
  màn giải thích của app trước, rồi mới gọi hộp thoại hệ thống — iOS chỉ cho hỏi MỘT lần, bị từ
  chối là phải vào Cài đặt.
- **Android 13+:** quyền `POST_NOTIFICATIONS` chỉ hỏi được sau khi đã tạo ít nhất một channel —
  tạo channel trước khi xin quyền.
- **Đăng ký lại mỗi lần mở app** (upsert, cập nhật `lastSeenAt`) và khi token đổi
  (`addPushTokenListener`).
- **Chạm vào push:** `router.push(data.path)`; khởi động nguội dùng
  `useLastNotificationResponse` để không mất lượt chạm khi app đang tắt hẳn. Chỉ nhận `path`
  bắt đầu bằng `/` và thuộc danh sách route cho phép.
- **App đang mở:** `setNotificationHandler` hiện banner, **trừ** push chat của đúng hội thoại
  đang mở (đã có tin trên màn). Mọi push tới → `invalidate` query tương ứng (hộp thư, danh sách
  hội thoại) để badge trong app khớp.
- **Chưa đăng nhập / khách:** không đăng ký gì.

---

## 6. Quyết định đã chốt (2026-09-27)

1. **Android trước**, iOS khi có tài khoản Apple Developer. Code đã chạy được cho cả hai; iOS chỉ thiếu credential APNs.
2. **Bỏ Expo Go**, chuyển sang development build (`expo-dev-client`, `eas.json` profile `development`).
3. **"X vừa đăng tin mới" (`group_activity`) mặc định TẮT**, người dùng tự bật; thông báo quản trị soạn (`group_notice`) mặc định BẬT.
4. **Chat không hiện nội dung** trên màn hình khoá — chỉ tên người gửi.
5. **Master trả lời hỗ trợ có push**, chạm vào mở bảng tin (nơi nút hỗ trợ hiện chấm đỏ).

---

## 7. Lộ trình

| Giai đoạn           | Nội dung                                                                                                                    | Điều kiện xong                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **P0 — Nền**        | EAS project, Firebase, dev build Android chạy được, `eas.json`, README                                                      | Cài dev build lên máy thật, gửi push tay bằng curl tới token tới được |
| **P1 — BE lõi**     | Module `push`: model, API devices/preferences/test, outbox, dispatcher, receipts, dọn dẹp, vòng đời phiên §4.5, env, redact | Test tích hợp xanh; `POST /push/test` tới được máy thật               |
| **P2 — App lõi**    | Đăng ký token, xin quyền đúng lúc, chạm → điều hướng (cả khởi động nguội), gỡ khi đăng xuất                                 | Checklist §8.3 mục A–C đạt trên Android                               |
| **P3 — Sự kiện**    | Móc ~20 call site `notifyUser`, `group_notice`, chat (có gộp), support, `group_activity` (lọc lúc enqueue); màn tuỳ chọn    | Checklist §8.3 đủ; bật `PUSH_ENABLED` trên prod                       |
| **P4 — Hoàn thiện** | iOS (APNs), badge số trên icon (xấp xỉ: chưa đọc hộp thư + hội thoại chưa đọc), số liệu ở admin-system                      | iOS đạt checklist; badge khớp số trong app                            |

Mỗi giai đoạn là một (hoặc vài) commit riêng, gate như các đợt trước: `npm run lint`,
`typecheck`, `npm test`, `openapi:export` → VueSer `api:sync` + `typecheck` + `lint`.

---

## 8. Kiểm thử

### 8.1 Unit (BE)

- Builder nội dung: cắt độ dài, payload < 4096 byte với title/body dài nhất có thể, không lọt
  email/SĐT.
- Bảng category → channel/priority/ttl; `account` không tắt được.
- Gộp chat: 5 tin trong 30 giây → 1 dòng outbox, body "5 tin nhắn mới".
- Lịch lùi dần retry.

### 8.2 Tích hợp (BE, mock `expo-server-sdk`)

- Đăng ký: token sai định dạng → 400; cùng token hai người → thuộc người đăng ký sau; trần 10
  thiết bị.
- Mỗi sự kiện ở bảng §1 → đúng một dòng outbox, đúng người, đúng category/path.
- Tuỳ chọn tắt → `skipped`; tắt sau khi đã enqueue vẫn không gửi (lọc lúc gửi).
- Người bị khoá không nhận; mở khoá nhận lại.
- Đăng xuất / reuse refresh token / xoá tài khoản → thiết bị bị gỡ.
- Ticket `DeviceNotRegistered` và receipt `DeviceNotRegistered` → `disabledAt`.
- Expo trả 5xx → retry rồi thành công; `InvalidCredentials` → giữ pending.
- Hai dispatcher chạy song song → mỗi dòng gửi đúng một lần (CAS).
- `PUSH_ENABLED=false` → không ghi gì.
- `group_activity` chỉ enqueue cho người đã bật, trừ người đăng.
- Không tự báo cho chính mình (chat gửi đi, tin mình đăng).

### 8.3 Thủ công trên máy thật (mỗi nền tảng)

- **A. Nhận:** app mở (banner hiện, trừ chat đang xem) · chạy nền · tắt hẳn.
- **B. Chạm:** mở đúng màn ở cả ba trạng thái trên; path lạ bị bỏ qua.
- **C. Quyền:** từ chối → app không hỏi lại, màn cài đặt chỉ đường mở Cài đặt hệ thống; cấp lại
  → nhận được.
- **D. Tài khoản:** A đăng xuất, B đăng nhập cùng máy → chỉ B nhận; đăng xuất → không nhận gì.
- **E. Gộp & tắt:** gửi dồn 10 tin chat → 1–2 push; tắt nhóm chat → không nhận chat, vẫn nhận
  trạng thái tin.
- **F. Gỡ app** → lần gửi sau thiết bị bị tắt sau khi đọc receipt.

---

## 9. Rủi ro

| Rủi ro                                                                | Giảm thiểu                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Push nhầm người khi đổi tài khoản trên cùng máy                       | Upsert theo token + gỡ khi đăng xuất + test D                        |
| Spam làm người dùng tắt quyền vĩnh viễn (không lấy lại được trên iOS) | `group_activity` mặc định tắt, gộp chat, xin quyền đúng lúc          |
| Lộ nội dung trên màn hình khoá                                        | Chat không kèm nội dung; body chỉ tiêu đề tin                        |
| Push giả mạo bằng token bị lộ                                         | Enhanced push security + `EXPO_ACCESS_TOKEN`; token bị che trong log |
| Expo/FCM sập làm chậm nghiệp vụ                                       | Outbox bất đồng bộ, request không bao giờ chờ                        |
| Sai credential sau khi đổi khoá                                       | Sentry cảnh báo `InvalidCredentials`, giữ pending để gửi bù          |
| Fan-out lớn (nhóm 500+) chiếm DB                                      | `insertMany` theo lô, lọc tuỳ chọn trước khi ghi, TTL 7 ngày         |
| Team quen Expo Go                                                     | README mới + build `development` dùng chung qua EAS                  |

---

## 10. Việc cập nhật tài liệu khi làm

- Audit 2026-09-26 mục 4.6: đổi "Push notification: chưa" → trỏ về file này, rồi ✅ sau P3.
- `docs/rules/logging-monitoring.md`: thêm số liệu push, cảnh báo `InvalidCredentials`.
- README market: env mới; README VueSer: cách cài dev build.

---

## 11. Trạng thái triển khai (2026-09-27)

**Đã code + test** (market: 121 file / 1260 test xanh, trong đó `pushPolicy` 12, `push-devices` 16,
`push-dispatch` 15; VueSer: typecheck + lint sạch):

- BE: module `features/push` (model `push_devices` + `push_outbox`, dispatcher có CAS claim, retry
  1/5/15 phút, đọc receipt, dọn thiết bị), API §4.2, móc 22 điểm `notifyUser` + `group_notice` +
  `group_activity` + chat (gộp 30 giây) + hỗ trợ, vòng đời phiên §4.5, job Agenda, env.
- App: `api/push.ts`, `queries/push.ts`, `stores/push.ts`, `PushPrefsCard`, đăng ký mỗi lần mở app,
  chạm → điều hướng (kể cả khởi động nguội), hỏi quyền sau khi đăng tin / nhắn tin, gỡ máy khi đăng
  xuất, không hiện banner cho hội thoại đang mở, `app.config.ts` + `eas.json`.

**Việc chủ dự án phải tự làm (cần tài khoản, không làm thay được):**

1. `npm i -g eas-cli` → `eas login` → trong `docs/VueSer`: `eas init` (ghi `extra.eas.projectId` vào `app.json`).
2. Firebase Console → tạo project → thêm app Android package `com.ghim.app` → tải `google-services.json`
   đặt ở gốc `docs/VueSer` (đã gitignore) → `eas env:create --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json`.
3. Firebase → Project settings → Service accounts → tạo khoá JSON → `eas credentials` → Android →
   *Push Notifications: FCM V1 service account key* → tải khoá lên.
4. (Khuyến nghị) EAS → project → Credentials → bật *Enhanced push security* → tạo access token → đặt
   `EXPO_ACCESS_TOKEN` cho BE.
5. `eas build --profile development --platform android` → cài APK lên máy thật.
6. BE: `PUSH_ENABLED=true` → prod: `npm run sync-indexes:prod -- --apply`.
7. Chạy checklist §8.3 trên máy thật.

**Chưa làm (P4):** iOS (APNs), badge số trên icon, số liệu outbox ở `GET /metrics/system`, icon
thông báo đơn sắc cho Android (hiện dùng icon app; Android có thể vẽ thành ô trắng).
