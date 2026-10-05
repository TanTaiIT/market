import { walletRepository } from './wallet.repository'
import { logger } from '../../config/logger'

/**
 * Đối soát ví — thân job, Agenda gọi mỗi ngày (`config/agenda.ts`) và test gọi thẳng (audit 4.2).
 *
 * `wallets.balance` chỉ là cache của `sum(xu_transactions.amount)`. Hai thứ lệch nhau nghĩa là
 * có người ghi tắt vào `balance`, hoặc một transaction hỏng nửa chừng — không tự sửa (sửa là
 * đoán bên nào đúng), chỉ NÉM để `agenda.on('fail')` đẩy lên Sentry và người thật vào xem.
 */
export const walletReconcileService = {
  async sweep(): Promise<{ checked: number; mismatched: number }> {
    const { checked, mismatched } = await walletRepository.reconcile()

    if (mismatched.length > 0) {
      logger.error('wallet-reconcile: ví lệch sổ cái', { checked, mismatched })
      throw new Error(`wallet-reconcile: ${mismatched.length}/${checked} ví lệch sổ cái`)
    }

    // Chỉ log khi có ví để đối soát — hệ thống chưa có ví nào thì dòng "0 khớp 0" là nhiễu.
    if (checked > 0) logger.info('wallet-reconcile: khớp sổ cái', { checked })
    return { checked, mismatched: 0 }
  },
}
