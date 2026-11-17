# CONTRACT —— 询单结构式助手（唯一事实源）

服务端：`index.js`　客户端：`client.js`　HTTP 前缀：`/inquiry-structure/api`

## 1. 通用约定

- 请求：`POST`，`Content-Type: application/json`，body 为 JSON 对象。
- 成功：`{ "ok": true, "data": { ... } }`
- 失败：`{ "ok": false, "error": "中文原因" }`（参数类错误也返回 HTTP 200；未知路由返回 404）。
- 全部处理都在本机；插件不联网、不读取任何外部服务。

## 2. 路由

### `POST /defaults`
入参 `{}` → 出参：

```json
{
  "defaultTemplatePath": "<USER_HOME>\\Desktop\\业务咨询货号申请表.xlsx",
  "defaultTemplateExists": true,
  "defaultTemplateFallback": false,
  "defaultTemplateConfigured": "<USER_HOME>\\Desktop\\业务咨询货号申请表.xlsx",
  "defaultOutputDir": "<USER_HOME>\\Desktop",
  "workDir": "...",
  "version": "1.0.0"
}
```

**模版自动找回**：配置路径不存在（模版被改名或删掉）时，会在「配置路径所在目录 → 输出目录 → 系统桌面」
里按内容找一份 xlsx：必须有含「结构式」的列，且该列上没有真实图片（空模版自带的空锚点不算）。
找到时 `defaultTemplateFallback=true`，`defaultTemplatePath` 指向找到的那份。

### `POST /upload`（分片上传）

入参：

| 字段 | 说明 |
| --- | --- |
| `name` | 原始文件名 |
| `size` | 总字节数 |
| `chunkSize` | 每片字节数（客户端固定 32768） |
| `index` | 分片序号（0 起） |
| `total` | 分片总数 |
| `data` | 该片的 base64 |
| `fileId` | **整个文件只有第 0 片留空**；之后（含并发线程）一律回传服务端给的同一个 `fileId` |

出参：`{ done, fileId, path, size, name }`。所有分片到齐后 `done=true`，文件落在工作目录的 `uploads/` 下。

**硬性口径**：

- 一个文件 = 一个会话。并发分片线程必须共享同一个 `fileId`；每个线程各带空 `fileId` 会拆出多个会话，
  分片永远凑不齐，服务端会判定未完成（表现为「上传失败」）。
- 只有 `0..total-1` 全部到齐才算上传完成；完成后会核对最终字节数，与 `size` 不符直接报错，
  不让残缺文件流到解析环节。

### `POST /extract`
入参 `{ fileId }` → 出参：

```json
{
  "source": { "name": "xxx.docx", "kind": "docx", "size": 327097, "path": "..." },
  "count": 19,
  "items": [
    { "index": 0, "name": "image1.png", "mime": "image/png", "width": 395, "height": 283,
      "bytes": 12220, "context": "SM-IMP1", "sheet": "", "row": 0, "col": 0 }
  ]
}
```

- `items` 按**文档从上到下**排序；`index` 即写入模版的行序。
- `context` 是图片所在表格行的文字（Word）或锚点单元格（Excel），用于快速辨认。

### `POST /preview`
入参 `{ fileId, index }` → 出参 `{ index, name, mime, width, height, context, dataUrl }`。
`dataUrl` 是 `data:image/png;base64,...`，单张返回，避免大响应体。

### `POST /template.inspect`
入参 `{ templatePath? , templateFileId? }`（都不给则用固定模版）
→ 出参：

```json
{
  "path": "<USER_HOME>\\Desktop\\业务咨询货号申请表.xlsx",
  "sheetName": "Sheet1",
  "targetColumn": "F",
  "targetTitle": "结构式/产品信息",
  "mergeEndColumn": "H",
  "headerRow": 2,
  "dataStartRow": 3,
  "availableRows": 83,
  "headers": [ { "column": 1, "letter": "A", "title": "编号" } ],
  "summary": "Sheet1 工作表 · F 列「结构式/产品信息」 · 第 3 行起 · 模板可放 83 张"
}
```

