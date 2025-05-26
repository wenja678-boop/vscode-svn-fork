# VSCode扩展存储级别判定机制

## 概述

在VSCode扩展开发中，数据存储有不同的级别，我们的SVN插件使用了两种不同的存储策略来满足不同的需求。

## 存储级别分类

### 1. 项目级别存储（Workspace Storage）
**用途**：提交日志历史
**实现方式**：
```typescript
private getStoragePath(): string {
  let workspaceRoot = '';
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  } else {
    workspaceRoot = this.context.globalStoragePath;
  }
  return path.join(workspaceRoot, '.svn-logs', 'commit_logs.json');
}
```

**判定逻辑**：
1. 检查是否有打开的工作区（`vscode.workspace.workspaceFolders`）
2. 如果有工作区，使用工作区根目录
3. 如果没有工作区，降级到全局存储路径

**存储路径**：`{项目根目录}/.svn-logs/commit_logs.json`

### 2. 用户级别存储（Global Storage）
**用途**：提交前缀历史
**实现方式**：
```typescript
private getPrefixStoragePath(): string {
  const globalStoragePath = this.context.globalStorageUri?.fsPath || this.context.globalStoragePath;
  return path.join(globalStoragePath, 'svn_prefix_history.json');
}
```

**判定逻辑**：
1. 直接使用VSCode提供的全局存储路径
2. 优先使用 `context.globalStorageUri?.fsPath`
3. 如果不可用，降级到 `context.globalStoragePath`

**存储路径**：`{VSCode全局存储目录}/{扩展ID}/svn_prefix_history.json`

## VSCode Context对象提供的存储选项

### ExtensionContext存储属性

```typescript
interface ExtensionContext {
  // 全局存储路径（用户级别）
  globalStoragePath: string;
  globalStorageUri: Uri;
  
  // 工作区存储路径（项目级别）
  workspaceState: Memento;
  globalState: Memento;
  
  // 其他属性...
}
```

### 存储级别对比

| 存储类型 | 作用范围 | 存储位置 | 使用场景 |
|---------|---------|---------|---------|
| **项目级别** | 当前项目 | 项目根目录 | 项目特定的配置和数据 |
| **用户级别** | 当前用户的所有项目 | 用户全局目录 | 跨项目共享的配置和数据 |
| **本机级别** | 本机所有用户 | 系统级目录 | 系统级配置（较少使用） |

## 我们的设计决策

### 为什么提交日志使用项目级别？
1. **隔离性**：每个项目的提交历史应该独立
2. **相关性**：提交日志与具体项目强相关
3. **便于管理**：可以随项目一起备份和迁移

### 为什么前缀使用用户级别？
1. **复用性**：前缀通常在多个项目中重复使用
2. **一致性**：保持跨项目的提交规范一致
3. **效率**：避免在每个项目中重复设置

## 实际路径示例

### macOS系统
```bash
# 用户级别存储（前缀）
~/Library/Application Support/Code/User/globalStorage/pengfeiSummer.vscode-svn-ai/svn_prefix_history.json

# 项目级别存储（提交日志）
/path/to/your/project/.svn-logs/commit_logs.json
```

### Windows系统
```cmd
# 用户级别存储（前缀）
%APPDATA%\Code\User\globalStorage\pengfeiSummer.vscode-svn-ai\svn_prefix_history.json

# 项目级别存储（提交日志）
C:\path\to\your\project\.svn-logs\commit_logs.json
```

### Linux系统
```bash
# 用户级别存储（前缀）
~/.config/Code/User/globalStorage/pengfeiSummer.vscode-svn-ai/svn_prefix_history.json

# 项目级别存储（提交日志）
/path/to/your/project/.svn-logs/commit_logs.json
```

## 判定流程图

```
开始
  ↓
需要存储数据
  ↓
判断数据类型
  ↓
┌─────────────────┬─────────────────┐
│   提交日志历史    │    提交前缀     │
│                │                │
│  项目级别存储     │   用户级别存储   │
│                │                │
│ 检查工作区是否存在 │ 直接使用全局存储  │
│      ↓         │      ↓         │
│ 有工作区？       │ globalStorageUri │
│   ↓   ↓        │      ↓         │
│  是   否        │ 不可用？        │
│   ↓   ↓        │      ↓         │
│工作区根目录 全局存储│ globalStoragePath│
│   ↓   ↓        │      ↓         │
│ .svn-logs/     │ 扩展ID目录/      │
│ commit_logs.json│svn_prefix_history.json│
└─────────────────┴─────────────────┘
  ↓
存储完成
```

## 代码实现细节

### 项目级别判定
```typescript
// 1. 检查是否有工作区
if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
  // 使用第一个工作区的根目录
  workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
} else {
  // 没有工作区时，降级到全局存储
  workspaceRoot = this.context.globalStoragePath;
}
```

### 用户级别判定
```typescript
// 直接使用全局存储，有两个备选方案
const globalStoragePath = this.context.globalStorageUri?.fsPath || this.context.globalStoragePath;
```

## 总结

我们的插件通过以下方式判定存储级别：

1. **自动判定**：根据数据的性质和用途自动选择合适的存储级别
2. **降级机制**：当首选存储方式不可用时，自动降级到备选方案
3. **明确分工**：不同类型的数据使用不同的存储策略

这种设计既保证了数据的合理隔离，又实现了跨项目的便利共享。 