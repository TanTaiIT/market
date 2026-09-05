/* eslint-disable no-console */
import mongoose, { PipelineStage, Types } from 'mongoose'
import { env } from '../src/config/env'
// Side-effect: bơm `DNS_SERVERS` cho c-ares trước lượt tra SRV đầu — xem `applyDnsOverride`.
import '../src/config/database'

import { Category } from '../src/features/category/category.model'
import { Conversation } from '../src/features/chat/chat.model'
import { Favorite } from '../src/features/favorite/favorite.model'
import { JoinRequest } from '../src/features/join-request/join-request.model'
import { Listing } from '../src/features/listing/listing.model'
import { Membership } from '../src/features/membership/membership.model'
import { Notification } from '../src/features/notification/notification.model'
import { Organization } from '../src/features/organization/organization.model'
import { Report } from '../src/features/report/report.model'

import { buildFilter } from '../src/features/listing/listing.repository'
import {
  TenantScope,
  publicOnlyScope,
  runUnscoped,
  runWithTenant,
} from '../src/common/tenant/tenantContext'
import { normalizeOrgSlug } from '../src/common/utils/orgSlug'
import {
  JOIN_REQUEST_STATUS,
  LISTING_STATUS,
  MEMBERSHIP_STATUS,
  MODERATABLE_STATUSES,
  POST_VISIBILITY,
  REPORT_STATUS,
  VnProvinceName,
} from '../src/common/constants'

/**
 * Đo index bằng `explain('executionStats')` trên ĐÚNG các query shape mà app phát ra.
 *
 * Vì sao không đọc `.index(...)` rồi suy luận: filter thật KHÔNG nằm trong repository.
 * `tenantPlugin` chèn thêm `$or` hai trục ở pre-hook, hook soft-delete chèn `deletedAt: null`,
 * và `runUnscoped` thì GỠ luôn khoá `organizationId` mà mọi index compound đang lấy làm prefix.
 * Ba tầng đó cộng lại ra một filter không ai đoán đúng bằng mắt — nên script chạy qua chính
 * model + chính `buildFilter`, không chép lại filter bằng tay.
 *
 * CHỈ ĐỌC: mọi case đều là `find`/`countDocuments`/`aggregate`. Case `updateMany` duy nhất của
 * app (`joinRequest.expireStale`) được đo bằng `find` cùng filter — planner chọn index theo vế
 * điều kiện nên kết quả giống hệt, mà không có đường nào ghi nhầm.
 *
 * Chạy: `npm run explain:indexes` · thêm `--json` để lấy bản máy đọc được (diff trước/sau khi vá).
 */

// ── ĐỌC EXPLAIN ─────────────────────────────────────────────────────────────

/** Ngưỡng "quét thừa": số doc chạm vào trên mỗi doc trả về. */
const WASTE_RATIO = 10

/**
 * Dưới ngưỡng này planner chọn COLLSCAN vì nó RẺ THẬT, không phải vì thiếu index — kết quả
 * đo trên collection gần rỗng là vô nghĩa, và tệ hơn là gây hiểu nhầm theo chiều ngược lại.
 */
const MEANINGFUL_DOCS = 1000

/**
 * Số doc mà plan thật sự chạm tới, dưới mức này thì sai cấu trúc vẫn chưa tốn gì.
 *
 * Đo theo KHỐI LƯỢNG của chính query chứ không theo cỡ collection: `attrs` lọc trên 1000 tin
 * nhưng index thu về đúng 5 doc rồi mới sort — cảnh báo theo cỡ collection sẽ gọi đó là vấn
 * đề ngang với một blocking SORT trên 200 doc, mà hai thứ đó cách nhau rất xa.
 */
const SMALL_WORKLOAD = 100

type Json = Record<string, unknown>

/** Tìm sâu khoá đầu tiên khớp. Hình dạng explain khác nhau giữa find/aggregate và classic/SBE. */
function deepFind(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = deepFind(item, key)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node && typeof node === 'object') {
    const obj = node as Json
    if (obj[key] !== undefined) return obj[key]
    for (const value of Object.values(obj)) {
      const hit = deepFind(value, key)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** Gom mọi giá trị chuỗi của một khoá trong cây con. Chỉ gọi trên winningPlan, không trên cả doc. */
function deepCollect(node: unknown, key: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) deepCollect(item, key, out)
    return out
  }
  if (node && typeof node === 'object') {
    const obj = node as Json
    if (typeof obj[key] === 'string') out.push(obj[key])
    for (const value of Object.values(obj)) deepCollect(value, key, out)
  }
  return out
}

