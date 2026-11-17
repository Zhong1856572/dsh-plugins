# 询单结构式助手（@local/inquiry-structure-workbench）

把 Word / Excel 里的**结构式图片**按文档从上到下的顺序，逐张放进固定模版的
**「结构式/产品信息」列**（每行一张），导出成一份新的咨询表。

全程只在本机处理：文件不上传、不外发，解析和生成都在你自己的电脑上完成。

## 能做什么

| 步骤 | 说明 |
| --- | --- |
| ① 选择源文件 | 支持 `.docx`（Word 需求单 / 询单）与 `.xlsx`（含图片的表格）；也可以直接拖进来 |
| ② 核对结构式 | 按文档顺序列出全部图片（缩略图 + 所在行文字），默认全选，可逐张取消 |
| ③ 固定模版 | 模版由工作台固定为 `<USER_HOME>\Desktop\业务咨询货号申请表.xlsx`，**你不需要上传**；界面上只读展示，并可改导出文件名 |
| ④ 生成并另存为 | 点一下弹出**系统目录选择器**，自己挑保存位置；服务端直接写盘并回读校验，不会自动存到某个固定目录 |

- 图片数量不固定：3 张、19 张、30 张都可以，位置按顺序依次往下排。
- 模版的合并单元格、行高、列宽、边框、字体全部原样保留。
- 写入时自动按比例缩放并居中，不会压到相邻列。
- **模版改名或挪走也能用**：工作台会在同一目录里按内容自动找回那份带「结构式」列的表，
  并在界面上提示「已自动找回」。
- **保存位置由你决定**：用宿主的原生目录选择器选文件夹，文件名可在上方改；
  同名文件不静默覆盖，自动加序号（`名字 (2).xlsx`）。
- ⚠️ 桌面端（Electron）没有实现浏览器「另存为」对话框的**写**接口
  （`handle.createWritable()` 会被平台拒绝），所以文件一律由服务端写盘，不走前端写入。
- 模版里如果残留了没有图片的空占位框，写入前会被清掉，不会混进导出结果。

## 固定模版要求

表头里必须有一列写着「结构式」（例如「结构式/产品信息」）。工作台会自动认出：

- 这一列在哪一列（F / G …）
- 数据从第几行开始（表头行 + 1）
- 这一行能并几列（合并单元格的实际宽度）
- 模版一共能放多少张

## 安装

```powershell
# 1. 取源码
git clone https://github.com/Zhong1856572/dsh-plugins.git
cd dsh-plugins/plugins/inquiry-structure-workbench

# 2. 打包并装进本机 DSH
npm pack
dsh plugin --profile desktop add ./local-inquiry-structure-workbench-1.0.5.tgz
```

装完在 DSH 桌面端的工作台列表里找到「询单结构式助手」。

**模版路径**：默认取 `<USER_HOME>\Desktop\业务咨询货号申请表.xlsx`；
换成自己的模版就改 `cordis.patch.yml` 里的 `defaultTemplatePath`。
模版被改名或挪走时，工作台会按内容自动找回同一目录里那份带「结构式」列的表。

> 模版是业务文件，不随仓库分发（`.gitignore` 已排除 `*.xlsx`）。

## 目录

```
index.js          服务端：HTTP 路由（上传 / 提取 / 预览 / 读模版 / 生成 / 打开文件夹）
client.js         客户端：业务面板（React，customFrame 整页布局）
lib/zip.js        极简 zip 读写（无第三方依赖）
lib/ooxml.js      OOXML 解析：共享字符串、行高列宽、合并单元格、关系表
lib/extract.js    图片提取：Word 按正文顺序、Excel 按（表 → 行 → 列）
lib/imagemeta.js  图片尺寸与类型识别
lib/template.js   模版识别 + 把图片写进目标列
scripts/          自测脚本 + 命令行导出（export.mjs）
```

## 自测

自测脚本不写死任何本机路径：源文件与模版从命令行参数或环境变量取，
没有样例文件时**自动跳过**（不算失败）。

```bash
# 准备样例
export SAMPLE_DOCX="<你的需求单.docx>"
export TEMPLATE_XLSX="<你的申请表.xlsx>"

node scripts/selftest.mjs     # 提取 + 写模版（真实文件）
node scripts/servertest.mjs   # 服务端路由全流程 + 异常路径
node scripts/edgetest.mjs     # 3 张 / 30 张 / Excel 作源
node scripts/clienttest.mjs   # 客户端入口 / 注册描述符 / 身份字段 / 面板渲染
node scripts/uploadtest.mjs   # 上传链路：单会话口径 + 并发分片 + 残缺会话拦截
node scripts/templatetest.mjs # 模版改名 / 删掉后自动找回，且不误选导出件
```

## 命令行导出（不需要图形界面）

```bash
node scripts/export.mjs "<需求单.docx>" "<输出目录>" "<输出文件名>" --template "<申请表.xlsx>"
```
