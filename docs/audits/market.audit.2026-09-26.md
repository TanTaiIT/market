# Audit nợ kỹ thuật + business rules — 2026-09-26

Phạm vi: toàn bộ `src/**`, `scripts/**`, `tests/**`, infra, docs. Baseline lúc audit: `npm run lint:check` 0 lỗi,
`npm run typecheck` 0 lỗi, `npm test` 80 file / 973 test pass.

Cột **Trạng thái**: `✅` đã sửa trong đợt này · `⏳` chưa sửa · `🤔` cần quyết định sản phẩm/kiến trúc trước khi sửa.

---

## 0. Phải xử lý ngay

| # | Sev | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|---|
| 0.1 | HIGH (hạ từ BLOCKER) | `.env.production.example` chứa **placeholder** `set_via_secret_manager` cho cả hai JWT secret — KHÔNG phải secret thật (bản `.env.production` local cũng chỉ là placeholder, nên hash trùng). Rủi ro thật: nơi deploy không override thì prod ký token bằng chuỗi công khai, và hai secret bằng nhau → refresh token dùng được như access token (`verify*` chỉ khác secret) | `.env.production.example:14-15`, `src/common/utils/jwt.ts:43-49` | ✅ `assertRuntimeSecrets()` chặn boot prod khi placeholder / <32 ký tự / trùng nhau; JWT thêm claim `typ` + `verify*` phân biệt theo `ver` (tương thích token cũ). **Kiểm tra secret thật trên Render: cần người.** |
| 0.2 | HIGH | Không `app.set('trust proxy')` → sau LB `req.ip` = IP proxy → mọi user chung một bucket rate limit (login 10/phút toàn hệ thống) | `src/app.ts`, `rateLimiter.middleware.ts:30` | ✅ env `TRUST_PROXY` (mặc định 0, prod example = 1) |
| 0.3 | HIGH | IDOR `PATCH /notifications/:id/read`: `findById` không kiểm audience, trả `title/body` (số dư ví, lý do khoá) | `notification.service.ts:293-318`, `notification.repository.ts:145-151` | ✅ + case trong `idor-sweep` |
| 0.4 | HIGH | `requireCategoryModerator`/`requireMasterPublicAxis` spread `currentScope()` → giữ `readableOrgIds` → public-queue lộ tin pending/hidden/rejected nội bộ của org mà manager là thành viên | `moderation.middleware.ts:22-25,71,114-117`, `listing.repository.ts:532-544` | ✅ `narrowToPublicAxis` + test |
| 0.5 | HIGH | `renew`/`markSold` trả Query chưa `.exec()` ra khỏi `runUnscoped` → hook chạy dưới scope request → ghi 0 doc, API 200 `data: null` | `listing.service.ts:910-915, 936-938` | ✅ + test multi-org |
| 0.6 | HIGH | Thành viên bị gỡ không rejoin được: unique `{userId, organizationId}` không partial, 4 caller `create` → E11000 → 500 | `membership.model.ts:74`, `join-request.service.ts:41,231`, `invite.service.ts:188`, `organization.service.ts:166` | ✅ `membershipRepository.activate` (upsert) + test |
| 0.7 | HIGH | Khoá/xoá tài khoản không hiệu lực ngay: `authenticate` không kiểm `isActive`; lock/delete không bump `tokenVersion`; socket không kiểm | `auth.middleware.ts:24-39`, `user.service.ts:158,329`, `sockets/index.ts:24-60` | ✅ `resolveTenant` chặn mọi lượt GHI của tài khoản khoá/xoá (`isUsable`, chạy song song với lượt tra membership sẵn có); GET cố ý để mở tới hết hạn access token vì lý do khoá nằm trong hộp thư (`user-admin.test` chốt). Lock/delete bump `tokenVersion` + ngắt socket; handshake socket kiểm `isUsable` |
| 0.8 | HIGH | Shutdown: `closeHttp` trước `closeSockets` → WS mở làm `server.close` treo → force exit bỏ `stopAgenda`/`disconnectDB`/`flushSentry` | `src/server.ts:47-51` | ✅ (không có test tự động — cần thử `SIGTERM` với client WS mở) |
| 0.9 | HIGH | `moderation.{byUserId,byName,at,reason}` lộ trên DTO công khai; `hideAllFromSeller` ghi tên thật master | `listing.model.ts:346-364`, `listing.service.ts:1064-1068,1257-1270` | ✅ `toJSON` bỏ `moderation`; bàn duyệt ghép lại qua `toModerationListing` (5 endpoint `/moderation/*`); `hideAllFromSeller` dùng `MASTER_DISPLAY_NAME` |
| 0.10 | HIGH | Migration ghi driver thô (`db.collection().updateMany`) bypass `tenantPlugin` + sổ `runUnscoped`; alias `:prod` không guard/dry-run | `scripts/migrate-listing-reach.ts`, `migrate-ward-axis.ts`, `kyc-grandfather.ts` | ✅ `scripts/confirmWrite.ts`: `--dry-run` + `CONFIRM_DB=<db>` bắt buộc ở prod; lượt ghi `listings` bọc `runUnscoped` |
| 0.11 | MEDIUM | Agenda không `on('fail')` → job hỏng im lặng | `src/config/agenda.ts` | ✅ `on('fail'/'error')` → logger + `reportJobError` (Sentry) |
| 0.12 | HIGH | `GET /listings/quota` không `validate({query})` (= 5.2) | `listing.routes.ts:67` | ✅ `quotaQuerySchema`, `openapi.json` đã export lại |
| 0.13 | **HIGH** | **Mọi job Agenda chết im từ lâu.** `@agendajs/mongo-backend@4.0.3` kéo `mongodb@7`/`bson@7` lồng riêng, mongoose 8.24 dùng `mongodb@6`/`bson@6`; `startAgenda` đưa `mongoose.connection.db` cho backend → `BSONVersionError` ở mọi lượt quét 30 giây → `listing-expiry`, `machine-review`, `unverified-cleanup`, `image-cleanup` **chưa từng chạy** qua scheduler. Không ai thấy vì không có listener `error` (0.11). Phát hiện ngay khi 0.11 lên dev (user báo 2026-09-26). Tái hiện bằng script trên mongodb-memory-server: cách cũ `runs=0`, cách mới `runs=6` | `src/config/agenda.ts:36-49` | ✅ backend mở kết nối riêng (`address: env.MONGO_URI`), `stopAgenda` đóng bằng `stop(true)`; test truyền URI server ảo. **Sau deploy, lượt boot đầu sẽ xử dồn mọi job quá hạn**: hạ tất cả tin đã quá `expiresAt`, chấm hết tin `pending` chưa có `machineReview`, xoá cứng tài khoản chưa xác thực >7 ngày không có tài sản. Cách thay thế một pool = khai `mongodb@~6.20.0` ở gốc `package.json` (cần cài package, chưa làm) |

