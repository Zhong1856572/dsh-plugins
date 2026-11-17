/**
 * 极简 ZIP 读写（无第三方依赖）
 * ---------------------------------------------------------------------------
 * 只做 OOXML 需要的两件事：
 *   1) readZip(buffer)  → 按顺序读出全部条目（name + data:Buffer）
 *   2) writeZip(entries) → 生成新的 zip（deflate 压缩）
 *
 * 不支持 zip64（OOXML 业务文件不会用到）；不写目录条目（Excel 不需要）。
 */

import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** @param {Buffer} buf @returns {number} */
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/**
 * 读取 zip。
 * @param {Buffer} buffer
 * @returns {{ entries: Array<{name: string, data: Buffer}>, byName: Map<string, Buffer> }}
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readZip 需要 Buffer')
  if (buffer.length < 22) throw new Error('文件太小，不是有效的 zip 包')

  // 倒着找 EOCD（注释最长 65535 字节）
  let eocd = -1
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 包：找不到中央目录结尾记录')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const cdSize = buffer.readUInt32LE(eocd + 12)
  const cdOffset = buffer.readUInt32LE(eocd + 16)

  const entries = []
  const byName = new Map()
  let ptr = cdOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(ptr) !== SIG_CENTRAL) {
      throw new Error(`中央目录第 ${i + 1} 项签名不正确`)
    }
    const method = buffer.readUInt16LE(ptr + 10)
    const compressedSize = buffer.readUInt32LE(ptr + 20)
    const uncompressedSize = buffer.readUInt32LE(ptr + 24)
    const nameLen = buffer.readUInt16LE(ptr + 28)
    const extraLen = buffer.readUInt16LE(ptr + 30)
    const commentLen = buffer.readUInt16LE(ptr + 32)
    const localOffset = buffer.readUInt32LE(ptr + 42)
    const name = buffer.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8')

    // 读本地头拿到数据真实起点
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`条目 ${name} 的本地头签名不正确`)
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.slice(dataStart, dataStart + compressedSize)

    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      data = zlib.inflateRawSync(raw)
    } else {
      throw new Error(`条目 ${name} 使用了不支持的压缩方式：${method}`)
    }
    if (uncompressedSize && data.length !== uncompressedSize) {
      // 尺寸对不上时按实际数据为准，不直接失败（少数文件头写得不严谨）
      data = data.slice(0, Math.min(data.length, uncompressedSize))
    }

    if (!name.endsWith('/')) {
      entries.push({ name, data })
      byName.set(name, data)
    }

    ptr += 46 + nameLen + extraLen + commentLen
  }
  if (cdSize < 0) throw new Error('中央目录长度异常')
  return { entries, byName }
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time: time & 0xffff, date: day & 0xffff }
}

/**
 * 写 zip。
 * @param {Array<{name: string, data: Buffer}>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const { time, date } = dosDateTime(new Date())
  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const compressed = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = compressed.length < data.length
    const payload = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, nameBuf, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra len
    central.writeUInt16LE(0, 32) // comment len
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const cd = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, cd, eocd])
}
