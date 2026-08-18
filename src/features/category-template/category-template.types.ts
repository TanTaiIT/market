import { z } from 'zod'
import type { IFieldDefinitionDocument, ICategoryTemplateDocument } from './category-template.model'
import { templateResponseSchema, templateFieldResponseSchema } from './category-template.schema'

export type ResolvedField = z.infer<typeof templateFieldResponseSchema>
export type ResolvedTemplate = z.infer<typeof templateResponseSchema>

/**
 * Ghép `fieldKeys` của template với từ điển `field_definitions` thành field ĐẦY ĐỦ.
 *
 * Response trả bản đã ghép sẵn (đặc tả §5.2) chứ không trả hai mảng rời để FE tự join: form
 * đăng tin cần nó ngay lúc mount, và một lượt gọi thứ hai chỉ để tra `label` là một lần chờ
 * nữa trước khi người dùng gõ được chữ đầu tiên.
 *
 * `key` có trong template nhưng KHÔNG có trong từ điển thì bị bỏ qua, không ném lỗi: đó là dữ
 * liệu seed lệch, và làm chết cả form đăng tin vì một field thừa là đổi lỗi nhỏ thành lỗi to.
 */
export function toTemplateDto(
  template: ICategoryTemplateDocument,
  defs: IFieldDefinitionDocument[],
): ResolvedTemplate {
  const byKey = new Map(defs.map((d) => [d.key, d]))

  // `flatMap` + mảng rỗng thay cho `map().filter()`: filter với type predicate không thu hẹp
  // được `null` ở đây vì optional field của zod và `T | undefined` của Mongoose không cùng hình.
  const fields = template.fieldKeys
    .flatMap((used): ResolvedField[] => {
      const def = byKey.get(used.key)
      if (!def) return []

      return [
        {
          key: def.key,
          label: used.override?.label ?? def.label,
          type: used.override?.type ?? def.type,
          // `options` của override thay THẾ chứ không gộp: `brand` thành dropdown ở Điện thoại
          // là một danh sách hãng điện thoại, gộp với bản từ điển (rỗng) thì vô nghĩa.
          options: used.override?.options ?? def.options,
          placeholder: used.override?.placeholder ?? def.placeholder,
          helpText: used.override?.helpText ?? def.helpText,
          unit: def.unit,
          min: def.min,
          max: def.max,
          order: used.order,
          required: used.required,
          // `??` chứ không `||`: `filterable: false` ở template là một lựa chọn tường minh
          // (tắt lọc cho riêng danh mục này), `||` sẽ nuốt nó và rơi về giá trị từ điển.
          filterable: used.filterable ?? def.filterable,
          group: used.group,
          showIf: used.showIf,
        },
      ]
    })
    .sort((a, b) => a.order - b.order)

  return {
    templateId: template._id.toString(),
    version: template.version,
    isFallback: template.isFallback,
    fields,
  }
}
