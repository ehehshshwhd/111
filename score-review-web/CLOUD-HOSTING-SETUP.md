# CloudBase 云托管部署

仓库根目录已提供 `Dockerfile`，容器会启动网页和同源 API，并读取微信小程序当前使用的 `work_records` 集合。容器不需要暴露数据库密钥；CloudBase 云托管的 Node SDK 集成身份会负责服务端数据库访问。

## 云托管控制台设置

1. 在云托管中从 GitHub 创建服务，仓库选 `ehehshshwhd/111`，分支选 `feature/cloud-hosting`。
2. 构建上下文选仓库根目录，Dockerfile 路径填写 `Dockerfile`。容器监听端口为 `8080`，由平台的 `PORT` 环境变量覆盖也可以。
3. 给服务配置以下环境变量：

   - `SCORE_REVIEW_PASSWORD`：网页管理员登录密码。
   - `SCORE_REVIEW_SESSION_SECRET`：独立随机长字符串，至少 32 个字符。
   - `SCORE_REVIEW_CLOUDBASE_ENV`：`cloud1-d5gurg39naf27d7a7`。

4. 部署后通过云托管提供的 HTTPS 地址打开网页。页面和 `/api` 使用同一域名；小程序继续用 `wx.cloud.callContainer` 连接服务名 `score-review-api`。

容器启动时会强制要求设置管理员密码和会话密钥。`SCORE_REVIEW_CLOUDBASE_ENV` 未设置时，服务只会使用容器本机文件存储，不会与小程序共享数据；要读取或修改小程序成绩，请配置该环境 ID，并确认云托管服务有访问该环境数据库的权限。网页通过独立的 HttpOnly 会话认证；不要把数据库密钥、密码或会话密钥提交到 GitHub。

## 本机检查

在 `score-review-web` 目录执行：

```powershell
$env:SCORE_REVIEW_PASSWORD = '本机测试密码'
$env:SCORE_REVIEW_SESSION_SECRET = '本机独立随机长字符串'
$env:PORT = '4173'
node .\server.js
```

未设置 `SCORE_REVIEW_CLOUDBASE_ENV` 时使用本地 JSON 文件，适合网页界面和接口冒烟测试；只有在云托管容器内配置 CloudBase 环境后，才会启用共享云数据库。
