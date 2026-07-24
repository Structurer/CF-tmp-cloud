# 临时网盘 - TMP Cloud

一个基于 Cloudflare Pages + R2 的轻量级个人网盘应用，支持文件上传、下载、管理及文件夹操作。

## ✨ 功能特性

### 文件管理
- **文件上传**：支持拖拽上传，小文件直传、大文件分片上传（10MB 切片，支持断点续传）
- **文件夹上传**：保留目录结构，支持多层级文件夹
- **文件下载**：单文件直链下载，文件夹打包 ZIP 下载
- **文件删除**：单个文件删除，文件夹递归删除（幂等操作）
- **创建文件夹**：自定义命名创建空文件夹
- **目录浏览**：导航栏路径跳转，文件夹点击进入子目录

### 容量与安全
- **容量限制**：默认 10GB 容量上限，容量条实时显示使用情况
- **密码保护**：超过容量上限时需输入密码验证后方可继续上传
- **CORS 支持**：全量跨域支持，支持前后端分离部署

### 传输管理
- **实时进度**：上传/下载实时进度展示
- **传输面板**：右下角闪电按钮查看传输记录
- **上传历史**：自动保存上传/下载记录，支持本地持久化
- **后台上传**：上传过程中可自由浏览其他目录，不中断上传

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | React 18 + Vite 5 |
| 样式方案 | TailwindCSS 3.4 |
| 图标库 | Lucide React |
| 后端运行时 | Cloudflare Pages Functions |
| 对象存储 | Cloudflare R2 |
| 部署平台 | Cloudflare Pages |

## 📁 项目结构

```
.
├── functions/              # Pages Functions（后端 API）
│   ├── _middleware.js      # CORS 中间件
│   └── api/
│       ├── list.js         # GET  /api/list         文件列表
│       ├── upload.js       # POST /api/upload       上传（直传 + 分片）
│       ├── delete.js       # POST /api/delete       删除
│       ├── create-folder.js# POST /api/create-folder 创建文件夹
│       ├── download.js     # GET  /api/download     下载（文件/文件夹 ZIP）
│       └── verify-password.js # POST /api/verify-password 密码验证
├── public/                 # 静态资源
│   └── favicon.png         # 网站图标
├── src/                    # 前端源码
│   ├── App.jsx             # 主组件
│   ├── main.jsx            # 入口文件
│   └── index.css           # 全局样式
├── index.html              # HTML 模板
├── vite.config.js          # Vite 配置
├── tailwind.config.js      # TailwindCSS 配置
├── postcss.config.js       # PostCSS 配置
├── wrangler.toml           # Wrangler 部署配置
└── package.json            # 项目依赖
```

## 🚀 快速开始

### 环境要求
- Node.js 18+
- Cloudflare 账号
- Cloudflare R2 存储桶

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 构建部署

```bash
# 构建生产版本
npm run build

# 部署到 Cloudflare Pages
npx wrangler pages deploy dist
```

## 🔧 环境变量

在 Cloudflare Pages 项目设置中配置以下环境变量：

| 变量名 | 类型 | 说明 |
|--------|------|------|
| `R2_BUCKET` | R2 绑定 | 存储桶名称（必须在 `wrangler.toml` 或 Pages 绑定中配置） |
| `PASSWORD` | 密钥 | 上传密码。**未配置时完全禁止上传** |

### 密码策略
- `PASSWORD` 未配置 → 所有上传请求返回 403，禁止上传
- `PASSWORD` 已配置且 `totalUsed + fileSize ≤ 10GB` → 允许上传
- `PASSWORD` 已配置且 `totalUsed + fileSize > 10GB` → 需验证密码

## 📡 API 文档

### 1. 文件列表

```
GET /api/list?path={path}
```

**查询参数：**
- `path`：目录路径（无尾斜杠，根目录为空字符串）

**响应：**
```json
{
  "files": [
    {
      "name": "filename.txt",
      "isDirectory": false,
      "size": 1024,
      "uploaded": "2024-01-01T00:00:00.000Z"
    }
  ],
  "totalUsed": 1048576
}
```

### 2. 文件上传

支持两种模式，所有上传请求携带 `X-Upload-Password` header（超过容量时需要）。

#### 直传小文件（< 10MB）
```
POST /api/upload?path={path}
Content-Type: <file-type>
X-Upload-Password: <password>（可选）

<raw binary data>
```

#### 分片上传（≥ 10MB）

**初始化：**
```
POST /api/upload
Content-Type: application/json
X-Upload-Password: <password>（可选）

{ "action": "init", "path": "folder/file.zip", "fileSize": 52428800, "contentType": "application/zip" }
```

**上传分片：**
```
POST /api/upload?path={path}&uploadId={uploadId}&partNumber={partNumber}
Content-Type: application/octet-stream

<raw chunk data>
```

**完成上传：**
```
POST /api/upload
Content-Type: application/json

{ "action": "complete", "path": "folder/file.zip", "uploadId": "...", "parts": [{ "partNumber": 1, "etag": "..." }] }
```

**取消上传：**
```
POST /api/upload
Content-Type: application/json

{ "action": "abort", "path": "folder/file.zip", "uploadId": "..." }
```

### 3. 删除

```
POST /api/delete
Content-Type: application/json

{ "path": "folder/file.txt", "isDirectory": false }
```

### 4. 创建文件夹

```
POST /api/create-folder
Content-Type: application/json

{ "path": "new-folder" }
```

### 5. 下载

```
GET /api/download?path={path}&type=file|folder
```

- `type=file`：文件直链下载
- `type=folder`：文件夹打包为 ZIP 下载

### 6. 密码验证

```
POST /api/verify-password
Content-Type: application/json

{ "password": "your-password" }
```

**响应：**
- `200 OK` → `{ "success": true }`
- `401 Unauthorized` → `{ "error": "密码错误" }`
- `403 Forbidden` → `{ "error": "未配置密码，禁止上传" }`

## 📝 License

MIT
