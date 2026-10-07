# 网页 API

网页 API 与界面由 `server.js` 在同一 HTTP 服务提供。云托管容器监听 `PORT`，登录后使用 HttpOnly 会话 Cookie 访问 `/api/work-records`；CloudBase 数据库接入通过 `SCORE_REVIEW_CLOUDBASE_ENV` 开启。

请按 [`CLOUD-HOSTING-SETUP.md`](./CLOUD-HOSTING-SETUP.md) 配置云托管服务。没有云环境配置的本机运行模式使用 `server-data.json`，不会同步到微信小程序。