interface Stats {
  stages: string[]
  indexes: string[]
  keys: number
  docs: number
  returned: number
  ms: number
}

function readExplain(explain: unknown): Stats {
  const planner = deepFind(explain, 'queryPlanner') as Json | undefined
  const winning = planner?.winningPlan as Json | undefined
  // SBE gói cây kiểu classic vào `queryPlan`; classic engine thì winningPlan CHÍNH LÀ cây đó.
  // Bắt đầu từ winningPlan (không phải từ gốc) để `rejectedPlans` không lọt vào thống kê.
  const plan = (winning?.queryPlan as Json | undefined) ?? winning
  const exec = (deepFind(explain, 'executionStats') as Json | undefined) ?? {}

  const num = (key: string): number => (typeof exec[key] === 'number' ? exec[key] : 0)

  return {
    stages: [...new Set(deepCollect(plan, 'stage'))],
    indexes: [...new Set(deepCollect(plan, 'indexName'))],
    keys: num('totalKeysExamined'),
    docs: num('totalDocsExamined'),
    returned: num('nReturned'),
    ms: num('executionTimeMillis'),
  }
}

/**
 * Filter không khớp doc nào -> mọi plan đều "nhanh" và mọi cột đều bằng 0. Không tách ca này
 * ra thì nó hiện ✓ y hệt một plan tốt thật, và người đọc kết luận ngược: cái nguy hiểm nhất
 * của một công cụ đo là màu xanh không có gì đứng sau.
 */
function isInconclusive(stats: Stats): boolean {
  return stats.returned === 0 && stats.docs === 0 && stats.keys === 0
}

/** Vấn đề rút ra từ số liệu. Rỗng = plan lành. */
function problemsOf(stats: Stats): string[] {
  const problems: string[] = []
  if (stats.stages.includes('COLLSCAN')) problems.push('COLLSCAN')
  // `SORT` là sort CHẶN trong bộ nhớ (trần 32MB). `SORT_MERGE` thì ngược lại — index đã cho sẵn
  // thứ tự, nó chỉ trộn các nhánh `$or`, nên KHÔNG tính là vấn đề.
  if (stats.stages.includes('SORT')) problems.push(`blocking SORT trên ${stats.docs} doc`)
  if (stats.returned > 0 && stats.docs / stats.returned > WASTE_RATIO) {
    problems.push(`quét ${stats.docs} doc để trả ${stats.returned}`)
  }
  if (problems.length > 0 && Math.max(stats.docs, stats.keys) < SMALL_WORKLOAD) {
    problems.push('sai cấu trúc nhưng khối lượng còn nhỏ — sửa được, chưa gấp')
  }
  return problems
}

// ── MẪU DỮ LIỆU ─────────────────────────────────────────────────────────────

/**
 * Id/giá trị lấy từ chính DB. Dùng id bịa thì filter khớp 0 doc và explain báo một plan
 * "rất nhanh" cho một câu hỏi không ai hỏi.
 */
interface Ctx {
  orgId: Types.ObjectId | null
  sellerId: Types.ObjectId | null
  categoryId: Types.ObjectId | null
  userId: Types.ObjectId | null
  conversationUserId: Types.ObjectId | null
  province: VnProvinceName | null
  ward: string | null
  provinceCode: string | null
  qTerm: string | null
  /** Đi CÙNG BỘ với `attrKey`/`attrValue` — service chặn lọc thuộc tính khi thiếu danh mục. */
  attrCategoryId: Types.ObjectId | null
  attrKey: string | null
  attrValue: string | null
  orgNameFragment: string | null
}

/**
 * Từ dài nhất trong tiêu đề, làm từ khoá cho `?q=`. Hằng số gõ tay (`'honda'`) chỉ đúng chừng
 * nào bộ seed còn sinh ra chữ đó — sai một chữ là case tìm kiếm lặng lẽ khớp 0 doc.
 */
function longestWord(title: string | undefined): string | null {
  const words = (title ?? '').split(/\s+/).filter((word) => word.length >= 4)
  if (words.length === 0) return null
  return words.reduce((best, word) => (word.length > best.length ? word : best))
}

