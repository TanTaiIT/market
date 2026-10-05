import { IXuTransactionDocument } from './wallet.model'

/**
 * Một dòng sổ cái ra API — whitelist theo `xuTransactionSchema` (audit 4.3). Trả nguyên document
 * từng lộ `idempotencyKey`, `__v` và mọi field thêm sau này mà không ai đối chiếu với spec.
 */
export function toXuTransactionDto(doc: IXuTransactionDocument) {
  return {
    _id: doc._id.toString(),
    userId: doc.userId.toString(),
    amount: doc.amount,
    type: doc.type,
    balanceAfter: doc.balanceAfter,
    note: doc.note,
    ...(doc.refs
      ? {
          refs: {
            ...(doc.refs.listingId ? { listingId: doc.refs.listingId.toString() } : {}),
            ...(doc.refs.paymentId ? { paymentId: doc.refs.paymentId.toString() } : {}),
            ...(doc.refs.productCode ? { productCode: doc.refs.productCode } : {}),
          },
        }
      : {}),
    createdAt: doc.createdAt.toISOString(),
  }
}
