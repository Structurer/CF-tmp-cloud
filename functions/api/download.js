// GET /api/download?path={path}&type={type}
// 路径格式：无尾斜杠
// 行为：
//   - type=folder：列出 path/ 下所有对象，打包成 ZIP 返回
//   - 其他/未指定：从 R2 取出对应对象，直接返回二进制流
//
// 文件夹下载使用 STORE 方式打包（无压缩），因为 R2 中多为已压缩的二进制文件
// ZIP 结构：本地文件头 + 文件数据 + 中央目录 + 中央目录结束记录

export async function onRequestGet(context) {
  const { R2_BUCKET } = context.env
  const { request } = context
  const url = new URL(request.url)
  const path = url.searchParams.get('path') || ''
  const type = url.searchParams.get('type') || ''

  if (!R2_BUCKET) {
    return new Response(JSON.stringify({ error: 'R2_BUCKET not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  if (!path) {
    return new Response(JSON.stringify({ error: 'path is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    // 文件夹下载：type=folder
    if (type === 'folder') {
      return await downloadFolder(R2_BUCKET, path)
    }

    // 文件下载
    return await downloadFile(R2_BUCKET, path)
  } catch (error) {
    console.error('Download error:', error)
    return new Response(
      JSON.stringify({ error: 'Failed to download: ' + error.message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  }
}

// 下载单个文件
async function downloadFile(bucket, path) {
  const object = await bucket.get(path)

  if (!object) {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const fileName = path.split('/').pop() || 'download'

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      'Content-Length': object.size
    }
  })
}

// 下载文件夹（打包 ZIP）
async function downloadFolder(bucket, path) {
  // 列出文件夹下所有对象（prefix = path + '/'）
  const prefix = path + '/'
  const allObjects = []
  let cursor = null

  do {
    const listOpts = { prefix: prefix }
    if (cursor) {
      listOpts.cursor = cursor
    }
    const result = await bucket.list(listOpts)

    for (const obj of result.objects || []) {
      // 跳过文件夹占位符
      if (obj.key.endsWith('/') && obj.size === 0) {
        continue
      }
      allObjects.push(obj)
    }

    cursor = result.cursor
  } while (cursor)

  // 读取所有文件内容
  const files = []
  for (const obj of allObjects) {
    // ZIP 内的相对路径：去掉 prefix
    const relativePath = obj.key.slice(prefix.length)
    if (!relativePath) continue

    const objContent = await bucket.get(obj.key)
    if (!objContent) continue

    const arrayBuffer = await objContent.arrayBuffer()
    files.push({
      name: relativePath,
      data: new Uint8Array(arrayBuffer),
      size: obj.size
    })
  }

  // 打包成 ZIP
  const folderName = path.split('/').pop() || 'download'
  const zipBuffer = createZip(files)

  return new Response(zipBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(folderName)}.zip"`,
      'Content-Length': zipBuffer.byteLength
    }
  })
}

// ============ ZIP 打包实现（STORE 模式，无压缩） ============

function createZip(files) {
  const encoder = new TextEncoder()
  const parts = []
  const centralDirectory = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.name)

    // 本地文件头
    const localFileHeader = createLocalFileHeader(nameBytes, file.size)
    parts.push(localFileHeader)
    const localHeaderOffset = offset
    offset += localFileHeader.length

    // 文件数据
    parts.push(file.data)
    offset += file.data.length

    // 中央目录条目
    const cdEntry = createCentralDirectoryEntry(nameBytes, file.size, localHeaderOffset)
    centralDirectory.push(cdEntry)
  }

  // 写入中央目录
  let centralDirSize = 0
  for (const entry of centralDirectory) {
    parts.push(entry)
    centralDirSize += entry.length
  }

  const centralDirOffset = offset

  // 中央目录结束记录
  const endOfCentralDir = createEndOfCentralDirectory(
    files.length,
    centralDirSize,
    centralDirOffset
  )
  parts.push(endOfCentralDir)

  // 合并所有部分
  let totalSize = 0
  for (const part of parts) {
    totalSize += part.length
  }

  const result = new Uint8Array(totalSize)
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }

  return result.buffer
}

// 本地文件头（Local File Header）
function createLocalFileHeader(nameBytes, size) {
  const buffer = new Uint8Array(30 + nameBytes.length)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, 0x04034b50, true) // 签名
  view.setUint16(4, 20, true)         // 解压所需版本
  view.setUint16(6, 0x0800, true)     // 通用标志位（UTF-8 文件名）
  view.setUint16(8, 0, true)          // 压缩方式（0 = STORE）
  view.setUint16(10, 0, true)         // 最后修改时间
  view.setUint16(12, 0, true)         // 最后修改日期
  view.setUint32(14, 0, true)         // CRC-32（未计算，填 0）
  view.setUint32(18, size, true)      // 压缩后大小
  view.setUint32(22, size, true)      // 原始大小
  view.setUint16(26, nameBytes.length, true) // 文件名长度
  view.setUint16(28, 0, true)         // 额外字段长度

  buffer.set(nameBytes, 30)

  return buffer
}

// 中央目录条目（Central Directory Entry）
function createCentralDirectoryEntry(nameBytes, size, localOffset) {
  const buffer = new Uint8Array(46 + nameBytes.length)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, 0x02014b50, true) // 签名
  view.setUint16(4, 20, true)         // 制作版本
  view.setUint16(6, 20, true)         // 解压所需版本
  view.setUint16(8, 0x0800, true)     // 通用标志位（UTF-8 文件名）
  view.setUint16(10, 0, true)         // 压缩方法（0 = STORE）
  view.setUint16(12, 0, true)         // 最后修改时间
  view.setUint16(14, 0, true)         // 最后修改日期
  view.setUint32(16, 0, true)         // CRC-32（未计算）
  view.setUint32(20, size, true)      // 压缩后大小
  view.setUint32(24, size, true)      // 原始大小
  view.setUint16(28, nameBytes.length, true) // 文件名长度
  view.setUint16(30, 0, true)         // 额外字段长度
  view.setUint16(32, 0, true)         // 文件注释长度
  view.setUint16(34, 0, true)         // 起始磁盘号
  view.setUint16(36, 0, true)         // 内部文件属性
  view.setUint32(38, 0, true)         // 外部文件属性
  view.setUint32(42, localOffset, true) // 本地文件头相对偏移

  buffer.set(nameBytes, 46)

  return buffer
}

// 中央目录结束记录（End of Central Directory Record）
function createEndOfCentralDirectory(numEntries, centralDirSize, centralDirOffset) {
  const buffer = new Uint8Array(22)
  const view = new DataView(buffer.buffer)

  view.setUint32(0, 0x06054b50, true)            // 签名
  view.setUint16(4, 0, true)                     // 当前磁盘号
  view.setUint16(6, 0, true)                     // 中央目录起始磁盘号
  view.setUint16(8, numEntries, true)            // 当前磁盘上的中央目录条目数
  view.setUint16(10, numEntries, true)           // 中央目录总条目数
  view.setUint32(12, centralDirSize, true)       // 中央目录大小
  view.setUint32(16, centralDirOffset, true)     // 中央目录起始偏移
  view.setUint16(20, 0, true)                    // 注释长度

  return buffer
}
