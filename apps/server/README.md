# 搭 · CDA 后端

**零 npm 依赖**：只用 Node 24 内置的 `node:http` / `node:sqlite` / `node:crypto`。
在这个网络环境下没有安装与供应链风险，10 人内测规模完全够用。

## 运行

```bash
cd apps/server
CDA_PORT=8787 CDA_DB=./data/cda.db CDA_INVITES="BETA-001,BETA-002" \
  node --experimental-strip-types src/index.ts
```

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `CDA_PORT` | 监听端口 | 8787 |
| `CDA_DB` | 数据库文件 | ./data/cda.db |
| `CDA_INVITES` | 初始邀请码（逗号分隔，仅首次运行写入） | CDA-BETA-0001..0003 |

## 为什么用邀请码而不是短信验证码

阿里云/腾讯云短信**需要企业实名认证**，个人主体开通不了。
微信授权登录同样需要企业主体。所以在拿到营业执照之前，
**邀请码 + 账号密码**是唯一能真实跑起来的注册方式。
微信登录与短信都按 Provider 模式预留（见 `packages/core/src/services/payment.ts` 的同类做法）。

## 测试

```bash
bash scripts/run-api-test.sh    # 47 项端到端断言，每次都从干净的库跑
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册（校验邀请码、手机号/邮箱格式、密码长度） |
| POST | `/api/auth/login` | 登录（账号或密码错返回同一句话，不暴露账号是否注册过） |
| POST | `/api/auth/logout` | 登出 |
| GET/PATCH | `/api/me` | 我的资料 |
| GET | `/api/users?q=` | 搜索用户（昵称或用户码，尊重「不被搜索到」隐私） |
| GET | `/api/users/:code` | 用户主页（含关注数、是否已关注、TA 的帖子） |
| POST | `/api/users/:code/{follow,unfollow,block,unblock}` | 关注 / 拉黑 |
| GET | `/api/me/{following,favorites,history}` | 我的关注 / 收藏 / 浏览历史 |
| GET/POST | `/api/posts` | 帖子列表（含作者信息与点赞态）/ 发帖 |
| GET | `/api/posts/:id` | 帖子详情（**顺带写入浏览历史**） |
| POST | `/api/posts/:id/{like,favorite}` | 点赞 / 收藏（切换式） |
| GET | `/api/conversations` | 会话列表（含对方资料、最后一条、未读数） |
| GET/POST | `/api/conversations/:peer/messages` | 读历史（**读后自动标记已读**）/ 发消息 |
| GET/POST | `/api/posts/:id/comments` | 评论（分页）/ 发评论 |
| DELETE | `/api/comments/:id` | 删评论（**只能删自己的**） |
| GET/POST/DELETE | `/api/addresses` | 收货地址 |
| GET/POST/DELETE | `/api/wardrobe` | 衣橱 |

列表类接口统一支持 `?limit=&offset=`，返回 `hasMore` 与 `nextOffset`
（多取一条判断有无下一页，省掉额外的 COUNT 查询）。

消息历史的 `offset=0` 返回最新一页，增大 `offset` 读取更早的消息；每页内部
仍按时间正序展示。只有实际返回的消息会标记为已读。用户搜索先过滤隐藏用户，
再计算分页；`limit` / `offset` 会取整并限制范围，非有限值使用默认值。

请求体必须为 JSON 对象。非法 URL 编码返回 400，异常请求不会使服务进程退出。
静态资源与头像路径均校验目录边界。

相关回归测试可独立运行（零 npm 依赖，临时数据库自动清理）：

```bash
node scripts/test-server-regressions.mjs
```

## 表结构（13 张，`PRAGMA user_version` 管理迁移）

| 领域 | 表 |
|---|---|
| 账号 | `users` `sessions` `invites` `login_attempts` `user_styles` `user_brands` |
| 社区 | `posts` `comments` `post_likes` `favorites` `history` |
| 社交 | `follows` `blocks` `conversations` `messages` |
| 交易 | `addresses` `wardrobe` |

**改动结构只能往 `MIGRATIONS` 数组尾部追加**，绝不修改已发布的条目 ——
否则老库与新库会走成两个不同的形状。每步迁移都在事务里，失败自动回滚。

> 上一版把风格/品牌存成 JSON 字符串，**无法查询**；现在拆成
> `user_styles` / `user_brands` 两张表（`sort_order` 保留用户排序，
> 对应主页只展示前 5 个）。`posts.comments` 那个没人维护的计数器
> 也改成了从 `comments` 真表推导。

## 已实现的安全要点

- 密码用 **scrypt 加盐慢哈希**（不用 MD5/SHA），校验用 `timingSafeEqual`
- 登录失败不区分「账号不存在」与「密码错误」，避免账号枚举
- 会话按用户码**排序后存储**，保证一对人只有一条会话记录
- 被拉黑后：无法发消息、无法关注，且拉黑会解除互相关注
- 搜索与用户主页都遵守对方的隐私设置（不被搜索到 / 隐藏在线状态 / 隐藏地区）
- 请求体限制 1MB，防超大请求打爆内存
- 注册的格式校验放在**服务端**（前端校验可被绕过）
- **登录频率限制**：按「账号」与「来源 IP」双维度计数，连续失败 5 次锁 10 分钟，
  返回 429 + `retry-after`。同时挡住「撞一个账号」与「用一个 IP 撞很多账号」
- 会话过期时间建了索引，便于定期清理
