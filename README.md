# DSH 插件与技能仓库

> `Zhong1856572/dsh-plugins` · 供 **DSH Skills Manager** 订阅安装

本仓库存放面向 **DSH (DeepSeek Harness)** 的技能（Skill）与插件（Plugin）。
DSH Skills Manager 支持通过 GitHub 仓库地址**整仓扫描**技能清单，
订阅后即可在 DSH 界面里一键安装、增量更新、版本回退。

---

## 安装方式

### 方式一：DSH 界面订阅（推荐给别人）

1. 打开 DSH → **设置 → 技能** → 切到 **「发现」** 页签
2. 点击 **「添加仓库」**
3. 填入仓库地址：

```
Zhong1856572/dsh-plugins
```

4. 确认扫描结果后，逐个点击安装

> DSH 通过 `codeload.github.com` 匿名拉取仓库压缩包，
> 因此 **本仓库必须是公开仓库**，否则订阅会失败。

### 方式二：命令行安装单个技能

```bash
# 克隆仓库
git clone https://github.com/Zhong1856572/dsh-plugins.git

# 复制到 DSH 的技能目录
cp -r dsh-plugins/skills/<技能名>/ ~/.dsh/skills/<技能名>/
```

### 方式三：让 Agent 代劳

把这段话发给能够操作本机终端的 Agent：

```text
请从 GitHub 仓库 Zhong1856572/dsh-plugins 克隆仓库，
把其中的 skills/<技能名>/ 安装到我的 DSH 技能目录 ~/.dsh/skills/，
安装后告诉我如何让 DSH 重新加载。
```

---

## 目录结构

```
dsh-plugins/
├── skills/                          # 技能（DSH Skills Manager 扫描目标）
│   └── <技能名>/
│       └── SKILL.md                 # 必需：技能入口
├── plugins/                         # 插件（DSH 插件包）
│   └── <插件名>/
│       ├── package.json             # 必需：npm 包清单
│       ├── lib/                     # 必需：插件实现
│       └── cordis.patch.yml         # 可选：UI 补丁
├── dsh-plugins.json                 # 仓库清单（技能 + 插件索引）
├── README.md
├── LICENSE
└── .gitignore
```

---

## 技能命名规范（DSH 强制要求）

DSH 宿主**严格要求**技能标识符为 **kebab-case**（仅 ASCII 小写字母、数字、连字符）：

```
✅ my-custom-skill
✅ dsh-report-helper
❌ 中文技能名
❌ My_Skill
```

> 目录名可以用中文，但 `SKILL.md` 的 YAML frontmatter 里**必须显式声明合法的英文 `name`**：

```markdown
---
name: copy-formatting-helper
description: 微信公众号与多平台文案排版辅助工具
---
```

否则 DSH 会提示「宿主不支持此技能名称格式，无法启用」。

---

## 技能清单

| # | 技能 | 说明 |
|---|---|---|
| — | *（待 DSH 上传）* | |

---

## 插件安装（Command Line）

DSH 插件走 npm 生态，安装命令：

```powershell
dsh plugin --profile desktop add <包名>@<版本> --registry=https://registry.npmjs.org/
```

本仓库中的插件若以 npm 包形式发布，用上面的命令安装；
若是 GitHub 源插件，DSH 也支持直接从 GitHub 仓库安装。

---

## ⚠️ 提交前必做：脱敏检查

本仓库为**公开仓库**，提交前必须确认不含敏感信息：

- ❌ 内部客户名称、客户名单、报价
- ❌ 内网 IP / 端口（`192.168.x.x`、`10.x.x.x`）
- ❌ 密钥、令牌、密码（`ghp_`、`github_pat_`、api_key）
- ❌ 本机真实路径（`C:/Users/<用户名>/`）
- ❌ 企业内部制度、组织架构、人员姓名

路径请用占位符 `<WORKBUDDY_HOME>` / `<USER_HOME>` / `<INTERNAL_IP>` 代替。

---

## 插件开发规范

DSH 插件本质是 npm 包，`package.json` 需声明 `dsh` 字段：

```json
{
  "name": "my-dsh-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "lib/index.js",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0" },
  "peerDependencies": { "@deepseek-ai/dsh": ">=0.2.0-rc.1 <0.3.0-0" }
}
```

> ⚠️ `engines.dsh` 必须与用户实际运行的 DSH 版本兼容，
> 否则安装时会被版本门拦截（报错 `incompatible with dsh x.y.z`）。
> 可用 `dsh plugin allow-version` 为特定版本授予豁免。

---

_Last updated: 2026-11-06_
