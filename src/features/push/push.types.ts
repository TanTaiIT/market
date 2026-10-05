import { z } from 'zod'
import type { IPushDeviceDocument } from './push.model'
import { LOCKED_PUSH_CATEGORIES, type PushPrefs } from './push.policy'
import { pushDeviceResponseSchema, pushPreferencesResponseSchema } from './push.schema'

export type PushDeviceDto = z.infer<typeof pushDeviceResponseSchema>
export type PushPreferencesDto = z.infer<typeof pushPreferencesResponseSchema>

/** Không trả `token`: app đã có nó, và response là thứ lọt vào log của proxy trên đường. */
export function toPushDeviceDto(doc: IPushDeviceDocument): PushDeviceDto {
  return {
    id: doc._id.toString(),
    platform: doc.platform,
    appVersion: doc.appVersion,
    deviceName: doc.deviceName,
    lastSeenAt: doc.lastSeenAt.toISOString(),
  }
}

export function toPushPreferencesDto(prefs: PushPrefs): PushPreferencesDto {
  return { enabled: prefs.enabled, categories: prefs.categories, locked: LOCKED_PUSH_CATEGORIES }
}
