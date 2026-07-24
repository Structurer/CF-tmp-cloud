import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  Cloud,
  Upload,
  FileUp,
  FolderUp,
  File,
  Download,
  Trash2,
  Plus,
  Folder,
  HardDrive,
  RefreshCw,
  FolderPlus,
  X,
  AlertTriangle,
  Lock,
  Zap,
  CheckCircle,
  XCircle,
  Loader
} from 'lucide-react'

// ============ 常量 ============
const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB
const CONCURRENCY = 3 // 分片并发数
const MAX_RETRIES = 5 // 分片重试次数
const TOTAL_STORAGE = 10 * 1024 * 1024 * 1024 // 10GB 容量上限
const SESSION_EXPIRY = 24 * 60 * 60 * 1000 // 断点续传 24 小时过期

// ============ 工具函数 ============
function formatSize(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function formatDate(isoString) {
  if (!isoString) return '-'
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return '-'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}/${month}/${day} ${hours}:${minutes}`
}

function getFileIcon(fileName) {
  const ext = fileName.split('.').pop().toLowerCase()
  const iconMap = {
    pdf: '📄', doc: '📝', docx: '📝', txt: '📄', md: '📝', json: '📋',
    html: '🌐', css: '🎨', js: '📜', jsx: '⚛️', ts: '📜', tsx: '⚛️',
    py: '🐍', java: '☕', cpp: '💻', c: '💻', zip: '📦', rar: '📦',
    '7z': '📦', tar: '📦', gz: '📦', exe: '⚙️', msi: '⚙️', dmg: '💿',
    apk: '📱', ipa: '📱', jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️',
    webp: '🖼️', svg: '🎨', mp3: '🎵', wav: '🎵', ogg: '🎵', mp4: '🎬',
    avi: '🎬', mov: '🎬', mkv: '🎬', xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📊', pptx: '📊'
  }
  return iconMap[ext] || '📄'
}

// 拼接完整路径（无尾斜杠）
// currentPath="" + name="file.txt" → "file.txt"
// currentPath="folder/sub" + name="file.txt" → "folder/sub/file.txt"
function joinPath(currentPath, name) {
  return currentPath ? currentPath + '/' + name : name
}

// ============ API 封装 ============

// 获取文件列表
async function fetchFileList(path) {
  const url = `/api/list?path=${encodeURIComponent(path)}`
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`列表获取失败: ${resp.status}`)
  }
  return await resp.json()
}

// 创建文件夹
async function createFolderApi(path) {
  const resp = await fetch('/api/create-folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path })
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error || `创建失败: ${resp.status}`)
  }
  return await resp.json()
}

// 删除文件/文件夹
async function deleteItemApi(path, isDirectory) {
  const resp = await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, isDirectory })
  })
  if (!resp.ok) {
    throw new Error(`删除失败: ${resp.status}`)
  }
  return await resp.json()
}

// 验证密码
async function verifyPasswordApi(password) {
  const resp = await fetch('/api/verify-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  })
  return resp
}

// 获取后端配置
async function fetchConfig() {
  try {
    const resp = await fetch('/api/config')
    if (resp.ok) {
      return await resp.json()
    }
  } catch {}
  // 默认值
  return { usePassword: false, capacityLimit: 10 * 1024 * 1024 * 1024 }
}

// ============ 上传函数 ============

// 直传小文件（< 10MB）- 用 XMLHttpRequest 跟踪进度
function directUpload(file, fullPath, onProgress, password) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          resolve({ success: true })
        }
      } else {
        reject(new Error(`上传失败: ${xhr.status}`))
      }
    })
    xhr.addEventListener('error', () => reject(new Error('网络错误')))
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')))
    xhr.open('POST', `/api/upload?path=${encodeURIComponent(fullPath)}`)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    if (password) {
      xhr.setRequestHeader('X-Upload-Password', password)
    }
    xhr.send(file)
  })
}

// 上传单个分片（带重试）
async function uploadPartWithRetry(file, fullPath, uploadId, partNumber) {
  const start = (partNumber - 1) * CHUNK_SIZE
  const end = Math.min(start + CHUNK_SIZE, file.size)
  const chunk = file.slice(start, end)

  let lastError = null
  for (let retry = 0; retry < MAX_RETRIES; retry++) {
    try {
      const resp = await fetch(
        `/api/upload?path=${encodeURIComponent(fullPath)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk
        }
      )
      // 5xx 可重试
      if (resp.status >= 500) {
        throw new Error(`服务器错误: ${resp.status}`)
      }
      // 4xx 不可重试
      if (!resp.ok) {
        const err = new Error(`客户端错误: ${resp.status}`)
        err.noRetry = true
        throw err
      }
      return await resp.json()
    } catch (err) {
      lastError = err
      if (err.noRetry) break
      if (retry < MAX_RETRIES - 1) {
        const delay = 1000 * Math.pow(2, retry) // 1s, 2s, 4s, 8s, 16s
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}

// 分片上传大文件（≥ 10MB）- 支持断点续传
async function multipartUpload(file, fullPath, onProgress, password) {
  const storageKey = `tmp-cloud-upload-${fullPath}`

  // 检查是否有未完成的断点续传会话
  let session = null
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Date.now() - parsed.lastUpdated < SESSION_EXPIRY) {
        session = parsed
      } else {
        localStorage.removeItem(storageKey)
      }
    }
  } catch {
    localStorage.removeItem(storageKey)
  }

  // 初始化新会话
  if (!session) {
    const initResp = await fetch('/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(password ? { 'X-Upload-Password': password } : {})
      },
      body: JSON.stringify({
        action: 'init',
        path: fullPath,
        fileSize: file.size,
        contentType: file.type || 'application/octet-stream'
      })
    })
    if (!initResp.ok) {
      throw new Error('初始化分片上传失败')
    }
    const initData = await initResp.json()
    session = {
      uploadId: initData.uploadId,
      fileSize: file.size,
      completedParts: [],
      totalParts: initData.totalParts,
      lastUpdated: Date.now()
    }
    saveSession(storageKey, session)
  }

  // 计算待上传分片
  const completedSet = new Set(session.completedParts.map((p) => p.partNumber))
  const pendingParts = []
  for (let i = 1; i <= session.totalParts; i++) {
    if (!completedSet.has(i)) {
      pendingParts.push(i)
    }
  }

  // 已上传字节数（用于进度）
  let uploadedBytes = session.completedParts.reduce((sum, p) => sum + p.size, 0)

  // 并发上传分片（3 个并发）
  const queue = []
  for (const partNumber of pendingParts) {
    const partSize = Math.min(CHUNK_SIZE, file.size - (partNumber - 1) * CHUNK_SIZE)
    const promise = uploadPartWithRetry(file, fullPath, session.uploadId, partNumber)
      .then((result) => {
        session.completedParts.push({
          partNumber,
          etag: result.etag,
          size: partSize
        })
        uploadedBytes += partSize
        onProgress(Math.round((uploadedBytes / file.size) * 100))
        session.lastUpdated = Date.now()
        saveSession(storageKey, session)
        queue.splice(queue.indexOf(promise), 1)
      })
      .catch((err) => {
        queue.splice(queue.indexOf(promise), 1)
        throw err
      })
    queue.push(promise)
    if (queue.length >= CONCURRENCY) {
      await Promise.race(queue)
    }
  }
  await Promise.all(queue)

  // 完成分片上传
  const parts = session.completedParts
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => ({
      partNumber: p.partNumber,
      etag: p.etag,
      size: p.size
    }))

  const completeResp = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'complete',
      path: fullPath,
      uploadId: session.uploadId,
      parts
    })
  })

  if (!completeResp.ok) {
    throw new Error('完成分片上传失败')
  }

  // 清理断点续传记录
  localStorage.removeItem(storageKey)
  onProgress(100)
  return await completeResp.json()
}

