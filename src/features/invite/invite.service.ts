import { createHash, randomBytes } from 'node:crypto'
import { Types } from 'mongoose'
import { inviteRepository } from './invite.repository'
import { CreateInviteInput } from './invite.schema'
import { toInviteDto, toMyInviteDto } from './invite.types'
import { organizationRepository } from '../organization/organization.repository'
import { membershipRepository } from '../membership/membership.repository'
import { userRepository } from '../user/user.repository'
import { notificationService } from '../notification/notification.service'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../common/errors'
import {
  INVITE_CHANNELS,
  INVITE_STATUS,
  INVITE_TTL_DAYS,
  JOINED_VIA,
  MEMBERSHIP_ROLES,
  TENANT_STATUS,
} from '../../common/constants'
import { requireOwnOrgId } from '../../common/tenant/tenantContext'

/** Mã lỗi unique index của MongoDB. */
const DUPLICATE_KEY = 11000

/**
 * Token nằm trong link, chỉ BĂM được lưu — cùng khuôn với reset mật khẩu. Rò DB không được
 * phép biến thành rò lời mời.
 */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Chuẩn hoá để so trùng: email không phân biệt hoa thường, số điện thoại bỏ mọi dấu phân cách. */
function normalizeValue(channel: string, raw: string): string {
  return channel === INVITE_CHANNELS.EMAIL
    ? raw.trim().toLowerCase()
    : raw.replaceAll(/[\s.-]/g, '')
}

