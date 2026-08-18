import { describe, it, expect } from 'vitest'
import {
  isFieldVisible,
  validateAttributes,
} from '../../src/features/category-template/category-template.validate'
import type {
  ResolvedField,
  ResolvedTemplate,
} from '../../src/features/category-template/category-template.types'
import { FIELD_TYPE } from '../../src/common/constants'
import { BadRequestError } from '../../src/common/errors'

const field = (patch: Partial<ResolvedField> & Pick<ResolvedField, 'key'>): ResolvedField => ({
  label: patch.key,
  type: FIELD_TYPE.TEXT,
  options: [],
  order: 10,
  required: false,
  filterable: false,
  ...patch,
})

const template = (...fields: ResolvedField[]): ResolvedTemplate => ({
  templateId: '507f1f77bcf86cd799439011',
  version: 1,
  isFallback: false,
  fields,
})

describe('Ép kiểu — form luôn trả chuỗi, DB phải nhận kiểu thật', () => {
  it('number và year thành Number, không phải chuỗi', () => {
    const tpl = template(
      field({ key: 'odo', type: FIELD_TYPE.NUMBER }),
      field({ key: 'yearMade', type: FIELD_TYPE.YEAR }),
    )
    const { attributes } = validateAttributes(tpl, { odo: '15000', yearMade: '2020' })

    // Đây là cả lý do đổi `attributes` sang Mixed: "15000" không bao giờ match $gte: 10000.
    expect(attributes).toEqual({ odo: 15000, yearMade: 2020 })
  })

  it('boolean nhận cả true thật lẫn chuỗi "true"', () => {
    const tpl = template(field({ key: 'warranty', type: FIELD_TYPE.BOOLEAN }))

    expect(validateAttributes(tpl, { warranty: 'true' }).attributes).toEqual({ warranty: true })
    expect(validateAttributes(tpl, { warranty: true }).attributes).toEqual({ warranty: true })
    expect(validateAttributes(tpl, { warranty: 'false' }).attributes).toEqual({ warranty: false })
  })

  it('multiselect bọc giá trị đơn thành mảng và bỏ trùng', () => {
    const tpl = template(
      field({
        key: 'amenities',
        type: FIELD_TYPE.MULTISELECT,
        options: [
          { value: 'wifi', label: 'Wifi' },
          { value: 'aircon', label: 'Điều hoà' },
        ],
      }),
    )

    expect(validateAttributes(tpl, { amenities: 'wifi' }).attributes).toEqual({
      amenities: ['wifi'],
    })
    expect(validateAttributes(tpl, { amenities: ['wifi', 'wifi', 'aircon'] }).attributes).toEqual({
      amenities: ['wifi', 'aircon'],
    })
  })

  it('số ngoài khoảng min/max bị chặn', () => {
    const tpl = template(field({ key: 'batteryHealth', type: FIELD_TYPE.NUMBER, min: 0, max: 100 }))

    expect(() => validateAttributes(tpl, { batteryHealth: '120' })).toThrow(BadRequestError)
    expect(() => validateAttributes(tpl, { batteryHealth: '-1' })).toThrow(BadRequestError)
    expect(validateAttributes(tpl, { batteryHealth: '87' }).attributes).toEqual({
      batteryHealth: 87,
    })
  })

  it('chuỗi không phải số ở field number là 400, không phải NaN lọt vào DB', () => {
    const tpl = template(field({ key: 'odo', type: FIELD_TYPE.NUMBER }))
    expect(() => validateAttributes(tpl, { odo: 'nhiều lắm' })).toThrow(BadRequestError)
  })
})

describe('Không tin client — option và key lạ', () => {
  const tpl = template(
    field({
      key: 'condition',
      type: FIELD_TYPE.SELECT,
      options: [
        { value: 'new', label: 'Mới' },
        { value: 'used', label: 'Cũ' },
      ],
    }),
  )

  it('select ngoài danh sách option bị chặn', () => {
    expect(() => validateAttributes(tpl, { condition: 'siêu mới' })).toThrow(BadRequestError)
  })

  it('key không có trong template bị loại hoàn toàn', () => {
    // Người dùng gọi thẳng API được, nên đây là chốt chống nhồi field bịa vào DB.
    const { attributes } = validateAttributes(tpl, { condition: 'new', hackedField: 'xin chào' })
    expect(attributes).toEqual({ condition: 'new' })
  })
})

