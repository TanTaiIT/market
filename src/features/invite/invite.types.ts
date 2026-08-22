import { IInviteDocument } from './invite.model'

/** Dòng trong danh sách "đã mời ai" của bàn quản trị. */
export function toInviteDto(doc: IInviteDocument) {
  return {
    id: doc._id.toString(),
    channel: doc.channel,
    value: doc.value,
    kind: doc.kind,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
  }
}

/**
 * Bản cho NGƯỜI ĐƯỢC MỜI. Không có `value`: họ đã biết địa chỉ của chính mình, còn hiện nó ra
 * thì một lời mời gửi nhầm sẽ lộ email/số điện thoại của người khác.
 */
export function toMyInviteDto(
  doc: IInviteDocument,
  org: { name: string; avatarUrl: string | null },
) {
  return {
    id: doc._id.toString(),
    organizationName: org.name,
    organizationAvatarUrl: org.avatarUrl,
    createdAt: doc.createdAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
  }
}
