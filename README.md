# CF 优选 IP · 三网实时节点

一个部署在 Cloudflare Pages 上的 Cloudflare 优选 IP 展示页：按电信 / 联通 / 移动三网实测延迟、丢包排序，支持单条复制、整组复制，数据每 30 分钟自动更新。

- 纯静态，无框架、无构建依赖，首屏只有 HTML + 一个 CSS + 一个 JS
- 数据由 GitHub Actions 定时抓取公开优选接口生成 `public/data/nodes.json`
- 亮 / 暗主题跟随系统，支持手动切换；移动端单列布局

## 目录结构

```
public/
  index.html          页面
  assets/style.css    样式
  assets/app.js       交互逻辑
  data/nodes.json     节点数据（由脚本生成，勿手改）
  _headers            Pages 缓存与安全响应头
scripts/
  update-nodes.mjs    数据聚合脚本（Node 20+，零依赖）
.github/workflows/
  update.yml          每 30 分钟更新数据并提交
```

## 本地预览

```bash
node scripts/update-nodes.mjs          # 抓一次数据
python -m http.server 8899 --directory public
# 打开 http://127.0.0.1:8899
```

`node scripts/update-nodes.mjs --dry` 只打印统计不写文件；`--out path.json` 可指定输出路径。

## 数据源

| 来源 | 用途 | 说明 |
| --- | --- | --- |
| `vps789.com/public/sum/cfIpApi` | 主源 | 每个 IP 带电信 `dx`、联通 `lt`、移动 `yd` 三组延迟 / 丢包 / 评分，评分越低越好 |
| `raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt` | 补充 | 精选列表，无测速数据，卡片上不显示延迟，排在综合组末尾 |

抓取失败、或可用节点少于 3 个时脚本退出码为 1，工作流会失败并**保留上一次的数据**，不会把站点刷成空白。

想加数据源：在 `scripts/update-nodes.mjs` 里照着 `parseVps789` 写一个 `parseXxx`，返回 `[{ ip, telecom?, unicom?, mobile?, avgScore? }]`，再在 `main()` 里 `concat` 进去即可。上线前建议先 `--dry` 看一眼分组数量。

## 数据格式

```json
{
  "updated_at": "2026-11-15T02:46:22.114Z",
  "groups": {
    "all":     [{ "ip": "172.64.146.125", "latency": 171.6, "loss": 2.26, "score": 284 }],
    "telecom": [{ "ip": "108.162.198.89", "latency": 61.4,  "loss": 0,    "score": 61  }],
    "unicom":  [],
    "mobile":  []
  },
  "sources": [{ "name": "vps789", "url": "...", "ok": true, "count": 19 }]
}
```

`all` 组的 `latency` / `loss` 是三网均值；`score` 是接口给的综合分。

## 部署到 Cloudflare Pages

1. 把本仓库推到 GitHub。
2. Cloudflare 控制台 → Workers & Pages → 创建 → Pages → 连接到 Git，选本仓库。
3. 构建设置：框架预设 `None`，构建命令留空，**输出目录填 `public`**。
4. 保存后首次构建约 1 分钟；之后每次 Actions 提交 `nodes.json` 都会自动重新部署。

## 说明

- 只收录 Cloudflare 边缘节点 IP，本项目不提供任何 CDN、代理或节点服务。
- 延迟数据来自第三方监测，只能作为选路参考，实际体验受本地线路、时段影响很大。
- 用到别人的公开接口，请自控频率（本项目 30 分钟一次），不要拿去压测或商用。
