import { IJoinRequestDocument } from './join-request.model'

/** Dòng trong hàng đợi duyệt của org. */
export function toJoinRequestDto(doc: IJoinRequestDocument) {
  return {
    id: doc._id.toString(),
    userId: doc.userId.toString(),
    organizationId: doc.organizationId.toString(),
    claimedName: doc.claimedName,
    claimedUnit: doc.claimedUnit,
    note: doc.note,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
  }
}

/**
 * Bản cho chính người gửi. Bỏ `reviewedBy` — người gửi không cần biết ai trong org đã từ chối
 * mình, và để lộ thì mọi tranh cãi sẽ nhắm vào một cá nhân cụ thể.
 */
export function toMyJoinRequestDto(doc: IJoinRequestDocument) {
  return {
    id: doc._id.toString(),
    organizationId: doc.organizationId.toString(),
    claimedName: doc.claimedName,
    claimedUnit: doc.claimedUnit,
    status: doc.status,
    rejectReason: doc.rejectReason,
    createdAt: doc.createdAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
  }
}
