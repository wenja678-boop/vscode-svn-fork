#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 打印带颜色的信息
print_info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# 检查命令是否存在
check_command() {
  if ! command -v $1 &> /dev/null; then
    print_error "$1 命令未找到，请先安装。"
    if [ "$1" = "vsce" ]; then
      echo "可以通过运行 'npm install -g @vscode/vsce' 安装 vsce。"
    fi
    exit 1
  fi
}

# 检查必要的命令
check_command "npm"
check_command "vsce"
check_command "git"

# 检查是否有未提交的更改
if [ -n "$(git status --porcelain)" ]; then
  print_warning "您有未提交的更改。建议在发布前提交所有更改。"
  read -p "是否继续？(y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# 检查 package.json 是否存在
if [ ! -f "package.json" ]; then
  print_error "未找到 package.json 文件。请确保您在插件项目的根目录中。"
  exit 1
fi

# 获取当前版本
CURRENT_VERSION=$(node -p "require('./package.json').version")
print_info "当前版本: $CURRENT_VERSION"

# 询问版本更新类型
echo "请选择版本更新类型:"
echo "1) 补丁版本 (patch) - 修复错误 (x.y.z -> x.y.z+1)"
echo "2) 次要版本 (minor) - 添加新功能 (x.y.z -> x.y+1.0)"
echo "3) 主要版本 (major) - 重大更改 (x.y.z -> x+1.0.0)"
echo "4) 预发布版本 (prerelease) - 添加预发布标识"
echo "5) 不更新版本"

read -p "请选择 (1-5): " VERSION_TYPE
echo

# 更新版本
case $VERSION_TYPE in
  1)
    npm version patch --no-git-tag-version
    ;;
  2)
    npm version minor --no-git-tag-version
    ;;
  3)
    npm version major --no-git-tag-version
    ;;
  4)
    read -p "请输入预发布标识 (例如: alpha, beta): " PRERELEASE_ID
    npm version prerelease --preid=$PRERELEASE_ID --no-git-tag-version
    ;;
  5)
    print_info "保持当前版本: $CURRENT_VERSION"
    ;;
  *)
    print_error "无效的选择"
    exit 1
    ;;
esac

# 获取新版本
NEW_VERSION=$(node -p "require('./package.json').version")
if [ "$CURRENT_VERSION" != "$NEW_VERSION" ]; then
  print_info "版本已更新: $CURRENT_VERSION -> $NEW_VERSION"
fi

# 编译项目
print_info "编译项目..."
npm run compile
if [ $? -ne 0 ]; then
  print_error "编译失败"
  exit 1
fi

# 打包插件
print_info "打包插件..."
vsce package
if [ $? -ne 0 ]; then
  print_error "打包失败"
  exit 1
fi

# 询问是否发布
read -p "是否要发布到 VSCode 插件市场？(y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  # 检查是否已登录
  print_info "检查 vsce 登录状态..."
  if ! vsce verify-pat 2>/dev/null; then
    print_warning "您需要使用 Personal Access Token (PAT) 登录"
    echo "请按照以下步骤获取 PAT:"
    echo "1. 访问 https://dev.azure.com"
    echo "2. 点击右上角的用户图标，选择 'Personal access tokens'"
    echo "3. 点击 '+ New Token'"
    echo "4. 设置名称，选择组织，设置过期时间"
    echo "5. 在 'Scopes' 部分，选择 'Custom defined'，然后选择 'Marketplace > Manage'"
    echo "6. 点击 'Create' 并复制生成的 token"
    echo
    
    read -p "请输入您的 Personal Access Token: " PAT
    if [ -z "$PAT" ]; then
      print_error "未提供 PAT，无法发布"
      exit 1
    fi
    
    # 创建临时发布配置
    echo "{\"publishers\": [{\"name\": \"$(node -p \"require('./package.json').publisher\")\", \"pat\": \"$PAT\"}]}" > ~/.vsce-auth.json
    print_info "临时发布配置已创建"
  fi
  
  # 发布插件
  print_info "发布插件到 VSCode 插件市场..."
  vsce publish
  PUBLISH_RESULT=$?
  
  # 删除临时发布配置
  if [ -f ~/.vsce-auth.json ]; then
    rm ~/.vsce-auth.json
    print_info "临时发布配置已删除"
  fi
  
  if [ $PUBLISH_RESULT -ne 0 ]; then
    print_error "发布失败"
    exit 1
  fi
  
  print_info "插件已成功发布到 VSCode 插件市场！"
  
  # 提交版本更新
  if [ "$CURRENT_VERSION" != "$NEW_VERSION" ]; then
    read -p "是否提交版本更新到 Git？(y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      git add package.json
      git commit -m "版本更新: $CURRENT_VERSION -> $NEW_VERSION"
      git tag "v$NEW_VERSION"
      
      read -p "是否推送到远程仓库？(y/n) " -n 1 -r
      echo
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        git push
        git push --tags
        print_info "版本更新已推送到远程仓库"
      fi
    fi
  fi
else
  print_info "已跳过发布步骤"
  print_info "您可以稍后通过运行 'vsce publish' 手动发布"
fi

print_info "脚本执行完成" 