---

## 1. Business rules — Listing / Moderation

| # | Sev | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|---|
| 1.1 | HIGH | Sửa tin ACTIVE không chạy lại lớp flag máy (giá cao/outlier/gibberish); chỉ cụm cấm được kiểm | `listing.service.ts:1144-1168`, `listing.repository.ts:355-362` | ✅ `update()` gọi `fastPathFlagged` (bản đã ghép, `excludeId` = chính tin) khi fast-path uy tín mở; có hold → PENDING + `content_flagged` + `holds`. Test `owner-edit-review` |
| 1.2 | HIGH | `expired` → PATCH nội dung → `renew` → ACTIVE, không qua lớp duyệt nào | `listing.service.ts:904-917, 1144` | ✅ khối duyệt lại áp cho cả `expired`; tin về PENDING thì `renew` tự chặn (400). Người đủ bậc sửa sạch vẫn gia hạn được, như xoá đi đăng lại |
| 1.3 | HIGH | Không trần tin ACTIVE/người; trust mặc định = ngưỡng tự đăng; máy duyệt không nhìn `trustLevel`; dedupe chỉ trùng tiêu đề chính xác | `trust.policy.ts:96-99`, `listing.quota.ts:44,111-148`, `moderation.machine.service.ts:216-242` | 🤔 |
| 1.4 | MEDIUM | `setModerationStatus` không state machine: `sold→active`, re-approve ACTIVE cộng `cleanApprovals` mỗi lần, race 2 moderator | `listing.service.ts:1222-1272`, `moderation.service.ts:327-375` | ⏳ |
| 1.5 | MEDIUM | Duyệt không đặt lại `expiresAt` → tin chờ >30 ngày vừa duyệt đã bị sweep | `listing.service.ts:1257-1270`, `moderation.machine.service.ts:100-104` | ✅ mọi lượt → ACTIVE qua `setModerationStatus` (kể cả mở lại tin ẩn) và máy duyệt đặt `expiresAt = listingExpiresAt()` |
| 1.6 | MEDIUM | `rerouteListing`: ghi có scope → 500 với tin marketplace mang org; `status: PENDING` vô điều kiện; giữ `wardCode` cũ khi đổi tỉnh; đổi category không re-validate attrs | `listing.service.ts:1278-1289`, `moderation.service.ts:472-505` | ⏳ |
| 1.7 | MEDIUM | Xoá/ẩn tin không đóng report OPEN → report kẹt vĩnh viễn, `openReports` lệch | `listing.service.ts:1177-1182,1292-1302`, `report.service.ts:114-120` | ⏳ |
| 1.8 | MEDIUM | `GET /favorites` `findByIds` có scope không kẹp `status` → thấy tin hidden/rejected của org | `listing.service.ts:1039-1044`, `listing.repository.ts:216-218` | ⏳ |
| 1.9 | MEDIUM | Không có đường mở lại tin sau khi tài khoản được mở khoá (docblock hứa) | `listing.service.ts:1054-1058` | ⏳ |
| 1.10 | MEDIUM | `removeListing` trừ uy tín vô điều kiện, không cần lý do | `moderation.service.ts:535` | ✅ (cùng 2.1) — `reason` vẫn tuỳ chọn để không vỡ client VueSer; bắt buộc thì phải sửa client trước |
| 1.11 | MEDIUM | Ghim template theo số `version` không theo `templateRef.id` → fallback và template riêng trùng số | `listing.service.ts:1104-1112`, `category-template.service.ts:621-627` | ⏳ |
| 1.12 | MEDIUM | Tự duyệt tin của chính mình hợp lệ (chỉ không cộng uy tín) | `moderation.service.ts:123-132` | 🤔 |
| 1.13 | MEDIUM | Audit trail: `moderation` chỉ giữ quyết định cuối; trục công khai không persist; máy không audit | `moderation.service.ts:82-89`, `moderation.machine.service.ts:245-275` | ⏳ (đã ghi ở v2 plan) |
| 1.14 | MEDIUM | Suspend org không cascade tin; rời org không hạ tin `members` | `organization.service.ts:424-426`, `tenantPlugin.ts:112-115` | 🤔 |
| 1.15 | LOW | `q` không `.max()`; `price` không `.int()`/trần; `minPrice > maxPrice` không chặn | `listing.schema.ts:54,278,317` | ⏳ |
| 1.16 | LOW | Ảnh chỉ chốt host Cloudinary, không chốt cloud name | `common/utils/imageUrl.ts` | ⏳ |
| 1.17 | LOW | Cụm cấm `includes` thô, không fold dấu, không quét `attributes`/`address` | `moderation.machine.ts:101-104` | ⏳ |
| 1.18 | LOW | Không idempotency khi tạo tin; race PATCH vs approve last-writer-wins | `listing.service.ts:218,631,1172` | ⏳ |
| 1.19 | LOW | Sửa `location` không đồng bộ `provinceCode/wardCode`; `location: {}` ghi được | `listing.service.ts:1092` | ⏳ |
| 1.20 | LOW | Danh mục tắt: tin vẫn trên bảng; `viewCount` không dedupe; hết hạn không notify; `rejected(quality)` không có đường resubmit; `/listings/mine` bỏ qua filter im lặng | nhiều | ⏳ |

