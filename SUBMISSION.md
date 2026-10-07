# 提交方案：输入栏工具箱 → hana-marketplace

目标仓库：https://github.com/liliMozi/hana-marketplace

---

## 一、市场规则（已核实，来自该仓库 CONTRIBUTING.md 与 PR 模板）

| 项 | 要求 | 本次状态 |
|---|---|---|
| 主仓库性质 | **只是目录，不存扩展源码** | 已理解 |
| PR 改哪些文件 | **只能改 `registry.json`**，不得手编 `index.v2.json`（那是 CI 生成的） | 已按此准备 |
| 源仓库 | 必须是**公开**仓库，且有**稳定的 GitHub Release** | 待建 |
| Release 内容 | 需含 `app-input-toolkit.entry.js` 与对应 ZIP，且与 registry 条目**逐字一致** | 待官方打包器产出 |
| 打包工具 | **必须**用官方 `npm run pack:extension` | ❌ 本机没有，见第四节 |
| publisher | 必须与打包产出的 JSON **完全一致** | 已定为 `放线菌` |
| 运行环境 | Node 24.15+ 或兼容的 Node 24；**不得依赖安装**，不用 pnpm/yarn/bun | 本 App 零依赖，符合 |
| SKILL.md | ≤1024 tokens | 不适用（这是 app 不是 skill） |
| `index.v2.json` | v2 新 App 还需登记；**但它是生成物，手改会被打回** | 不动 |

当前 `registry.json` 与 `index.v2.json` 的 entries/items 都是空的，本次会是首批之一。

---

## 二、要加的那一行

```json
{
  "kind": "app",
  "id": "input-toolkit",
  "repository": "xxisme/input-toolkit",
  "publisher": "放线菌"
}
```

对应 `registry.json` 变为：

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "kind": "app",
      "id": "input-toolkit",
      "repository": "xxisme/input-toolkit",
      "publisher": "放线菌"
    }
  ]
}
```

---

## 三、脱敏核查结果

对 184 个文件做了内容级扫描（不只是看包结构）：

| 类别 | 结果 |
|---|---|
| 私钥 / API Key / Token / Bearer 头 | **零** |
| 本机绝对路径（`C:\Users\...`） | **零** |
| 真实会话 id（`sess_...`） | **零** |
| 本机用户名泄漏 | **零** |
| 调试残留（`console.log` / `PROBE` / `debugger`） | **零**（唯一告警是 SDK 内嵌 emoji 字体的 base64 误报） |

有意保留的两项：

- `README.md` 里的作者 QQ（11991234）——这是你明确要求写进文档的联系方式
- 源码注释里大量「实测数据 / 踩坑记录」——不是敏感信息，是维护者需要知道的约束条件。
  例如「某字段实测恒为 0」「某阈值是 p95 硬凑的」，删掉以后别人会把 bug 改回去。

---

## 四、两个硬阻塞（都做不了，需要你）

### 阻塞 1：GitHub token 失效

- `GH_TOKEN` 环境变量里有一个 93 字符的 `github_` token，调用 API 返回 **401**
- SSH 通道是通的（身份 `xxisme`），但 **GitHub 已禁用 push 自动建仓**，
  实测推送返回 `Repository not found`
- 而「建仓 → 传 Release 资产 → 开 PR」这三步**全部只能走 API**

**需要你给一个有效的 token**，作用域：

- 经典 PAT：`repo` + `public_repo`
- 或 fine-grained PAT：对个人仓库的 *Administration: Read and write*、*Contents: Read and write*、*Pull requests: Read and write*

有了 token，剩下的我一次做完。

### 阻塞 2：官方打包器不在本机

`npm run pack:extension` 定义在 openhanako 源码检出里。本机没有该检出，
而 `git clone` 走 https（443）在这台机器上不通。

**所以 `app-input-toolkit.entry.js` 我生成不了** —— 而市场校验会拿它与 registry 条目比对，
这一步必须用官方打包器，不能手搓。

两个选择：

- 你在自己有 openhanako 检出 / 能连外网的机器上跑一次：

  ```
  npm run pack:extension -- --kind app --dir /path/to/input-toolkit \
    --publisher "放线菌" --out ./dist-extensions
  ```

  然后把 `dist-extensions/` 里的产物给我，我接着走。
- 或者给我一个能访问 openhanako 的途径。

---

## 五、已经准备好的东西

- 本地 git 仓库已初始化并提交（342 个文件，含 `.gitignore` 与面向用户的 README）
- 脱敏核查通过
- README 已按「只讲功能、不讲开发过程」重写，含权限逐条说明与四项指标的口径
- zip 产物已验证（340 文件逐字节一致，包内 42 项抽查全过）

拿到 token 与打包产物后，剩余动作：

1. 建公开仓 `xxisme/input-toolkit`，推送本地提交（SSH 即可）
2. 建 tag + Release，上传 `app-input-toolkit.entry.js` 与 zip（需 API）
3. fork `liliMozi/hana-marketplace`，按第二节改 `registry.json`，开 PR（需 API）