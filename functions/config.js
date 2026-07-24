/**
 * 网盘配置文件
 * 部署前可调整以下配置项
 */

export const config = {
  // 是否启用密码保护
  // false: 不需要密码即可上传，但总容量严格限制在 10GB 以内（超限直接拒绝上传）
  // true:  需要配置 PASSWORD 环境变量才能上传；
  //        当 totalUsed + fileSize ≤ 10GB 时免密上传；
  //        当 totalUsed + fileSize >  10GB 时需要输入密码验证后才可上传
  USE_PASSWORD: false,

  // 容量上限（字节）
  // 默认 10GB
  CAPACITY_LIMIT: 10 * 1024 * 1024 * 1024
}