## 2. Business rules — Uy tín / Report / Support / Social

| # | Sev | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|---|
| 2.1 | HIGH | Hai đường TAKEDOWN (`report.resolve`, `removeListing`) gọi thẳng `trustRepository.record(false)`, bỏ `applyTrustEffect` → org moderator hạ bậc người ngoài trên trục công khai. Comment tại chỗ nói là chủ ý cho report đã xác minh → mâu thuẫn `ACTION_BY_DECISION` | `report.service.ts:205-217`, `moderation.service.ts:535`, `constants/index.ts:365-367` | ✅ Chốt hướng A (user xác nhận 2026-09-26): giữ "gỡ đã xác minh = phạt" nhưng qua `applyTakedownPenalty`: chỉ khi trạng thái trước ∈ `PUBLIC_LISTING_STATUSES`, người gỡ có `canApproveListing` trên trục của tin, không tự xử. DELETE nhận `reason` tuỳ chọn (client chưa gửi) → vào thông báo + audit. Test `takedown-trust` |
| 2.2 | MEDIUM | Race 2 moderator cùng đóng 1 report → trừ uy tín 2 lần | `report.service.ts:182-217` | ⏳ |
| 2.3 | MEDIUM | Xử lý report không notify seller/reporter | `report.service.ts:195-204` | ✅ seller (`notifyPoster` HIDDEN kèm "Bị báo cáo: <kind>", phát hiện qua test E6) · ⏳ reporter |
| 2.9 | **HIGH** | Từ chối mức `quality` (mặc định) VẪN trừ bậc uy tín: `applyTrustEffect` gọi `record(seller, false)` không nhìn `severity`; `severity` chỉ loại `quality` khỏi cửa sổ phạt 7 ngày. Trái thẳng tài liệu `REJECTION_SEVERITIES` ("`quality`: KHÔNG đụng uy tín"). Test `trust-fairness` "từ chối vì SAI SÓT: không trừ bậc" pass rỗng vì đo ở bậc 0. Phát hiện qua case C6 của ma trận 2.1 | `moderation.service.ts` `applyTrustEffect`, `constants/index.ts:389-399` | ✅ (user chốt 2026-09-26) `applyTrustEffect` nhận `severity`; từ chối không phải `violation` không ghi gì. Test `trust-fairness` thêm ca đo ở bậc 1; test log của `moderation.test` chuyển sang `violation` tường minh |
| 2.10 | — | **Phục hồi uy tín** (không có trong audit gốc, user yêu cầu 2026-09-26): `POST /users/:id/restore-trust` (master, `reason` bắt buộc) trả bậc về trần, thông báo cho người được phục hồi; KHÔNG đụng cửa sổ phạt 7 ngày (việc của `clear-rejections`) | `user.service.ts restoreTrust`, `trust.repository.ts restore` | ✅ test `trust-restore` (6 ca) |
| 2.4 | MEDIUM | `reporterName` lộ cho seller có grant trong org | `report.service.ts:41`, `report.middleware.ts:42` | ⏳ |
| 2.5 | LOW | Tự báo cáo tin của mình được; report-bombing chỉ `apiLimiter`; report về NGƯỜI đóng dấu org người tố | `report.service.ts:74-94,130` | ⏳ |
| 2.6 | LOW | Support: user thấy `byUserId` thật của master; `messages` không trần; `reply` không kiểm `isActive` | `support.schema.ts:34-50`, `support.service.ts:66,166` | ⏳ |
| 2.7 | LOW | Social-feedback `review` không state guard/audit | `social-feedback.repository.ts:25-31` | ⏳ |
| 2.8 | MEDIUM | Báo cáo về tin SÀN mang badge nhóm (`reach: marketplace`, `organizationId` ≠ null) bị `report.service.targetOf` đóng dấu lên trục ORG (`isPublic = !listing.organizationId`), trái với luật hàng đợi duyệt theo `reach`. Hệ quả: người phụ trách ô không bao giờ thấy báo cáo đó; chỉ quản trị nhóm (cửa gỡ, không ghi án sau 2.1) và master xử được → tin sàn của thành viên nhóm gần như miễn án hậu kiểm. Phát hiện khi viết test 2.1 | `report.service.ts:72-80` | ✅ (user chốt 2026-09-26) `isPublic = reach === marketplace`; báo cáo tin sàn mang badge lên trục công khai, người phụ trách ô thấy và phạt được, nhóm cầm id vẫn gỡ được không ghi án. Không migration: báo cáo cũ giữ trục org. Test `takedown-trust-matrix` G8a/G8b |