/** Đã được `needs` chốt trước khi case chạy, nên ở đây không còn nhánh null thật. */
function req<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`thiếu mẫu dữ liệu: ${field}`)
  return value
}

/**
 * Mỗi giá trị lấy từ một document RIÊNG khớp đúng điều kiện của nó. Lấy hết từ một tin duy
 * nhất thì chỉ cần tin đó thiếu `attrs` hoặc thiếu `provinceCode` là kéo theo mấy case bị bỏ
 * qua — mà chúng vẫn đo được từ tin khác.
 */
async function sampleCtx(): Promise<Ctx> {
  return runUnscoped('explain-indexes: lấy mẫu id có thật để dựng filter', async () => {
    // Mẫu cho case chạy dưới `anonScope` phải lấy từ tin TRỤC DANH MỤC đã duyệt: scope đó chỉ
    // đọc `visibility: public` + status công khai, nên một mẫu lấy từ tin nội bộ org sẽ dựng ra
    // filter khớp 0 doc và case tự loại mình khỏi phép đo.
    const onPublicAxis = { visibility: POST_VISIBILITY.PUBLIC, status: LISTING_STATUS.ACTIVE }

    const any = await Listing.findOne().exec()
    const located = await Listing.findOne({
      ...onPublicAxis,
      'location.province': { $ne: null },
    }).exec()
    const attributed = await Listing.findOne({
      ...onPublicAxis,
      'attrs.0': { $exists: true },
    }).exec()
    const queued = await Listing.findOne({
      visibility: POST_VISIBILITY.PUBLIC,
      status: LISTING_STATUS.PENDING,
    }).exec()
    const membership = await Membership.findOne().exec()
    const conversation = await Conversation.findOne().exec()
    const org = await Organization.findOne({ deletedAt: null }).exec()
    const attr = attributed?.attrs?.find((row) => typeof row.v === 'string')

    return {
      orgId: membership?.organizationId ?? org?._id ?? null,
      sellerId: any?.seller ?? null,
      // Danh mục lấy từ tin ĐANG CHỜ DUYỆT ở trục công khai — đó là tập mà hàng đợi của
      // manager danh mục đọc, chọn danh mục khác thì hàng đợi rỗng.
      categoryId: queued?.category ?? any?.category ?? null,
      userId: membership?.userId ?? null,
      conversationUserId: conversation?.participants?.[0]?.user ?? null,
      province: located?.location?.province ?? null,
      ward: located?.location?.ward ?? null,
      provinceCode: queued?.provinceCode ?? null,
      qTerm: longestWord(located?.title),
      // Danh mục PHẢI lấy từ chính tin đã cho `attrKey`: ghép danh mục của tin này với thuộc
      // tính của tin kia thì filter đúng cú pháp nhưng khớp 0 doc, và case tự loại mình.
      attrCategoryId: attr ? (attributed?.category ?? null) : null,
      attrKey: attr?.k ?? null,
      attrValue: (attr?.v as string | undefined) ?? null,
      // Cắt một khúc GIỮA tên: `search()` chạy regex không neo đầu, đưa cả tên vào thì vô tình
      // biến nó thành gần-như-neo và che mất đúng thứ đang muốn đo.
      orgNameFragment: org?.name?.slice(2, 6) || null,
    }
  })
}

// ── SCOPE ───────────────────────────────────────────────────────────────────

/** `'none'` = model không gắn tenantPlugin nên không cần scope nào cả. */
type CaseScope = TenantScope | 'unscoped' | 'none'

/** Khách vãng lai: chỉ trục danh mục, `$or` một nhánh — Mongo rút gọn được. */
const anonScope = publicOnlyScope()

/** Thành viên org: HAI nhánh `$or` (trục org + trục danh mục) — đường đọc đắt nhất. */
function memberScope(orgId: Types.ObjectId): TenantScope {
  return { ownOrgId: orgId, readableOrgIds: [orgId], publicAxis: { mode: 'approved' } }
}

/**
 * Người duyệt trục danh mục: thấy cả tin CHƯA duyệt. `categoryIds` rỗng / `cells` null = master
 * (không giới hạn ô) — đúng như `publicPredicate` diễn giải.
 */
function moderatorScope(
  categoryIds: Types.ObjectId[],
  cells: { province: string; wards: string[] | null }[] | null,
): TenantScope {
  return {
    ownOrgId: null,
    readableOrgIds: [],
    publicAxis: { mode: 'moderator', categoryIds, cells },
  }
}