// 保存断点续传会话
function saveSession(key, session) {
  try {
    localStorage.setItem(key, JSON.stringify(session))
  } catch {
    // localStorage 满了或不可用，忽略
  }
}

// 取消分片上传
async function abortMultipartUpload(fullPath, uploadId) {
  try {
    await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'abort',
        path: fullPath,
        uploadId
      })
    })
  } catch {
    // 忽略取消错误
  }
  localStorage.removeItem(`tmp-cloud-upload-${fullPath}`)
}

// 统一上传入口：根据大小选择直传或分片
async function uploadFile(file, fullPath, onProgress, password) {
  if (file.size < CHUNK_SIZE) {
    return directUpload(file, fullPath, onProgress, password)
  }
  return multipartUpload(file, fullPath, onProgress, password)
}

// ============ UI 组件 ============

function Header({ usedSize, onUploadFile, onUploadFolder, onCreateFolder, onRefresh }) {
  const percentage = TOTAL_STORAGE > 0 ? (usedSize / TOTAL_STORAGE) * 100 : 0
  const isWarning = percentage > 80

  return (
    <header className="bg-white/80 backdrop-blur-xl border-b border-slate-200 sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30">
            <Cloud className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">临时网盘</h1>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-20 h-2.5 bg-slate-200 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-700 ${
                    isWarning ? 'bg-red-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(percentage, 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="p-2.5 bg-slate-100 text-slate-600 rounded-xl font-medium transition-all hover:bg-slate-200 flex items-center gap-1.5"
            title="刷新"
          >
            <RefreshCw className="w-5 h-5" />
          </button>
          <button
            onClick={onUploadFile}
            className="p-2.5 bg-indigo-600 text-white rounded-xl font-medium transition-all hover:bg-indigo-700 hover:scale-105 flex items-center gap-1.5"
            title="上传文件"
          >
            <FileUp className="w-5 h-5" />
          </button>
          <button
            onClick={onUploadFolder}
            className="p-2.5 bg-indigo-600 text-white rounded-xl font-medium transition-all hover:bg-indigo-700 hover:scale-105 flex items-center gap-1.5"
            title="上传文件夹"
          >
            <FolderUp className="w-5 h-5" />
          </button>
          <button
            onClick={onCreateFolder}
            className="p-2.5 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-xl font-medium transition-all hover:from-green-600 hover:to-emerald-600 hover:scale-105 flex items-center gap-1.5"
            title="创建新文件夹"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  )
}