## 3. Business rules — Auth / Org / Membership / KYC

| # | Sev | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|---|
| 3.1 | HIGH | `kyc:grandfather` cấp `approved` giả (`idNumber` 000…) → `submit` 409 → user cũ không nộp hồ sơ thật | `scripts/kyc-grandfather.ts:47-62`, `kyc.service.ts:38-41` | ⏳ |
| 3.2 | MEDIUM | `membershipService.remove` không thu hồi grant org/org_unit → người bị gỡ vẫn duyệt | `membership.service.ts:91-103`, `tenant.middleware.ts:153-156` | ⏳ |
| 3.3 | MEDIUM | `grantAdmin` không gọi `canGrant` (master tự cấp); `POST /role-grants` scope org không tạo membership; revoke không hạ `membership.role` | `organization.service.ts:150-209`, `role-grant.service.ts:225-265` | ⏳ |
| 3.4 | MEDIUM | `deleteAccount` không cascade: tin (SĐT snapshot), `KycProfile`, invite, join-request; không bump tokenVersion | `user.service.ts:289-332` | ⏳ cascade (bump tokenVersion + ngắt socket: ✅ ở 0.7) |
| 3.5 | MEDIUM | `googleId` unique không partial `deletedAt` → Google account đã xoá login lại = 500 | `user.model.ts:95` | ⏳ |
| 3.6 | MEDIUM | Join/invite không cần verified email; nhóm công khai vào tức thì | `join-request.routes.ts:31-37`, `invite.routes.ts:34-39` | 🤔 |
| 3.7 | MEDIUM | Refresh token không rotate/không phát hiện reuse | `auth.service.ts:131-153` | ⏳ (đã ghi ở multi-tenant.implementation §7.1) |
| 3.8 | MEDIUM | Không có đổi mật khẩu khi đang đăng nhập; forgot nuốt lỗi khi mail tắt | `user.routes.ts`, `password-reset.service.ts:40-55` | ⏳ |
| 3.9 | MEDIUM | Master 1 tài khoản, không 2FA, reset qua cửa công khai | `migrate-master.ts:13-17`, `auth.routes.ts:75-92` | 🤔 |
| 3.10 | MEDIUM | Tên Google không qua `impersonatesMaster` | `auth.service.ts:107-113` | ⏳ |
| 3.11 | MEDIUM | KYC PII plaintext, không audit đọc, không limiter submit, master duyệt hồ sơ chính mình | `kyc.model.ts:67`, `kyc.service.ts:91-126`, `kyc.routes.ts:64` | ⏳ |
| 3.12 | LOW | Password min 6; timing oracle ở reset; race register → 500 thay vì 409 | `auth.schema.ts:18`, `password-reset.service.ts:66-72`, `auth.service.ts:29-31` | ⏳ |
| 3.13 | LOW | Không endpoint "rời nhóm" dù code trỏ tới | `membership.service.ts:69`, `membership.routes.ts:97` | ⏳ |
| 3.14 | LOW | Socket không phản ánh thu hồi quyền/thành viên | `sockets/index.ts:46-79` | ⏳ (lock → disconnect: ✅ ở 0.7) |
| 3.15 | LOW | `cancel` join-request lộ status trước khi kiểm chủ; cấp admin cho tài khoản inactive không chặn; `migrate-master` nói index role_grants không partial nhưng model có | `join-request.service.ts:178-181`, `organization.service.ts:154`, `migrate-master.ts:90-96` | ⏳ |

