/**
 * 图片基本信息（尺寸 / 类型）
 * ---------------------------------------------------------------------------
 * 只用文件头判断，不解码整图，几十张图也是毫秒级。
 */

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

/** Excel / 浏览器都能显示的类型 */
export const EXCEL_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/x-emf',
  'image/x-wmf',
])

/** @param {string} name @returns {string} 小写扩展名（不含点） */
export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

/** @param {string} name @returns {string} mime */
export function mimeOf(name) {
  return MIME_BY_EXT[extOf(name)] || 'application/octet-stream'
}

/**
 * 读取图片像素尺寸。
 * @param {Buffer} buf
 * @returns {{width:number,height:number}|null}
 */
export function imageSize(buf) {
  if (!buf || buf.length < 16) return null

  // PNG: IHDR
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // GIF: header + logical screen descriptor
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }

  // BMP
  if (buf.slice(0, 2).toString('latin1') === 'BM' && buf.length > 26) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
  }

  // JPEG: walk segments to SOFn
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buf[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buf.readUInt16BE(offset + 2)
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
      }
      offset += 2 + length
    }
  }

  // WEBP
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('latin1')
    if (chunk === 'VP8 ' && buf.length > 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buf.length > 25) {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X' && buf.length > 30) {
      return {
        width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
      }
    }
  }

  return null
}
