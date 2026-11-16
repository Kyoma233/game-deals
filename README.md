# 游戏打折监控（GitHub Pages 静态版）

一个纯静态的游戏折扣聚合页面：Steam 国区、CheapShark 8 家海外正版店、杉果、steamPY、小黑盒，5 个来源，每 4 小时自动刷新。

页面本身不含任何服务端逻辑：数据由 GitHub Actions 定时运行 `scripts/fetch.mjs` 生成，写入 `data/deals.json`，页面用相对路径读取，部署在 `https://<用户名>.github.io/<仓库名>/` 子路径下也能正常工作。

## 目录结构

```
index.html                  静态页面
app.js                      前端逻辑（筛选 / 排序 / 比价 / 关注列表）
styles.css                  样式
scripts/
  fetch.mjs                 数据抓取脚本（Node 20+，零外部依赖）
  heybox-signer.mjs         小黑盒 Web 请求签名算法移植（见下方致谢）
data/
  deals.json                本轮折扣数据（Actions 自动生成）
  history.json              每日最低价快照（保留 90 天）
.github/workflows/
  refresh.yml               每 4 小时刷新数据的 Actions 工作流
```

## 数据来源与价格口径

| 来源 | 方式 | 币种 | 备注 |
| --- | --- | --- | --- |
| Steam 国区 | 官方商店接口 `featuredcategories` | CNY | 含折扣截止时间 |
| CheapShark 8 店 | CheapShark 公开 API（GOG、Humble、Fanatical、GMG、Epic、Gamesplanet、IndieGala、Steam 美区），每店取 DealRating 前 60 | USD | 链接为 CheapShark 官方跳转链接 |
| 杉果 | 官网首页内嵌的 `window.__REDUX_STATE__` 商品数据 | CNY | 链接到 `sonkwo.hk/sku/<id>` |
| steamPY | 官方插件公开报价接口 `plugIn/getGame`（无登录），包 ID 从 Steam 商店页提取 | CNY | 原价取 Steam 国区原价；卡片价为 CDK 报价，已剔除 0.1 元/1 元抽奖式挂牌（报价需达到同条目市场价的 20% 才计入）；链接统一到 steampy.com 首页 |
| 小黑盒 | 商城公开列表（按最高折扣排序，4 页 × 100 条，无登录） | CNY | 卡片价为商城列表价，需登录领取的优惠券价不计入 |
| 热门度 | Steam 官方当前在线人数 Top 100 | — | 附加到匹配的卡片上（热门排名 + 在玩人数），未上榜的按折扣力度排在后面 |

失败处理：单个来源某轮抓取失败时，脚本保留该来源上次的数据，并在 `data/deals.json` 的 `meta.sources` 中记录失败状态，页面顶部会显示横幅，绝不静默失败、绝不编造数据补位。小黑盒遇到验证码/要求登录/异常状态时，整轮跳过该来源。

## 启用 GitHub Pages

1. 把本目录内容推送到一个 GitHub 仓库（公开仓库即可，Actions 标准 runner 免费且不限分钟数）。
2. 仓库 Settings → Pages → Build and deployment → Source 选择 **Deploy from a branch**，Branch 选择默认分支、目录选择 **/(root)**，保存。
3. 首次部署后，在仓库 Actions 页手动运行一次 **Refresh game deals**（workflow_dispatch），生成第一份 `data/deals.json`；之后每 4 小时自动刷新。
4. 访问 `https://<用户名>.github.io/<仓库名>/` 即可。

## 本地预览

```bash
# 生成数据（约 2 分钟，含对各来源的礼貌延迟）
node scripts/fetch.mjs

# 静态托管（任选其一）
python3 -m http.server 8000
# 或
npx serve .
```

然后打开 http://localhost:8000/ 。

注意：直接用 `file://` 打开 `index.html` 时，浏览器会阻止 `fetch` 读取本地 JSON，请务必通过 HTTP 服务预览。

## 关注列表与历史最低价

- 关注列表存在浏览器 `localStorage`，不上传任何数据；可在卡片上点「☆ 关注」，或在关注区的搜索框里搜索后加入；可为每款游戏设目标价，达到时显示提示。
- `data/history.json` 记录每个游戏每天的最低价快照（分人民币/美元），保留 90 天；关注列表中的「历史最低」来自这份快照。只记录本轮新抓到的数据，失败来源的上轮旧数据不会重复计入。

## 致谢

小黑盒 Web 签名算法移植自公开项目 [foxlesbiao/xiaoheihe-mcp](https://github.com/foxlesbiao/xiaoheihe-mcp)（MIT 协议），见 `scripts/heybox-signer.mjs` 顶部的署名注释。