describe('showIf — field bị ẩn thì required không áp', () => {
  const tpl = template(
    field({
      key: 'vehicleType',
      type: FIELD_TYPE.SELECT,
      options: [
        { value: 'bike', label: 'Xe đạp' },
        { value: 'motorbike', label: 'Xe máy' },
      ],
    }),
    field({
      key: 'engineCc',
      type: FIELD_TYPE.NUMBER,
      required: true,
      order: 20,
      showIf: { key: 'vehicleType', in: ['motorbike'] },
    }),
  )

  it('xe đạp KHÔNG bị đòi dung tích xi-lanh', () => {
    // Ca hỏng kinh điển nếu quên tính visibleFields trước khi xét required.
    expect(() => validateAttributes(tpl, { vehicleType: 'bike' })).not.toThrow()
  })

  it('xe máy thì vẫn bị đòi', () => {
    expect(() => validateAttributes(tpl, { vehicleType: 'motorbike' })).toThrow(BadRequestError)
  })

  it('field ẩn có giá trị thì giá trị đó bị loại, không lưu nhầm', () => {
    const { attributes } = validateAttributes(tpl, { vehicleType: 'bike', engineCc: '150' })
    expect(attributes).toEqual({ vehicleType: 'bike' })
  })

  it('showIf eq so được với boolean dù form gửi chuỗi', () => {
    const warranty = field({ key: 'warranty', type: FIELD_TYPE.BOOLEAN })
    const until = field({ key: 'warrantyUntil', showIf: { key: 'warranty', eq: true } })

    expect(isFieldVisible(until, { warranty: true })).toBe(true)
    expect(isFieldVisible(until, { warranty: 'true' })).toBe(true)
    expect(isFieldVisible(until, { warranty: 'false' })).toBe(false)
    expect(isFieldVisible(warranty, {})).toBe(true)
  })
})

describe('required và giá trị rỗng', () => {
  it('thiếu field bắt buộc là 400', () => {
    const tpl = template(field({ key: 'brand', required: true }))
    expect(() => validateAttributes(tpl, {})).toThrow(BadRequestError)
    expect(() => validateAttributes(tpl, { brand: '' })).toThrow(BadRequestError)
  })

  it('false và 0 là giá trị THẬT, không phải rỗng', () => {
    const tpl = template(
      field({ key: 'warranty', type: FIELD_TYPE.BOOLEAN, required: true }),
      field({ key: 'deposit', type: FIELD_TYPE.NUMBER, required: true, order: 20, min: 0 }),
    )

    // "Ghi 0 nếu không yêu cầu cọc" chỉ đúng khi 0 không bị coi là bỏ trống.
    const { attributes } = validateAttributes(tpl, { warranty: false, deposit: 0 })
    expect(attributes).toEqual({ warranty: false, deposit: 0 })
  })

  it('mảng rỗng của multiselect là bỏ trống', () => {
    const tpl = template(
      field({ key: 'accessories', type: FIELD_TYPE.MULTISELECT, required: true }),
    )
    expect(() => validateAttributes(tpl, { accessories: [] })).toThrow(BadRequestError)
  })
})

describe('attrs — bản phẳng để lọc', () => {
  it('chỉ field filterable mới vào attrs', () => {
    const tpl = template(
      field({ key: 'brand', filterable: true }),
      field({ key: 'color', order: 20 }),
    )
    const { attrs } = validateAttributes(tpl, { brand: 'apple', color: 'đen' })

    // Kỷ luật này là thứ giữ index không phình trên M0 512 MB — xem plan §0.3.
    expect(attrs).toEqual([{ k: 'brand', v: 'apple' }])
  })

  it('multiselect tách thành nhiều phần tử để $elemMatch so được từng giá trị', () => {
    const tpl = template(
      field({
        key: 'amenities',
        type: FIELD_TYPE.MULTISELECT,
        filterable: true,
        options: [
          { value: 'wifi', label: 'Wifi' },
          { value: 'parking', label: 'Chỗ để xe' },
        ],
      }),
    )
    const { attrs } = validateAttributes(tpl, { amenities: ['wifi', 'parking'] })

    expect(attrs).toEqual([
      { k: 'amenities', v: 'wifi' },
      { k: 'amenities', v: 'parking' },
    ])
  })

  it('attrs giữ kiểu đã ép, không phải chuỗi thô', () => {
    const tpl = template(field({ key: 'odo', type: FIELD_TYPE.NUMBER, filterable: true }))
    expect(validateAttributes(tpl, { odo: '15000' }).attrs).toEqual([{ k: 'odo', v: 15000 }])
  })
})
