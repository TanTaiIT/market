import { describe, it, expect } from 'vitest'
import {
  PUSH_LIMITS,
  RETRY_DELAYS_MS,
  buildExpoMessage,
  chatPushText,
  isExpoPushToken,
  isPushAllowed,
  isRetryableExpoError,
  isSafePushPath,
  nextAttemptAt,
  requiresOptIn,
  resolvePushPrefs,
  truncate,
} from '../../src/features/push/push.policy'

describe('Push — công tắc', () => {
  it('chưa chọn gì: bật hết, trừ `group_activity` (fan-out lớn, mặc định tắt)', () => {
    const prefs = resolvePushPrefs(undefined)
    expect(prefs.enabled).toBe(true)
    expect(prefs.categories.chat).toBe(true)
    expect(prefs.categories.group_activity).toBe(false)
    expect(requiresOptIn('group_activity')).toBe(true)
    expect(requiresOptIn('chat')).toBe(false)
  })

  it('đọc được cả Map (document) lẫn object thuần (`.lean()`)', () => {
    expect(resolvePushPrefs({ categories: new Map([['chat', false]]) }).categories.chat).toBe(false)
    expect(resolvePushPrefs({ categories: { chat: false } }).categories.chat).toBe(false)
  })

  it('`account` không tắt được — kể cả khi lưu false, kể cả công tắc tổng tắt', () => {
    const prefs = resolvePushPrefs({ enabled: false, categories: { account: false, chat: true } })
    expect(prefs.categories.account).toBe(true)
    expect(isPushAllowed(prefs, 'account')).toBe(true)
    expect(isPushAllowed(prefs, 'chat')).toBe(false)
  })

  it('tắt một nhóm chỉ chặn đúng nhóm đó', () => {
    const prefs = resolvePushPrefs({ categories: { chat: false } })
    expect(isPushAllowed(prefs, 'chat')).toBe(false)
    expect(isPushAllowed(prefs, 'listing_status')).toBe(true)
  })
})

describe('Push — nội dung', () => {
  it('cắt theo ký tự Unicode, không xẻ đôi dấu tiếng Việt hay emoji', () => {
    expect(truncate('Xin chào', 60)).toBe('Xin chào')
    const cut = truncate('😀'.repeat(10), 5)
    expect(Array.from(cut)).toHaveLength(5)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toContain('�')
  })

  it('payload dài nhất có thể vẫn dưới trần 4096 byte của Expo', () => {
    const msg = buildExpoMessage(
      {
        category: 'listing_status',
        title: 'Ữ'.repeat(500),
        body: 'Ữ'.repeat(5000),
        data: { path: '/listing/' + 'a'.repeat(24), notificationId: 'b'.repeat(24) },
      },
      'ExponentPushToken[' + 'x'.repeat(40) + ']',
    )
    expect(Array.from(msg.title)).toHaveLength(PUSH_LIMITS.TITLE_MAX)
    expect(Array.from(msg.body)).toHaveLength(PUSH_LIMITS.BODY_MAX)
    expect(Buffer.byteLength(JSON.stringify(msg))).toBeLessThan(4096)
  })

  it('kênh Android = nhóm; ưu tiên + ttl theo nhóm', () => {
    const chat = buildExpoMessage(
      { category: 'chat', title: 'A', body: 'B', data: { conversationId: 'c1', path: '/chat/c1' } },
      'ExponentPushToken[abcdefghijkl]',
    )
    expect(chat).toMatchObject({ channelId: 'chat', priority: 'high', ttl: 3600 })
    expect(chat.data).toEqual({ category: 'chat', path: '/chat/c1', conversationId: 'c1' })
  })

  it('chat không kèm nội dung tin, chỉ tên người gửi', () => {
    expect(chatPushText('Tài', 1)).toEqual({ title: 'Tài', body: 'Đã gửi cho bạn một tin nhắn' })
    expect(chatPushText('Tài', 4).body).toBe('4 tin nhắn mới')
    expect(chatPushText('', 1).title).toBe('Ai đó')
  })
})

describe('Push — chốt đầu vào', () => {
  it('token Expo hợp lệ và không hợp lệ', () => {
    expect(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true)
    expect(isExpoPushToken('ExpoPushToken[abcdefghij123]')).toBe(true)
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false)
    expect(isExpoPushToken('fcm-raw-token-abc')).toBe(false)
    expect(isExpoPushToken('ExponentPushToken[abc"; drop]')).toBe(false)
  })

  it('đường dẫn chỉ nhận route nội bộ', () => {
    expect(isSafePushPath('/listing/6ab818381a4ccd8480c1db87')).toBe(true)
    expect(isSafePushPath('/chat/abc')).toBe(true)
    expect(isSafePushPath('https://evil.tld')).toBe(false)
    expect(isSafePushPath('//evil.tld/x')).toBe(false)
    expect(isSafePushPath('listing/1')).toBe(false)
    expect(isSafePushPath('/a?x=javascript:alert(1)')).toBe(false)
  })
})

describe('Push — retry', () => {
  const now = new Date('2026-09-27T00:00:00Z')

  it('lùi dần 1 phút → 5 phút → 15 phút rồi thôi', () => {
    expect(nextAttemptAt(1, now)!.getTime() - now.getTime()).toBe(RETRY_DELAYS_MS[0])
    expect(nextAttemptAt(2, now)!.getTime() - now.getTime()).toBe(RETRY_DELAYS_MS[1])
    expect(nextAttemptAt(3, now)!.getTime() - now.getTime()).toBe(RETRY_DELAYS_MS[2])
    expect(nextAttemptAt(PUSH_LIMITS.MAX_ATTEMPTS, now)).toBeNull()
  })

  it('máy đã gỡ app và tin quá lớn thì gửi lại vô ích; nghẽn và lỗi mạng thì thử lại', () => {
    expect(isRetryableExpoError('DeviceNotRegistered')).toBe(false)
    expect(isRetryableExpoError('MessageTooBig')).toBe(false)
    expect(isRetryableExpoError('MessageRateExceeded')).toBe(true)
    expect(isRetryableExpoError(undefined)).toBe(true)
  })
})