// ── CASE ────────────────────────────────────────────────────────────────────

const PAGE = { skip: 0, limit: 20 }

interface Case {
  id: string
  label: string
  /** Mục tương ứng trong bản review index — đọc kết quả là biết nó chứng minh cho điều gì. */
  ref: string
  model: mongoose.Model<any>
  needs: (keyof Ctx)[]
  scope(ctx: Ctx): CaseScope
  /** Trả về query ĐÃ gắn `.explain()` nhưng CHƯA await — `execute` mới là chỗ được await. */
  build(ctx: Ctx): PromiseLike<unknown>
}

const CASES: Case[] = [
  {
    id: 'listing/board-anon',
    label: 'Bảng tin công khai — khách vãng lai ($or 1 nhánh)',
    ref: 'nền — kỳ vọng {visibility, status, createdAt}',
    model: Listing,
    needs: [],
    scope: () => anonScope,
    build: () =>
      Listing.find(buildFilter({}))
        .sort({ createdAt: -1 })
        .skip(PAGE.skip)
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/board-member',
    label: 'Bảng tin — thành viên org ($or 2 nhánh)',
    ref: 'nền — phải ra SORT_MERGE, KHÔNG được là blocking SORT',
    model: Listing,
    needs: ['orgId'],
    scope: (ctx) => memberScope(req(ctx.orgId, 'orgId')),
    build: () =>
      Listing.find(buildFilter({}))
        .sort({ createdAt: -1 })
        .skip(PAGE.skip)
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/board-count',
    label: 'countDocuments của chính trang bảng tin đó',
    ref: 'nền — chạy song song với mọi lượt phân trang',
    model: Listing,
    needs: ['orgId'],
    scope: (ctx) => memberScope(req(ctx.orgId, 'orgId')),
    // KHÔNG dùng `Listing.countDocuments(...).explain()`: Mongoose nuốt luôn option explain và
    // trả về con số đếm, nên case này im lặng báo "không đọc được". Đây là chính cái pipeline
    // mà driver phát ra cho `countDocuments`. `deletedAt` phải khai tay — hook soft-delete gắn
    // vào `pre(/^find/)`, không chạm tới đường aggregate.
    build: () => {
      const pipeline: PipelineStage[] = [
        { $match: { ...buildFilter({}), deletedAt: null } },
        { $group: { _id: 1, n: { $sum: 1 } } },
      ]
      return Listing.aggregate(pipeline).explain('executionStats')
    },
  },
  {
    id: 'listing/mine',
    label: '"Tin của tôi" — runUnscoped, lọc theo seller',
    ref: 'A1 — thiếu { seller: 1, createdAt: -1 }',
    model: Listing,
    needs: ['sellerId'],
    scope: () => 'unscoped',
    build: (ctx) =>
      Listing.find({ seller: req(ctx.sellerId, 'sellerId') })
        .sort({ createdAt: -1 })
        .skip(PAGE.skip)
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/province',
    label: 'Lọc ?province= (location.province)',
    ref: 'A3 — location.province không nằm trong index nào',
    model: Listing,
    needs: ['province'],
    scope: () => anonScope,
    build: (ctx) =>
      Listing.find(buildFilter({ province: req(ctx.province, 'province') }))
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/nearby',
    label: '/listings/nearby — location.province + location.ward',
    ref: 'A3 — index ward hiện có bắt đầu bằng organizationId, vô dụng ở trục công khai',
    model: Listing,
    needs: ['province', 'ward'],
    scope: () => anonScope,
    build: (ctx) =>
      Listing.find({
        status: LISTING_STATUS.ACTIVE,
        'location.province': req(ctx.province, 'province'),
        'location.ward': req(ctx.ward, 'ward'),
      })
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/price-range',
    label: 'Lọc khoảng giá',
    ref: 'C1 — {organizationId, price, status} sai thứ tự ESR',
    model: Listing,
    needs: ['orgId'],
    scope: (ctx) => memberScope(req(ctx.orgId, 'orgId')),
    build: () =>
      Listing.find(buildFilter({ minPrice: 1_000_000, maxPrice: 50_000_000 }))
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/attrs',
    label: 'Lọc thuộc tính động (attrs.k / attrs.v)',
    ref: 'F — attribute pattern, kỳ vọng dùng index multikey',
    model: Listing,
    needs: ['attrCategoryId', 'attrKey', 'attrValue'],
    scope: () => anonScope,
    build: (ctx) =>
      Listing.find(
        buildFilter({
          category: String(req(ctx.attrCategoryId, 'attrCategoryId')),
          attrs: { [req(ctx.attrKey, 'attrKey')]: req(ctx.attrValue, 'attrValue') },
        }),
      )
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/search-q',
    label: 'Tìm kiếm ?q= (regex title/description)',
    ref: 'D1 — không index; đo để biết TRẦN thật, không phải để sửa ngay',
    model: Listing,
    needs: ['qTerm'],
    scope: () => anonScope,
    build: (ctx) =>
      Listing.find(buildFilter({ q: req(ctx.qTerm, 'qTerm') }))
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/moderation-queue',
    label: 'Hàng đợi duyệt của manager danh mục',
    ref: 'nền — kỳ vọng {visibility, category, provinceCode, wardCode, status, createdAt}',
    model: Listing,
    needs: ['categoryId'],
    scope: (ctx) =>
      moderatorScope(
        [req(ctx.categoryId, 'categoryId')],
        ctx.provinceCode ? [{ province: ctx.provinceCode, wards: null }] : null,
      ),
    build: () =>
      Listing.find({ status: { $in: [...MODERATABLE_STATUSES] } })
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'listing/pending-by-cell',
    label: 'aggregate pendingByCategoryProvince (dashboard phủ sóng)',
    ref: 'nền — $match visibility+status phải bám index trước $group',
    model: Listing,
    needs: [],
    // Scope master: `anonScope` sẽ chèn `status: {$in: PUBLIC_LISTING_STATUSES}` chọi thẳng với
    // `$match status: pending` của pipeline — ra 0 doc và không đo được gì.
    scope: () => moderatorScope([], null),
    build: () => {
      const pipeline: PipelineStage[] = [
        {
          $match: {
            status: { $in: [LISTING_STATUS.PENDING, LISTING_STATUS.PENDING_UNVERIFIED] },
            visibility: POST_VISIBILITY.PUBLIC,
          },
        },
        {
          $group: {
            _id: { category: '$category', province: '$provinceCode' },
            count: { $sum: 1 },
          },
        },
      ]
      return Listing.aggregate(pipeline).explain('executionStats')
    },
  },
  {
    id: 'join-request/expire-stale',
    label: 'expireStale — sweep toàn cục (đo bằng find cùng filter)',
    ref: 'A2 — comment nói "có index", nhưng không index nào có prefix dùng được',
    model: JoinRequest,
    needs: [],
    scope: () => 'none',
    build: () =>
      JoinRequest.find({
        status: JOIN_REQUEST_STATUS.PENDING,
        expiresAt: { $lt: new Date() },
      }).explain('executionStats'),
  },
  {
    id: 'membership/org-directory',
    label: 'Danh bạ org — sort joinedAt',
    ref: 'A4 — mở rộng {organizationId, status} thành {organizationId, status, joinedAt}',
    model: Membership,
    needs: ['orgId'],
    scope: () => 'none',
    build: (ctx) =>
      Membership.find({
        organizationId: req(ctx.orgId, 'orgId'),
        status: MEMBERSHIP_STATUS.ACTIVE,
      })
        .sort({ joinedAt: 1 })
        .skip(PAGE.skip)
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'membership/scope-build',
    label: 'listActiveByUser — chạy trên MỌI request đã đăng nhập',
    ref: 'nền — {userId, organizationId} cho bounds, sort vài doc',
    model: Membership,
    needs: ['userId'],
    scope: () => 'none',
    build: (ctx) =>
      Membership.find({ userId: req(ctx.userId, 'userId'), status: MEMBERSHIP_STATUS.ACTIVE })
        .sort({ joinedAt: 1 })
        .explain('executionStats'),
  },
  {
    id: 'organization/lookup',
    label: 'Dropdown chọn org — $or(slugNormalized neo đầu, name regex)',
    ref: 'D2 — nhánh name không index nên cả $or rơi về COLLSCAN',
    model: Organization,
    needs: ['orgNameFragment'],
    scope: () => 'none',
    build: (ctx) => {
      const query = req(ctx.orgNameFragment, 'orgNameFragment')
      const normalized = normalizeOrgSlug(query)
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
      return Organization.find({
        deletedAt: null,
        $or: [
          ...(normalized ? [{ slugNormalized: { $regex: `^${normalized}` } }] : []),
          { name: { $regex: escaped, $options: 'i' } },
        ],
      })
        .sort({ name: 1 })
        .limit(PAGE.limit)
        .explain('executionStats')
    },
  },
  {
    id: 'category/list',
    label: 'Từ điển danh mục — sort {order, name}',
    ref: 'C2 — index {isActive, order} thiếu name nên sort vẫn chặn',
    model: Category,
    needs: [],
    scope: () => 'none',
    build: () =>
      Category.find({ isActive: true }).sort({ order: 1, name: 1 }).explain('executionStats'),
  },
  {
    id: 'notification/inbox',
    label: 'Hộp thư: tin phát chung + tin đích danh ($or 2 nhánh)',
    ref: 'F — {org, createdAt, unitId, userId} đặt sort-key trước cả hai filter-key',
    model: Notification,
    needs: ['orgId', 'userId'],
    scope: (ctx) => memberScope(req(ctx.orgId, 'orgId')),
    // Đúng hình mà `notificationRepository.paginate` dựng cho `scope=inbox`: nhánh riêng của
    // người đọc, cộng nhánh phát chung. Đo nhánh `unitId` một mình sẽ bỏ sót nhánh mới nhất.
    build: (ctx) =>
      Notification.find({
        $or: [{ userId: req(ctx.userId, 'userId') }, { userId: null, unitId: null }],
      })
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'chat/my-conversations',
    label: 'Hội thoại của tôi — participants.user',
    ref: 'nền — kỳ vọng {organizationId, participants.user, lastMessageAt}',
    model: Conversation,
    needs: ['orgId', 'conversationUserId'],
    scope: (ctx) => memberScope(req(ctx.orgId, 'orgId')),
    build: (ctx) =>
      Conversation.find({
        'participants.user': req(ctx.conversationUserId, 'conversationUserId'),
      })
        .sort({ lastMessageAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'favorite/my-list',
    label: 'Tin đã lưu',
    ref: 'nền — kỳ vọng {userId, createdAt}',
    model: Favorite,
    needs: ['userId'],
    scope: () => 'none',
    build: (ctx) =>
      Favorite.find({ userId: req(ctx.userId, 'userId') })
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
  {
    id: 'report/queue',
    label: 'Hàng đợi báo cáo còn mở',
    ref: 'nền — kỳ vọng {organizationId, status, createdAt}',
    model: Report,
    needs: ['orgId'],
    scope: (ctx) => memberScope(req(ctx.orgId, 'orgId')),
    build: () =>
      Report.find({ status: REPORT_STATUS.OPEN })
        .sort({ createdAt: -1 })
        .limit(PAGE.limit)
        .explain('executionStats'),
  },
]

/**
 * `await` PHẢI nằm trong frame của `runWithTenant`/`runUnscoped`. Mongoose Query chạy lười:
 * trả nó ra ngoài rồi mới await thì `exec()` chạy sau khi AsyncLocalStorage đã rời scope, và
 * pre-hook của tenantPlugin ném "Missing tenant context" — lỗi trông y hệt một bug của app.
 */
function execute(testCase: Case, ctx: Ctx): Promise<unknown> {
  const body = async (): Promise<unknown> => {
    const explained = await testCase.build(ctx)
    return explained
  }

  const scope = testCase.scope(ctx)
  if (scope === 'none') return body()
  if (scope === 'unscoped') return runUnscoped(`explain-indexes: ${testCase.id}`, body)
  return runWithTenant(scope, body)
}

// ── IN KẾT QUẢ ──────────────────────────────────────────────────────────────

interface Row {
  id: string
  label: string
  ref: string
  collection: string
  collectionDocs: number
  problems: string[]
  stats?: Stats
  skipped?: string
  error?: string
}

function printRow(index: number, row: Row): void {
  const seq = String(index + 1).padStart(2, '0')

  if (row.skipped) {
    console.log(`[${seq}] –  ${row.label}\n     bỏ qua: ${row.skipped}\n`)
    return
  }
  if (!row.stats) {
    console.log(`[${seq}] !  ${row.label}\n     LỖI: ${row.error ?? 'không rõ'}\n`)
    return
  }

  const stats = row.stats
  const mark = isInconclusive(stats) ? '○' : row.problems.length === 0 ? '✓' : '✗'
  console.log(`[${seq}] ${mark}  ${row.label}`)
  console.log(`     stage    ${stats.stages.join(' → ') || '(không đọc được)'}`)
  console.log(`     index    ${stats.indexes.join(', ') || '—'}`)
  console.log(
    `     keys ${stats.keys} · docs ${stats.docs} · trả ${stats.returned} · ${stats.ms}ms` +
      ` · ${row.collection}=${row.collectionDocs} doc`,
  )
  if (isInconclusive(stats)) {
    console.log('     ↳ filter không khớp doc nào — index ở trên chỉ là lựa chọn của planner')
  } else if (row.problems.length > 0) {
    console.log(`     ↳ ${row.problems.join(' · ')}`)
  }
  console.log(`     ref: ${row.ref}\n`)
}

// ── CHẠY ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json')

  await mongoose.connect(env.MONGO_URI, { serverSelectionTimeoutMS: 15_000 })
  const db = mongoose.connection.db
  if (!db) throw new Error('Không lấy được handle database sau khi connect')

  if (!asJson) {
    console.log('━━━ EXPLAIN INDEXES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(`db: ${mongoose.connection.name} @ ${mongoose.connection.host}`)
    console.log(`NODE_ENV: ${env.NODE_ENV}\n`)
  }

  const ctx = await sampleCtx()
  const missing = (Object.keys(ctx) as (keyof Ctx)[]).filter((key) => ctx[key] === null)
  if (missing.length > 0 && !asJson) {
    console.log(`⚠ Không lấy được mẫu cho: ${missing.join(', ')} — case liên quan sẽ bỏ qua.\n`)
  }

  const sizes = new Map<string, number>()
  const rows: Row[] = []

  for (const testCase of CASES) {
    const collection = testCase.model.collection.collectionName
    if (!sizes.has(collection)) {
      // Đi thẳng driver: `estimatedDocumentCount` của model bị tenantPlugin CHẶN (nó bỏ qua
      // filter tenant), mà ở đây cần đúng con số thô của cả collection.
      sizes.set(collection, await db.collection(collection).estimatedDocumentCount())
    }
    const collectionDocs = sizes.get(collection) ?? 0
    const base: Row = {
      id: testCase.id,
      label: testCase.label,
      ref: testCase.ref,
      collection,
      collectionDocs,
      problems: [],
    }

    const unmet = testCase.needs.filter((key) => ctx[key] === null)
    if (unmet.length > 0) {
      rows.push({ ...base, skipped: `thiếu mẫu ${unmet.join(', ')}` })
      continue
    }

    try {
      const stats = readExplain(await execute(testCase, ctx))
      rows.push({ ...base, stats, problems: problemsOf(stats) })
    } catch (err) {
      rows.push({ ...base, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ db: mongoose.connection.name, rows }, null, 2))
  } else {
    rows.forEach((row, index) => printRow(index, row))

    const measured = rows.filter((row) => row.stats && !isInconclusive(row.stats))
    const blank = rows.filter((row) => row.stats && isInconclusive(row.stats))
    const bad = measured.filter((row) => row.problems.length > 0)
    console.log('━━━ TỔNG KẾT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log(
      `${measured.length - bad.length}/${measured.length} plan lành · ${bad.length} cần xử lý` +
        ` · ${blank.length} chưa đo được · ${rows.filter((row) => row.skipped).length} bỏ qua`,
    )
    for (const row of bad) console.log(`  ✗ ${row.id} — ${row.problems.join(' · ')}`)
    for (const row of blank) console.log(`  ○ ${row.id} — 0 doc khớp filter`)

    // Nêu TÊN collection còn mỏng thay vì một câu chung chung: ở cỡ này planner chọn COLLSCAN
    // vì nó rẻ thật, nên một ✗ trên `organizations` (3 doc) đọc khác hẳn ✗ trên `listings`.
    const thin = [...new Set(rows.filter((r) => r.collectionDocs < MEANINGFUL_DOCS))]
      .map((row) => `${row.collection}=${row.collectionDocs}`)
      .sort()
    if (thin.length > 0) {
      console.log(
        `\n⚠ Dưới ${MEANINGFUL_DOCS} doc: ${[...new Set(thin)].join(', ')}.` +
          ' Kết luận cấu trúc (stage nào, index nào) vẫn đúng; con số thì chưa nói lên chi phí.',
      )
    }
  }

  await mongoose.disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await mongoose.disconnect().catch(() => undefined)
  process.exit(1)
})