## 4. Business rules — Wallet / Chat / Notification / Upload / Jobs

| # | Sev | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|---|
| 4.1 | MEDIUM | Idempotency key ví không scope theo user → trùng uuid trả tx người khác | `wallet.service.ts:45-46,138-143` | ⏳ |
| 4.2 | MEDIUM | Không job đối soát sổ cái; unique index prod phụ thuộc `sync-indexes:prod` tay; replica set không assert lúc boot | `wallet.repository.ts:54-60`, `database.ts:80` | ⏳ |
| 4.3 | LOW | Ledger append-only chỉ bằng kỷ luật; DTO raw doc; `amount` không trần | `wallet.model.ts:95-119`, `wallet.controller.ts:19,29`, `wallet.schema.ts:17` | ⏳ |
| 4.4 | MEDIUM | Chat không block/mute; hội thoại ẩn tự sống lại | `chat.repository.ts:77-90` | 🤔 |
| 4.5 | LOW | Chat không cổng cụm cấm; double-tap → 500; mở chat với SOLD; text raw | `chat.service.ts:65-66,89,168-179` | ⏳ |
| 4.6 | LOW | Notification: unit ping cả org qua socket; không retention; không push; `POST` không limiter | `notification.service.ts:130`, `notification.model.ts` | ⏳ |
| 4.7 | MEDIUM | Avatar user không ràng Cloudinary → tracking pixel qua snapshot | `user.schema.ts:60` | ⏳ |
| 4.8 | LOW | Chữ ký upload không ràng user/public_id; ảnh tin xoá mềm bị dọn sau 2 ngày | `upload.service.ts:79-82`, `listing.repository.ts:743-748` | ⏳ |
| 4.9 | LOW | Hết hạn không notify; thiếu job reconcile ví / retention notification | `listing.expiry.service.ts:43-51` | ⏳ |