function Navbar({ currentPath, onNavigateTo }) {
  const pathParts = currentPath ? currentPath.split('/').filter((p) => p) : []

  const handlePathClick = (index) => {
    // 点击第 i 段 → 跳转到该层级（无尾斜杠）
    onNavigateTo(pathParts.slice(0, index + 1).join('/'))
  }

  const handleHomeClick = () => {
    onNavigateTo('')
  }

  return (
    <nav className="max-w-6xl mx-auto px-6 py-5">
      <div className="bg-white rounded-xl p-4 shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleHomeClick}
            className="flex items-center gap-1.5 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
          >
            <HardDrive className="w-5 h-5" />
            首页
          </button>
          {pathParts.map((part, index) => (
            <React.Fragment key={index}>
              <span className="text-slate-400">/</span>
              <button
                onClick={() => handlePathClick(index)}
                className="text-slate-600 hover:text-slate-900 transition-colors cursor-pointer"
              >
                {part}
              </button>
            </React.Fragment>
          ))}
        </div>
      </div>
    </nav>
  )
}

function FileItem({ file, fullPath, onDownload, onDelete, onFolderClick }) {
  const isFolder = file.isDirectory

  return (
    <div
      className={`flex items-center gap-4 px-6 py-4 border-b border-slate-100 last:border-b-0 ${
        isFolder ? 'cursor-pointer hover:bg-slate-50' : 'cursor-default'
      }`}
      onClick={() => isFolder && onFolderClick && onFolderClick(file)}
    >
      <div
        className={`w-12 h-12 rounded-xl flex items-center justify-center ${
          isFolder ? 'bg-gradient-to-br from-blue-100 to-indigo-100' : 'bg-slate-100'
        }`}
      >
        {isFolder ? (
          <Folder className="w-6 h-6 text-blue-500" />
        ) : (
          <File className="w-6 h-6 text-slate-600" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className={`font-semibold truncate ${isFolder ? 'text-blue-800' : 'text-slate-800'}`}>
          {isFolder ? file.name : getFileIcon(file.name) + ' ' + file.name}
        </div>
        <div className="flex items-center gap-3 mt-1 text-sm text-slate-500">
          {isFolder ? (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              文件夹
            </span>
          ) : (
            <>
              <span>{formatSize(file.size)}</span>
              <span className="text-slate-300">·</span>
              <span>{formatDate(file.uploaded)}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDownload(file, fullPath)
          }}
          title={isFolder ? '打包下载' : '下载'}
          className="p-2.5 bg-slate-100 text-slate-600 rounded-xl hover:bg-slate-200 transition-colors"
        >
          <Download className="w-5 h-5" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete(file, fullPath)
          }}
          title="删除"
          className="p-2.5 bg-slate-100 text-slate-600 rounded-xl hover:bg-red-50 hover:text-red-500 transition-colors"
        >
          <Trash2 className="w-5 h-5" />
        </button>
      </div>
    </div>
  )
}