识别规则：在前 4 行表头里找文本含「结构式」的单元格；找不到则报错并列出已检查的表头。

### `POST /fill`
入参：

| 字段 | 说明 |
| --- | --- |
| `sourceFileId` | 源文件的 fileId |
| `indexes` | 要写入的图片序号数组（升序） |
| `templatePath?` / `templateFileId?` | 模版来源，二选一；**都不给就用固定模版**（界面不暴露这个入口） |
| `outputPath?` | 输出完整路径（用户在「另存为」里选中的路径，或脚本/测试用） |
| `outputDir?` | 用户用系统目录选择器选的目录；给了就把文件直接写进去 |
| `filename?` | 配合 `outputDir` 用的文件名 |

输出位置的判定顺序：`outputPath` → `outputDir` → 都没有则先落在 `<工作目录>\output\结构式_<时间戳>.xlsx`，
界面上把路径显示出来（当前环境没有可选保存位置时的兜底）。

写盘约定：

- `outputDir` 模式下**同名文件不静默覆盖**，自动加序号（`名字 (2).xlsx`）；
- 写完**回读校验字节数**，与生成结果不一致直接报错，不会留下半截文件。

出参：

```json
{
  "outputPath": "<USER_HOME>\\Desktop\\结构式_导出_20261113_120000.xlsx",
  "outputName": "结构式_导出_20261113_120000.xlsx",
  "outputToken": "6d3bc91520491e57",
  "written": 19, "firstRow": 3, "lastRow": 21,
  "templatePath": "...", "targetColumn": "F", "targetTitle": "结构式/产品信息",
  "sheetName": "Sheet1", "size": 310886,
  "templateRows": 83, "extendedRows": false, "savedByUser": true
}
```

`extendedRows` 为 true 表示图片数超过模版可用行，表格行数已自动扩展。

失败情形（均给出中文原因）：

- 未勾选任何图片 → 「请至少勾选一张结构式」
- 输出目录不存在 → 「输出目录不存在：…」
- 落盘字节数对不上 → 「落盘校验不一致：…」
- 输出路径等于模版本身 → 「不能覆盖模版文件本身，请换一个输出文件名」

### `POST /reveal`
入参 `{ path }` → `{ revealed, path, note? }`：在系统文件管理器中定位该文件。

## 3. 写入规则（写入模版的确切口径）

1. 模版**不被重写**：只在原包上新增 `xl/media/*`、`xl/drawings/*`，并给 `sheet1.xml` 末尾挂一个
   `<drawing r:id="..."/>`、`[Content_Types].xml` 补 image 默认类型与 drawing 覆盖项。
   模版原有部件只有 `[Content_Types].xml` 与 `xl/worksheets/sheet1.xml` 两个文件被改动。
   写入前先清掉模版里的**坏锚点**：图片引用（`a:blip r:embed`）无法解析到包内真实 media 文件的锚点
   （常见于从别处粘来的空占位框）会被丢弃，避免在导出结果里变成一个个没有内容的小方块；
   有真实图片的锚点（例如 logo）保留。
2. 第 i 张图（`indexes` 升序）写入第 `dataStartRow + i` 行。
3. 锚点为 `oneCellAnchor`：列 = 目标列，偏移量按「合并区宽度 − 图片宽度」居中，行偏移按「行高 − 图片高」居中。
4. 图片比例优先取源文档里的显示尺寸（`wp:extent`），其次取像素尺寸；等比缩放，不裁切、不变形。
5. 行数不够时按最后一行样式补行并补合并单元格。

## 4. 已知边界

- 只处理 `.docx` / `.xlsx`（不处理旧版 `.doc` / `.xls`、不处理 PDF）。
- Word 里若图片是外链（`r:link`）而非内嵌，取不到内容，会被跳过。
- Excel 源文件按「工作表顺序 → 行 → 列」排序；同一张图被多次引用会重复出现。
