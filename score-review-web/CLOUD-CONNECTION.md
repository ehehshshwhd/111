# 网页与微信云端连接说明

云托管容器以服务端身份访问 CloudBase 数据库，网页浏览器不会持有云开发密钥。容器连接小程序共用的 `work_records` 集合，按 `eventId` 和 `stage` 查询或保存赛段成绩；服务端通过独立的网页管理员会话保护 API。

小程序使用 CloudBase 环境 `cloud1-d5gurg39naf27d7a7`，通过 `wx.cloud.callContainer` 访问 `score-review-api`。网页服务的 Dockerfile 和环境变量说明见 [`CLOUD-HOSTING-SETUP.md`](./CLOUD-HOSTING-SETUP.md)。

网页管理员会话只代表网页后台登录，不会伪装成小程序工作人员，也不会绕过小程序对录入人员的赛段权限。不要把数据库密钥、管理员密码或会话密钥提交到代码仓库。