function FileList({ files, currentPath, onDownload, onDelete, onFolderClick, isLoading }) {
  if (isLoading) {
    return (
      <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-200">
        <div className="p-12 text-center">
          <RefreshCw className="w-8 h-8 text-blue-500 mx-auto mb-4 animate-spin" />
          <p className="text-slate-500">加载中...</p>
        </div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-200">
        <div className="p-12 text-center">
          <Cloud className="w-16 h-16 text-slate-300 mx-auto mb-4" />
          <p className="text-slate-500">暂无文件</p>
          <p className="text-sm text-slate-400 mt-1">点击右上角按钮上传文件</p>
        </div>
      </div>
    )
  }

  // 前端分组：文件夹在前，文件在后
  const folders = files.filter((f) => f.isDirectory)
  const regularFiles = files.filter((f) => !f.isDirectory)

  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-200">
      <div>
        {folders.map((file) => (
          <FileItem
            key={`dir-${file.name}`}
            file={file}
            fullPath={joinPath(currentPath, file.name)}
            onDownload={onDownload}
            onDelete={onDelete}
            onFolderClick={onFolderClick}
          />
        ))}
        {regularFiles.map((file) => (
          <FileItem
            key={`file-${file.name}`}
            file={file}
            fullPath={joinPath(currentPath, file.name)}
            onDownload={onDownload}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  )
}

function UploadProgress({ progress, fileName, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-96 shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-blue-500 rounded-full flex items-center justify-center">
            <Upload className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1">
            <div className="font-semibold text-slate-800">上传中</div>
            <div className="text-sm text-slate-500 truncate max-w-64">{fileName}</div>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
              title="取消上传"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
        <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="text-right mt-2 text-sm text-slate-500">{progress}%</div>
      </div>
    </div>
  )
}

function CreateFolderModal({ onConfirm, onCancel }) {
  const [folderName, setFolderName] = useState('')

  const handleConfirm = () => {
    if (folderName.trim()) {
      onConfirm(folderName.trim())
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-white rounded-2xl p-6 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-green-100 rounded-xl flex items-center justify-center">
            <FolderPlus className="w-5 h-5 text-green-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800">新建文件夹</h3>
            <p className="text-sm text-slate-500">创建一个新的文件夹</p>
          </div>
        </div>
        <input
          type="text"
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          placeholder="输入文件夹名称"
          className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all text-slate-700"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm()
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            className="px-5 py-2.5 text-slate-600 hover:text-slate-800 font-medium transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!folderName.trim()}
            className="px-5 py-2.5 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-xl font-medium transition-all hover:from-green-600 hover:to-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )
}

function PasswordModal({ totalNeeded, onConfirm, onCancel }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const handleConfirm = async () => {
    if (!password) {
      setError('请输入密码')
      return
    }
    setError('')
    await onConfirm(password)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-white rounded-2xl p-6 w-96 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center">
            <Lock className="w-5 h-5 text-amber-500" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800">需要密码验证</h3>
            <p className="text-sm text-slate-500">
              上传后将超过 10GB 容量限制，请输入密码继续
            </p>
          </div>
        </div>
        {error && (
          <div className="mb-3 px-3 py-2 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>
        )}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="输入密码"
          className="w-full px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all text-slate-700"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConfirm()
            if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            className="px-5 py-2.5 text-slate-600 hover:text-slate-800 font-medium transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-5 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl font-medium transition-all hover:from-amber-600 hover:to-orange-600"
          >
            验证
          </button>
        </div>
      </div>
    </div>
  )
}

// 传输进度面板（上传/下载记录）
function TransferPanel({
  activeTab,
  onTabChange,
  uploadTasks,
  downloadHistory,
  onClear,
  onClose
}) {
  const renderUploadTask = (task) => {
    const statusIcon =
      task.status === 'uploading' ? (
        <Loader className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
      ) : task.status === 'completed' ? (
        <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
      ) : (
        <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
      )

    return (
      <div key={task.id} className="px-4 py-3 border-b border-slate-100 last:border-b-0">
        <div className="flex items-center gap-2 mb-1">
          {statusIcon}
          <span className="text-sm text-slate-700 truncate flex-1">{task.fileName}</span>
          <span className="text-xs text-slate-400 flex-shrink-0">{task.timeStr}</span>
        </div>
        {task.status === 'uploading' && (
          <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden mt-2">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        )}
        {task.status === 'failed' && task.error && (
          <div className="text-xs text-red-500 mt-1 truncate">{task.error}</div>
        )}
      </div>
    )
  }

  const renderDownloadRecord = (record) => (
    <div key={record.id} className="px-4 py-3 border-b border-slate-100 last:border-b-0">
      <div className="flex items-center gap-2">
        <Download className="w-4 h-4 text-green-500 flex-shrink-0" />
        <span className="text-sm text-slate-700 truncate flex-1">{record.fileName}</span>
        <span className="text-xs text-slate-400 flex-shrink-0">{record.timeStr}</span>
      </div>
    </div>
  )

  const uploadCount = uploadTasks.filter((t) => t.status === 'uploading').length

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[420px] max-h-[600px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="bg-gradient-to-r from-blue-500 to-indigo-600 px-5 py-4 flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5" />
            传输进度
            {uploadCount > 0 && (
              <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">
                {uploadCount} 个进行中
              </span>
            )}
          </h3>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 标签页 */}
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => onTabChange('upload')}
            className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
              activeTab === 'upload'
                ? 'text-blue-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            上传
            {uploadCount > 0 && (
              <span className="ml-1 bg-blue-500 text-white text-xs px-1.5 py-0.5 rounded-full">
                {uploadCount}
              </span>
            )}
            {activeTab === 'upload' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
            )}
          </button>
          <button
            onClick={() => onTabChange('download')}
            className={`flex-1 py-3 text-sm font-medium transition-colors relative ${
              activeTab === 'download'
                ? 'text-blue-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            下载
            {activeTab === 'download' && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
            )}
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {activeTab === 'upload' ? (
            uploadTasks.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-sm">暂无上传任务</div>
            ) : (
              uploadTasks.map(renderUploadTask)
            )
          ) : downloadHistory.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-sm">暂无下载记录</div>
          ) : (
            downloadHistory.map(renderDownloadRecord)
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="px-4 py-3 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClear}
            className="px-4 py-2 text-sm text-slate-500 hover:text-red-500 transition-colors"
          >
            清空记录
          </button>
        </div>
      </div>
    </div>
  )
}

// ============ App 主组件 ============
function App() {
  const [files, setFiles] = useState([])
  const [totalUsed, setTotalUsed] = useState(0)
  const [currentPath, setCurrentPath] = useState('') // 无尾斜杠，根目录为 ''
  const [isLoading, setIsLoading] = useState(true)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadFileName, setUploadFileName] = useState('')
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [pendingUpload, setPendingUpload] = useState(null) // { files, isFolder }
  const uploadPasswordRef = useRef('') // 存储验证过的密码，供上传时携带
  const [errorMessage, setErrorMessage] = useState('')
  const [appConfig, setAppConfig] = useState({ usePassword: false, capacityLimit: 10 * 1024 * 1024 * 1024 })
  const [showTransferPanel, setShowTransferPanel] = useState(false)
  const [transferTab, setTransferTab] = useState('upload') // 'upload' | 'download'
  const [uploadTasks, setUploadTasks] = useState(() => {
    try {
      const saved = localStorage.getItem('tmp-cloud-upload-tasks')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [downloadHistory, setDownloadHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('tmp-cloud-download-history')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })

  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  const cancelUploadRef = useRef(false)
  const currentUploadXhrRef = useRef(null)
  const currentPathRef = useRef('')

  // 加载文件列表
  const loadFiles = useCallback(async (path) => {
    setIsLoading(true)
    try {
      const data = await fetchFileList(path)
      setFiles(data.files || [])
      setTotalUsed(data.totalUsed || 0)
    } catch (error) {
      console.error('加载文件列表失败:', error)
      setFiles([])
      setTotalUsed(0)
    }
    setIsLoading(false)
  }, [])

  // 持久化传输记录
  useEffect(() => {
    try {
      // 只保存已完成/失败的任务，不保存进行中的
      const toSave = uploadTasks.filter(t => t.status !== 'uploading')
      localStorage.setItem('tmp-cloud-upload-tasks', JSON.stringify(toSave.slice(-50))) // 最多 50 条
    } catch {}
  }, [uploadTasks])

  useEffect(() => {
    try {
      localStorage.setItem('tmp-cloud-download-history', JSON.stringify(downloadHistory.slice(-50)))
    } catch {}
  }, [downloadHistory])

  // 路径变化时重新加载
  useEffect(() => {
    loadFiles(currentPath)
  }, [currentPath, loadFiles])

  // 保持 currentPathRef 与 currentPath 同步，供后台上传使用
  useEffect(() => {
    currentPathRef.current = currentPath
  }, [currentPath])

  // 设置文件夹选择器的 webkitdirectory 属性
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '')
      folderInputRef.current.setAttribute('directory', '')
    }
  }, [])

  // 初始化时加载后端配置
  useEffect(() => {
    fetchConfig().then(cfg => setAppConfig(cfg))
  }, [])

  // ============ 上传处理 ============

  // 检查容量是否超限，决定是否需要密码
  const checkCapacityAndUpload = async (fileList, isFolder) => {
    const newFilesSize = Array.from(fileList).reduce((sum, f) => sum + f.size, 0)
    const projectedTotal = totalUsed + newFilesSize
    const limit = appConfig.capacityLimit || TOTAL_STORAGE

    // 超过容量上限
    if (projectedTotal > limit) {
      if (appConfig.usePassword) {
        // 启用密码保护：弹出密码验证框
        if (!uploadPasswordRef.current) {
          setPendingUpload({ files: fileList, isFolder })
          setShowPasswordModal(true)
          return
        }
      } else {
        // 未启用密码保护：直接拒绝
        setErrorMessage(`容量超限：当前已用 ${formatSize(totalUsed)}，本次将上传 ${formatSize(newFilesSize)}，超过 ${formatSize(limit)} 上限`)
        return
      }
    }

    await performUpload(fileList, isFolder)
  }

  // 执行上传
  const performUpload = async (fileList, isFolder) => {
    setIsUploading(true)
    cancelUploadRef.current = false

    // 捕获上传时的路径，用于后台刷新判断
    const uploadPath = currentPath

    const filesArray = Array.from(fileList)
    const totalSize = filesArray.reduce((sum, f) => sum + f.size, 0)
    let uploadedSize = 0
    const failedFiles = []

    // 收集文件夹上传时需要创建的空文件夹
    if (isFolder) {
      const folderPaths = new Set()
      for (const file of filesArray) {
        const relativePath = file.webkitRelativePath || file.name
        const parts = relativePath.split('/')
        parts.pop() // 移除文件名
        let current = currentPath
        for (const part of parts) {
          current = current ? current + '/' + part : part
          folderPaths.add(current)
        }
      }
      // 创建所有文件夹（确保空文件夹也能显示）
      for (const folderPath of folderPaths) {
        try {
          await createFolderApi(folderPath)
        } catch {
          // 文件夹可能已存在，忽略错误
        }
      }
    }

    // 逐个上传文件
    for (let i = 0; i < filesArray.length; i++) {
      if (cancelUploadRef.current) break

      const file = filesArray[i]
      let fullPath

      if (isFolder) {
        // 文件夹上传：用 webkitRelativePath 拼接完整路径
        const relativePath = file.webkitRelativePath || file.name
        fullPath = currentPath ? currentPath + '/' + relativePath : relativePath
      } else {
        // 单文件上传
        fullPath = joinPath(currentPath, file.name)
      }

      const displayName = isFolder ? (file.webkitRelativePath || file.name) : file.name
      setUploadFileName(displayName)

      // 创建上传任务记录
      const taskId = `upload-${Date.now()}-${i}`
      const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      setUploadTasks(prev => [{
        id: taskId,
        fileName: displayName,
        progress: 0,
        status: 'uploading',
        timeStr
      }, ...prev])

      try {
        await uploadFile(file, fullPath, (percent) => {
          const fileUploaded = file.size * percent / 100
          const overall = totalSize > 0
            ? Math.round(((uploadedSize + fileUploaded) / totalSize) * 100)
            : 100
          setUploadProgress(overall)
          // 更新任务进度
          setUploadTasks(prev => prev.map(t =>
            t.id === taskId ? { ...t, progress: percent } : t
          ))
        }, uploadPasswordRef.current)
        uploadedSize += file.size
        // 标记任务完成
        setUploadTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: 'completed', progress: 100 } : t
        ))
      } catch (error) {
        console.error(`上传失败: ${file.name}`, error)
        failedFiles.push(file.name)
        uploadedSize += file.size
        // 标记任务失败
        setUploadTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: 'failed', error: error.message } : t
        ))
      }
    }

    setUploadProgress(100)

    // 刷新列表：仅在用户仍停留在上传时的目录时才刷新
    // 如果用户已导航到其他目录，不干扰当前视图（上传在后台完成）
    if (currentPathRef.current === uploadPath) {
      await loadFiles(uploadPath)
    }

    setIsUploading(false)
    setUploadProgress(0)
    setUploadFileName('')

    if (fileInputRef.current) fileInputRef.current.value = ''
    if (folderInputRef.current) folderInputRef.current.value = ''

    if (failedFiles.length > 0) {
      setErrorMessage(`以下文件上传失败: ${failedFiles.join(', ')}`)
    }
  }

  const handleFileUpload = (e) => {
    const uploadedFiles = e.target.files
    if (!uploadedFiles || uploadedFiles.length === 0) return
    checkCapacityAndUpload(uploadedFiles, false)
  }

  const handleFolderUpload = (e) => {
    const uploadedFiles = e.target.files
    if (!uploadedFiles || uploadedFiles.length === 0) return
    checkCapacityAndUpload(uploadedFiles, true)
  }

  const handleCancelUpload = () => {
    cancelUploadRef.current = true
    if (currentUploadXhrRef.current) {
      currentUploadXhrRef.current.abort()
    }
  }

  // ============ 密码验证 ============

  const handlePasswordConfirm = async (password) => {
    try {
      const resp = await verifyPasswordApi(password)
      if (resp.ok) {
        uploadPasswordRef.current = password // 保存密码供后续上传使用
        setShowPasswordModal(false)
        if (pendingUpload) {
          await performUpload(pendingUpload.files, pendingUpload.isFolder)
          setPendingUpload(null)
        }
      } else {
        const data = await resp.json().catch(() => ({}))
        setErrorMessage(data.error || '密码错误')
      }
    } catch (error) {
      setErrorMessage('密码验证失败: ' + error.message)
    }
  }

  const handlePasswordCancel = () => {
    setShowPasswordModal(false)
    setPendingUpload(null)
  }

  // ============ 下载 ============

  const handleDownload = (file, fullPath) => {
    // 记录下载历史
    const record = {
      id: `download-${Date.now()}`,
      fileName: file.isDirectory ? `${file.name}.zip` : file.name,
      timeStr: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    setDownloadHistory(prev => [record, ...prev].slice(0, 50))

    if (file.isDirectory) {
      // 文件夹下载：整页跳转，触发 ZIP 下载
      window.location.href = `/api/download?path=${encodeURIComponent(fullPath)}&type=folder`
    } else {
      // 文件下载：用 a 标签触发
      const link = document.createElement('a')
      link.href = `/api/download?path=${encodeURIComponent(fullPath)}`
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    }
  }

  // ============ 删除 ============

  const handleDelete = async (file, fullPath) => {
    if (!confirm(`确定要删除${file.isDirectory ? '文件夹' : '文件'} "${file.name}" 吗？`)) {
      return
    }

    try {
      await deleteItemApi(fullPath, file.isDirectory)
      await loadFiles(currentPath)
    } catch (error) {
      console.error('删除失败:', error)
      setErrorMessage('删除失败: ' + error.message)
    }
  }

  // ============ 创建文件夹 ============

  const handleCreateFolder = () => {
    setShowCreateFolderModal(true)
  }

  const handleCreateFolderConfirm = async (folderName) => {
    const fullPath = joinPath(currentPath, folderName)
    try {
      await createFolderApi(fullPath)
      setShowCreateFolderModal(false)
      await loadFiles(currentPath)
    } catch (error) {
      console.error('创建文件夹失败:', error)
      setErrorMessage('创建文件夹失败: ' + error.message)
    }
  }

  // ============ 导航 ============

  const handleFolderClick = (folder) => {
    // 进入子文件夹（无尾斜杠）
    setCurrentPath(joinPath(currentPath, folder.name))
  }

  const handleNavigateTo = (path) => {
    setCurrentPath(path)
  }

  const handleRefresh = () => {
    loadFiles(currentPath)
  }

  const handleHeaderUploadFile = () => {
    fileInputRef.current?.click()
  }

  const handleHeaderUploadFolder = () => {
    folderInputRef.current?.click()
  }

  const handleQuickUpload = () => {
    fileInputRef.current?.click()
  }

  const handleOpenTransferPanel = () => {
    setShowTransferPanel(true)
  }

  const handleClearTransfer = () => {
    if (transferTab === 'upload') {
      // 清空已完成/失败的上传任务，保留进行中的
      setUploadTasks(prev => prev.filter(t => t.status === 'uploading'))
    } else {
      setDownloadHistory([])
    }
  }

  const handleErrorDismiss = () => {
    setErrorMessage('')
  }

  // ============ 渲染 ============
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50">
      <Header
        usedSize={totalUsed}
        onUploadFile={handleHeaderUploadFile}
        onUploadFolder={handleHeaderUploadFolder}
        onCreateFolder={handleCreateFolder}
        onRefresh={handleRefresh}
      />
      <Navbar currentPath={currentPath} onNavigateTo={handleNavigateTo} />
      <main className="max-w-6xl mx-auto px-6 pb-24">
        <FileList
          files={files}
          currentPath={currentPath}
          onDownload={handleDownload}
          onDelete={handleDelete}
          onFolderClick={handleFolderClick}
          isLoading={isLoading}
        />
      </main>

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileUpload}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFolderUpload}
      />

      {/* 传输记录按钮（右下角闪电图标） */}
      <button
        onClick={handleOpenTransferPanel}
        className="fixed bottom-6 right-6 w-14 h-14 bg-gradient-to-br from-blue-500 to-blue-600 text-white rounded-full shadow-lg shadow-blue-500/40 z-50 transition-all hover:scale-110 hover:shadow-xl flex items-center justify-center"
        title="传输进度"
      >
        {isUploading ? (
          <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <Zap className="w-6 h-6" />
        )}
        {/* 进行中任务数量角标 */}
        {uploadTasks.filter(t => t.status === 'uploading').length > 0 && !isUploading && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
            {uploadTasks.filter(t => t.status === 'uploading').length}
          </span>
        )}
      </button>

      {/* 传输进度面板 */}
      {showTransferPanel && (
        <TransferPanel
          activeTab={transferTab}
          onTabChange={setTransferTab}
          uploadTasks={uploadTasks}
          downloadHistory={downloadHistory}
          onClear={handleClearTransfer}
          onClose={() => setShowTransferPanel(false)}
        />
      )}

      {/* 创建文件夹弹窗 */}
      {showCreateFolderModal && (
        <CreateFolderModal
          onConfirm={handleCreateFolderConfirm}
          onCancel={() => setShowCreateFolderModal(false)}
        />
      )}

      {/* 密码验证弹窗 */}
      {showPasswordModal && (
        <PasswordModal
          onConfirm={handlePasswordConfirm}
          onCancel={handlePasswordCancel}
        />
      )}

      {/* 错误提示 */}
      {errorMessage && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] max-w-md">
          <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 shadow-lg flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 text-sm text-red-700">{errorMessage}</div>
            <button
              onClick={handleErrorDismiss}
              className="text-red-400 hover:text-red-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