## 5. Nợ kỹ thuật cơ khí (rule compliance)

| # | Sev | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|---|
| 5.1 | HIGH | `runUnscoped` 46 site, 34 trong listing, hầu hết trên request path — convention §6.4 nói ngược | `listing.service.ts`, `listing.repository.ts`, `report.repository.ts` | 🤔 kiến trúc |
| 5.2 | HIGH | `GET /listings/quota` không `validate({query})` — route duy nhất/138 | `listing.routes.ts:67`, `listing.controller.ts:45` | ✅ (0.12) |
| 5.3 | HIGH | Module `kyc` lệch template: không controller/repository/types, enum trong model, `'pending'/'approved'` hardcode, pagination riêng `.max(100)` | `kyc.routes.ts:17-53`, `kyc.service.ts:38-147`, `kyc.schema.ts:69` | ⏳ |
| 5.4 | MEDIUM | `.oxlintrc.json` tắt `no-console` + `no-explicit-any` → rule 8/9 không gate | `.oxlintrc.json:10,13` | ⏳ |
| 5.5 | MEDIUM | `validate()` không generic → 23 `as never` + 4 `as unknown as` ở controller | `validate.middleware.ts:14-31` | ⏳ |
| 5.6 | MEDIUM | `Organization` có `deletedAt` nhưng không hook soft-delete; `allImageUrls` sót filter | `organization.model.ts:122`, `organization.repository.ts:180` | ⏳ |
| 5.7 | MEDIUM | Controller làm việc của service: `membership.controller:11-18`, `listing.controller:14-26`, `role-grant.controller:34`, `notification.controller:19-32` | — | ⏳ |
| 5.8 | MEDIUM | `pre('validate')` ném `Error` thường + nhận diện `constructor === Error` | `kyc.model.ts:91,94`, `role-grant.model.ts:136,138` | ⏳ |
| 5.9 | MEDIUM | `role-grant.repository.listActiveByUser` không `.lean()` trên hot path mọi request; `user.repository:116,137` `runUnscoped` thừa (User không có plugin) | — | ⏳ |
| 5.10 | MEDIUM | Duplicate: `excludeDeleted` ×6, regex ObjectId ×21, `'quality'/'violation'` ×7 (không có `REJECTION_SEVERITY` object), `targetType: 'listing'` ×3 | — | ⏳ |
| 5.11 | MEDIUM | `listing.repository.ts:61` filter `organizationId` viết tay (rule 12b) | — | 🤔 (cùng 5.1) |
| 5.12 | LOW | Dead exports (~9), `org-unit` zombie, ~40 export chỉ dùng nội bộ, `support.schema/kyc.schema` `.max(100)` trái `PAGINATION.MAX_LIMIT` | — | ⏳ |
| 5.13 | LOW | God file: `listing.service.ts` 1392, `listing.repository.ts` 749, `moderation.service.ts` 550 | — | ⏳ |

## 6. Docs drift

| # | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|
| 6.1 | README bảng module stale (category/chat/upload ghi 501); nhắc "text index" đã bỏ | `README.md:180-199, 227` | ⏳ |
| 6.2 | `AGENT.md:11` "upload 501"; `:58` `POST_VISIBILITY` không còn tồn tại | — | ⏳ |
| 6.3 | `openapi.ts:67-71` NOT_IMPLEMENTED liệt kê `/uploads` | — | ⏳ |
| 6.4 | `multi-tenant.convention.md:29-39` thiếu Conversation/Message/SupportThread/SocialFeedback/KycProfile/EmailVerification; §1.2 vs §1.3 mâu thuẫn về Notification | — | ⏳ |
| 6.5 | `logging-monitoring.md:54-56` nói request-id chưa có | — | ⏳ |
| 6.6 | Comment stale: `search.routes.ts:7` (text index), `category.controller.ts:18-23` (/platform-admin), `chat.service.ts:42` (index shape), `auth.controller.ts:12` message 'Organization created' | — | ⏳ |