export const inviteService = {
  /**
   * Tạo lời mời. Hệ thống tự chọn dạng, admin không chọn:
   *
   * - tra ra ĐÚNG MỘT tài khoản → `direct`, kèm thông báo trong app
   * - không ra ai, hoặc ra nhiều người → `link`, admin tự gửi qua Zalo/Messenger
   *
   * "Ra nhiều người" là ca thật với số điện thoại: `phone` không unique, hai tài khoản trùng số
   * là hợp lệ hôm nay. Đoán bừa một trong hai là mời nhầm người, nên rơi về link.
   */
  async create(input: CreateInviteInput, actorId: string) {
    const organizationId = requireOwnOrgId('invite.create')
    const value = normalizeValue(input.channel, input.value)

    const matches =
      input.channel === INVITE_CHANNELS.EMAIL
        ? await userRepository.findByEmail(value).then((user) => (user ? [user] : []))
        : await userRepository.findByPhone(value)

    const invited = matches.length === 1 ? matches[0] : null

    if (invited && (await membershipRepository.findActive(invited._id, organizationId))) {
      throw new ConflictError('Người này đã là thành viên của tổ chức')
    }

    const token = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)

    let doc
    try {
      doc = await inviteRepository.create({
        organizationId,
        channel: input.channel,
        value,
        kind: invited ? 'direct' : 'link',
        tokenHash: hashToken(token),
        invitedUserId: invited?._id ?? null,
        invitedBy: new Types.ObjectId(actorId),
        expiresAt,
      })
    } catch (err) {
      // Unique index chặn hai lời mời còn hiệu lực cho cùng một địa chỉ.
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err
      throw new ConflictError('Đã có lời mời đang chờ cho địa chỉ này — thu hồi trước khi mời lại')
    }

    if (invited) {
      const org = await organizationRepository.findById(organizationId)
      await notificationService.notifyUser({
        organizationId,
        userId: invited._id,
        title: 'Bạn được mời vào một nhóm',
        body: `${org?.name ?? 'Một tổ chức'} mời bạn tham gia.`,
      })
    }

    // Token trả về ĐÚNG MỘT LẦN, ngay tại đây. Sau lượt này trong DB chỉ còn bản băm, không ai
    // đọc lại được — kể cả admin. Muốn link khác thì thu hồi rồi mời lại.
    return { invite: toInviteDto(doc), token, shareable: !invited }
  },

  async list() {
    const organizationId = requireOwnOrgId('invite.list')
    await inviteRepository.expireStale(new Date())
    const rows = await inviteRepository.listByOrganization(organizationId)
    return rows.map((row) => toInviteDto(row))
  },

  async revoke(id: string) {
    const organizationId = requireOwnOrgId('invite.revoke')
    const invite = await inviteRepository.findById(id)
    // So org tường minh: bảng này không có plugin, không ai chèn filter hộ.
    if (!invite || !invite.organizationId.equals(organizationId)) {
      throw new NotFoundError('Không tìm thấy lời mời')
    }
    if (invite.status !== INVITE_STATUS.PENDING) {
      throw new BadRequestError('Lời mời này đã được xử lý rồi')
    }

    invite.status = INVITE_STATUS.REVOKED
    await invite.save()
    return toInviteDto(invite)
  },

  /** Hộp thư lời mời đích danh của người đang đăng nhập. */
  async listMine(userId: string) {
    await inviteRepository.expireStale(new Date())
    const rows = await inviteRepository.listPendingForUser(userId)

    const orgs = await Promise.all(
      rows.map((row) => organizationRepository.findById(row.organizationId)),
    )
    return rows
      .map((row, index) => {
        const org = orgs[index]
        return org ? toMyInviteDto(row, org) : null
      })
      .filter((row) => row !== null)
  },

  /** Thẻ xem trước cho người vừa bấm link, TRƯỚC khi họ đăng nhập. */
  async preview(token: string) {
    const invite = await this.findUsable(token)
    // Chốt `active` y như `accept`: org bị khoá mà vẫn hiện thẻ thì người ta bấm nhận rồi mới
    // ăn lỗi. Kiểm ngay trên document đang có, không gọi thêm `findActiveById` cho một câu hỏi
    // mà thứ vừa đọc về đã trả lời được.
    const org = await organizationRepository.findById(invite.organizationId)
    if (!org || org.status !== TENANT_STATUS.ACTIVE) {
      throw new NotFoundError('Tổ chức không còn hoạt động')
    }

    const memberCount = await membershipRepository.countActiveByOrganization(org._id)
    return {
      organizationName: org.name,
      organizationAvatarUrl: org.avatarUrl,
      description: org.description,
      memberCount,
      expiresAt: invite.expiresAt.toISOString(),
    }
  },

  /**
   * Nhận lời mời — vào thẳng, KHÔNG qua hàng đợi duyệt đơn.
   *
   * Đó là toàn bộ khác biệt giữa lời mời và đơn xin vào: người trong tổ chức đã chủ động gọi
   * tên bạn rồi, bắt xếp hàng thêm một lượt nữa là bắt chính họ duyệt lại việc mình vừa làm.
   */
  async accept(token: string, userId: string) {
    const invite = await this.findUsable(token)

    // Lời mời đích danh là của ĐÚNG một người. Không chốt chỗ này thì nó thành link công khai,
    // và cả lý do phân biệt hai dạng biến mất.
    if (invite.invitedUserId && !invite.invitedUserId.equals(userId)) {
      throw new ForbiddenError('Lời mời này dành cho người khác')
    }

    const org = await organizationRepository.findActiveById(invite.organizationId)
    if (!org) throw new NotFoundError('Tổ chức không còn hoạt động')

    const existing = await membershipRepository.findActive(userId, invite.organizationId)
    if (!existing) {
      await membershipRepository.create({
        userId: new Types.ObjectId(userId),
        organizationId: invite.organizationId,
        role: MEMBERSHIP_ROLES.MEMBER,
        joinedVia: JOINED_VIA.INVITE,
      })
    }

    invite.status = INVITE_STATUS.ACCEPTED
    invite.acceptedAt = new Date()
    await invite.save()

    return { organizationSlug: org.slug }
  },

  /** Tra lời mời còn dùng được, hoặc ném đúng lý do vì sao không. */
  async findUsable(token: string) {
    const invite = await inviteRepository.findByTokenHash(hashToken(token))
    if (!invite) throw new NotFoundError('Lời mời không tồn tại')
    if (invite.status === INVITE_STATUS.ACCEPTED) {
      throw new BadRequestError('Lời mời này đã được dùng rồi')
    }
    if (invite.status === INVITE_STATUS.REVOKED) {
      throw new BadRequestError('Lời mời này đã bị thu hồi')
    }
    if (invite.expiresAt < new Date()) throw new BadRequestError('Lời mời đã hết hạn')
    return invite
  },
}
