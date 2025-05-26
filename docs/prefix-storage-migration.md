# SVN提交前缀存储迁移说明

## 概述

从版本 4.2.5 开始，SVN插件的提交前缀存储方式已从项目级别改为用户/本机级别。这意味着所有项目现在都可以共享相同的前缀历史记录。

## 变更详情

### 之前的存储方式（项目级别）
- 存储路径：`{项目根目录}/.svn-logs/prefix_history.json`
- 每个项目都有独立的前缀历史
- 切换项目时需要重新输入常用前缀

### 新的存储方式（用户/本机级别）
- 存储路径：`{VSCode全局存储目录}/svn_prefix_history.json`
- 所有项目共享同一个前缀历史列表
- 在任何项目中都可以使用之前保存的前缀

## 迁移影响

### 对现有用户的影响
1. **旧的前缀历史不会自动迁移**：之前保存在各个项目中的前缀历史不会自动合并到新的全局存储中
2. **需要重新添加常用前缀**：用户需要在新版本中重新输入和保存常用的前缀
3. **旧文件不会被删除**：项目目录下的 `.svn-logs/prefix_history.json` 文件不会被自动删除

### 对新用户的影响
- 新用户将直接使用新的全局存储方式
- 无需任何额外配置

## 优势

1. **跨项目一致性**：在所有项目中都可以使用相同的前缀列表
2. **提高效率**：无需在每个项目中重复设置常用前缀
3. **更好的用户体验**：前缀历史在项目间保持同步

## 手动迁移指南

如果您希望将旧的前缀历史迁移到新系统中，可以按照以下步骤操作：

1. 找到各个项目目录下的 `.svn-logs/prefix_history.json` 文件
2. 记录其中的前缀内容
3. 在新版本的插件中手动重新输入这些前缀
4. 插件会自动将新输入的前缀保存到全局存储中

## 技术实现

### 存储位置
新的前缀历史文件存储在VSCode的全局存储目录中：
- Windows: `%APPDATA%/Code/User/globalStorage/your-extension-id/svn_prefix_history.json`
- macOS: `~/Library/Application Support/Code/User/globalStorage/your-extension-id/svn_prefix_history.json`
- Linux: `~/.config/Code/User/globalStorage/your-extension-id/svn_prefix_history.json`

### 代码变更
主要变更在 `src/commitLogStorage.ts` 文件中的 `getPrefixStoragePath()` 方法：

```typescript
// 之前的实现
private getPrefixStoragePath(): string {
  let workspaceRoot = '';
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  } else {
    workspaceRoot = this.context.globalStoragePath;
  }
  return path.join(workspaceRoot, '.svn-logs', 'prefix_history.json');
}

// 新的实现
private getPrefixStoragePath(): string {
  // 使用扩展的全局存储路径，这样所有项目都能共享前缀历史
  const globalStoragePath = this.context.globalStorageUri?.fsPath || this.context.globalStoragePath;
  return path.join(globalStoragePath, 'svn_prefix_history.json');
}
```

## 常见问题

### Q: 我的旧前缀历史去哪了？
A: 旧的前缀历史仍然保存在各个项目的 `.svn-logs/prefix_history.json` 文件中，但新版本不再读取这些文件。您需要手动重新添加常用前缀。

### Q: 如何清除前缀历史？
A: 前缀历史存储在全局存储目录中，您可以通过删除 `svn_prefix_history.json` 文件来清除所有前缀历史。

### Q: 多个VSCode实例会共享前缀历史吗？
A: 是的，同一用户账户下的所有VSCode实例都会共享相同的前缀历史。

### Q: 这个改动会影响提交日志历史吗？
A: 不会。提交日志历史仍然按项目存储，只有前缀历史改为全局存储。 