## 7. Tests / Infra / Ops

| # | Sev | Vấn đề | Evidence | Trạng thái |
|---|---|---|---|---|
| 7.1 | HIGH | `npm audit --omit=dev`: 3 moderate (`qs` qua express 4.22.2); CI không audit | `package.json` | ⏳ (`npm audit fix`) |
| 7.2 | MEDIUM | 17 migration ad-hoc không ledger `_migrations`; drop index không backup | `package.json:36-56`, `scripts/migrate-v2.ts`, `migrate-drop-org-slug.ts` | ⏳ |
| 7.3 | MEDIUM | Helmet CSP mặc định làm `/docs` Scalar trắng | `src/app.ts:49,113` | ⏳ |
| 7.4 | MEDIUM | 15 file routes không limiter (gồm `/wallet`, `/kyc`) | — | ⏳ |
| 7.5 | MEDIUM | Docker: root, không HEALTHCHECK, không `.dockerignore`; Node 20/22/24 lệch, không `.nvmrc` | `Dockerfile`, `.github/workflows/ci.yml` | ⏳ |
| 7.6 | MEDIUM | CI thiếu `permissions`, `concurrency`, `timeout-minutes`, cache mongo binaries, gate OpenAPI drift | `.github/workflows/ci.yml` | ⏳ |
| 7.7 | MEDIUM | Env drift: `MASTER_SETUP_TOKEN`, `AWS_S3_BUCKET`, `AWS_REGION` chết; `UNVERIFIED_*` không có example | `src/config/env.ts`, `.env*.example` | ⏳ |
| 7.8 | MEDIUM | Logger không redaction (rule §2); log raw `email`; access log ghi `?code=` | `logger.ts`, `password-reset.service.ts:43,53`, `app.ts:72` | ⏳ |
| 7.9 | MEDIUM | Test: 65 lần boot replset (301s); state phụ thuộc thứ tự; limiter bypass ở test; không test 3 ngoại lệ index; không coverage | `tests/helpers/fixtures.ts:30-51`, `vitest.config.ts` | ⏳ |
| 7.10 | LOW | Socket event/job không có request context; không `LOG_LEVEL`; `compression` áp cả `/auth` | — | ⏳ |
| 7.11 | LOW | Single-instance: `RateLimiterMemory`, socket adapter in-memory, org cache 30s, banned-phrase cache 60s — đã ghi chú | — | 🤔 |

## 8. Backlog dự án tự khai (docs/architecture) — vẫn mở

Atlas Search cho `?q=` · Refresh token rotate/revoke · AuditLog dual-axis · Màn 2 tab người ngoài · Gỡ khoá quyền đăng sớm ·
Invite/roster/SSO · Theo dõi danh mục · Cụm cấm theo danh mục · Cây danh mục · Chuyển ô tin cho người phụ trách ·
Chain suspend cascade · `autoApproveTrusted` chưa định nghĩa được.

## 9. Đã kiểm và đúng (không phải nợ)

Tenant plugin fail-closed + `.and([$or])` + ép `organizationId`; policy là SoT hai trục, `canGrant` không tự cấp/không cấp master;
JWT chỉ `sub`, org từ `X-Org-Id` đối chiếu membership mỗi request; `PUBLIC_LISTING_STATUSES` ép ở `buildFilter`/`nearby`/`getForViewer`;
`PublicProfileDto` whitelist; join-request TTL 21d + cooldown 7d + trần 3; invite sha256 + TTL 14d + single-use;
wallet transaction + `$inc` guard + idempotency 11000 + test race; `assertDisposableDb` chặn cứng `market-pro`; `/health` ping Mongo thật;
request-id + AsyncLocalStorage log context; OpenAPI 138 op đồng bộ source; `.env*` không-example không bị track.
