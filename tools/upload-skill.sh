#!/usr/bin/env bash
# DSH 技能上传脚本 —— 把本地技能提交到 DSH 专用仓库
#
# 用法：
#   bash tools/upload-skill.sh <技能目录名> [提交说明]
#   bash tools/upload-skill.sh my-skill "feat: 新增 XXX 技能"
#
# 前提：本机已在 Windows 凭据管理器中配置 git:https://github.com 的凭据
#       （或已设置 GITHUB_TOKEN 环境变量）

set -euo pipefail

REPO_URL="https://github.com/Zhong1856572/dsh-plugins.git"
REPO_DIR="${DSH_PLUGINS_DIR:-$HOME/.dsh-plugins-repo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="${1:-}"
MSG="${2:-feat(skill): 新增 ${SKILL_NAME}}"

if [ -z "$SKILL_NAME" ]; then
  echo "用法: bash tools/upload-skill.sh <技能目录名> [提交说明]" >&2
  exit 1
fi

# 技能来源目录：优先 DSH 技能目录
SRC=""
for d in "$HOME/.dsh/skills/$SKILL_NAME" "$HOME/.dsh/profiles/desktop/skills/$SKILL_NAME" "$HOME/.workbuddy/skills/$SKILL_NAME"; do
  if [ -d "$d" ]; then SRC="$d"; break; fi
done

if [ -z "$SRC" ]; then
  echo "错误：找不到技能目录 '$SKILL_NAME'" >&2
  echo "已查找:" >&2
  echo "  - $HOME/.dsh/skills/$SKILL_NAME" >&2
  echo "  - $HOME/.dsh/profiles/desktop/skills/$SKILL_NAME" >&2
  echo "  - $HOME/.workbuddy/skills/$SKILL_NAME" >&2
  exit 1
fi

echo "→ 技能源目录: $SRC"

# 校验：必须含 SKILL.md，且 name 必须是 kebab-case
if [ ! -f "$SRC/SKILL.md" ]; then
  echo "错误：$SRC 下缺少 SKILL.md" >&2
  exit 1
fi

SKILL_DECLARED=$(grep -m1 '^name:' "$SRC/SKILL.md" | sed 's/^name:[[:space:]]*//' | tr -d '\r')
if ! echo "$SKILL_DECLARED" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$'; then
  echo "错误：frontmatter name='$SKILL_DECLARED' 不是合法 kebab-case，DSH 无法加载" >&2
  echo "要求：仅 ASCII 小写字母、数字、连字符，如 my-custom-skill" >&2
  exit 1
fi
echo "→ 技能 name: $SKILL_DECLARED ✓ (kebab-case 合规)"

# 准备仓库
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "→ 克隆仓库到 $REPO_DIR ..."
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "→ 更新仓库 $REPO_DIR ..."
  git -C "$REPO_DIR" pull --ff-only
fi

# 复制技能
mkdir -p "$REPO_DIR/skills"
rm -rf "$REPO_DIR/skills/$SKILL_NAME"
cp -r "$SRC" "$REPO_DIR/skills/$SKILL_NAME"

# 脱敏：路径与内网 IP
echo "→ 脱敏处理 ..."
python3 "$SCRIPT_DIR/sanitize.py" "$REPO_DIR/skills/$SKILL_NAME"

# 敏感信息扫描（任一命中即中止）
echo "→ 敏感信息扫描 ..."
if grep -rniE "ghp_|github_pat_|gho_|ghs_|ghu_|api[_-]?key|password[[:space:]]*[:=]|bearer [A-Za-z0-9]{20,}|x-access-token" "$REPO_DIR/skills/$SKILL_NAME" 2>/dev/null | grep -q .; then
  echo "✗ 检测到疑似密钥，已中止提交" >&2
  grep -rniE "ghp_|github_pat_|api[_-]?key|password[[:space:]]*[:=]|bearer [A-Za-z0-9]{20,}" "$REPO_DIR/skills/$SKILL_NAME" 2>/dev/null | head -5 >&2
  exit 1
fi
echo "  未发现密钥 ✓"

# 提交推送
cd "$REPO_DIR"
git config user.name "Zhong1856572"
git config user.email "zhong1856572@users.noreply.github.com"
git add -A "skills/$SKILL_NAME"

if git diff --cached --quiet; then
  echo "→ 无变更，无需提交"
  exit 0
fi

git commit -q -m "$MSG

Co-Authored-By: WorkBuddy <noreply@workbuddy.ai>"
echo "→ 推送到 GitHub ..."
GIT_TERMINAL_PROMPT=0 git push origin main

echo
echo "✓ 上传完成"
echo "  仓库: https://github.com/Zhong1856572/dsh-plugins"
echo "  安装码（给其他人）:"
echo "    仓库地址: Zhong1856572/dsh-plugins"
echo "    命令    : git clone https://github.com/Zhong1856572/dsh-plugins.git && cp -r dsh-plugins/skills/$SKILL_NAME ~/.dsh/skills/"
