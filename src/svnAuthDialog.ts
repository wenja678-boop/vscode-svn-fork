import * as vscode from 'vscode';

/**
 * 认证信息接口
 */
export interface AuthResult {
  username: string;
  password: string;
  saveCredentials?: boolean;
}

/**
 * SVN认证对话框服务
 */
export class SvnAuthDialog {

  /**
   * 显示认证信息输入对话框
   * @param repoUrl 仓库URL（用于显示）
   * @param lastUsername 上次使用的用户名（可选）
   * @returns 认证信息或null（用户取消）
   */
  public static async showAuthDialog(
    repoUrl: string,
    lastUsername?: string
  ): Promise<AuthResult | null> {
    try {
      // 显示用户名输入框
      const username = await vscode.window.showInputBox({
        prompt: `请输入SVN用户名`,
        placeHolder: '用户名',
        value: lastUsername || '',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || value.trim() === '') {
            return '用户名不能为空';
          }
          return null;
        }
      });

      if (!username) {
        return null; // 用户取消
      }

      // 显示密码输入框
      const password = await vscode.window.showInputBox({
        prompt: `请输入SVN密码`,
        placeHolder: '密码',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || value.trim() === '') {
            return '密码不能为空';
          }
          return null;
        }
      });

      if (!password) {
        return null; // 用户取消
      }

      // 询问是否保存认证信息
      const saveOption = await vscode.window.showQuickPick([
        {
          label: '✅ 保存认证信息',
          description: '下次自动使用此认证信息',
          picked: true,
          save: true
        },
        {
          label: '❌ 仅本次使用',
          description: '不保存认证信息',
          picked: false,
          save: false
        }
      ], {
        placeHolder: '是否保存认证信息以便下次使用？',
        ignoreFocusOut: true
      });

      if (!saveOption) {
        return null; // 用户取消
      }

      return {
        username: username.trim(),
        password: password.trim(),
        saveCredentials: saveOption.save
      };

    } catch (error) {
      console.error('显示认证对话框失败:', error);
      vscode.window.showErrorMessage('认证对话框显示失败');
      return null;
    }
  }

  /**
   * 显示简化的认证输入对话框（只要用户名密码）
   * @param repoUrl 仓库URL
   * @param errorMessage 错误信息（可选）
   * @returns 认证信息或null
   */
  public static async showQuickAuthDialog(
    repoUrl: string,
    errorMessage?: string
  ): Promise<{ username: string; password: string } | null> {
    try {
      // 显示错误信息（如果有）
      if (errorMessage) {
        const retryChoice = await vscode.window.showErrorMessage(
          `SVN认证失败: ${errorMessage}`,
          '重新输入认证信息',
          '取消'
        );
        
        if (retryChoice !== '重新输入认证信息') {
          return null;
        }
      }

      // 同时输入用户名和密码的多步骤输入
      const authInfo = await vscode.window.showInputBox({
        prompt: `请输入SVN认证信息 (格式: 用户名:密码)`,
        placeHolder: '例如: username:password',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || !value.includes(':')) {
            return '请按照 "用户名:密码" 的格式输入';
          }
          const parts = value.split(':');
          if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
            return '用户名和密码都不能为空';
          }
          return null;
        }
      });

      if (!authInfo) {
        return null;
      }

      const [username, password] = authInfo.split(':');
      return {
        username: username.trim(),
        password: password.trim()
      };

    } catch (error) {
      console.error('显示快速认证对话框失败:', error);
      return null;
    }
  }

  /**
   * 显示认证成功提示
   * @param repoUrl 仓库URL
   * @param username 用户名
   * @param saved 是否已保存
   */
  public static showAuthSuccessMessage(
    repoUrl: string,
    username: string,
    saved: boolean
  ): void {
    const message = saved 
      ? `认证成功！已保存用户 ${username} 的认证信息`
      : `认证成功！用户 ${username} 本次认证完成`;
    
    vscode.window.showInformationMessage(message);
  }

  /**
   * 显示认证失败提示
   * @param repoUrl 仓库URL
   * @param errorMessage 错误信息
   */
  public static showAuthFailureMessage(
    repoUrl: string,
    errorMessage: string
  ): void {
    vscode.window.showErrorMessage(`SVN认证失败: ${errorMessage}`);
  }

  /**
   * 显示认证管理的WebView面板
   * @param extensionUri 插件URI
   * @param credentials 所有认证信息
   */
  public static createAuthManagementPanel(
    extensionUri: vscode.Uri,
    credentials: Record<string, any>
  ): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'svnAuthManagement',
      'SVN认证管理',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = this.getAuthManagementHtml(credentials);

    return panel;
  }

  /**
   * 生成认证管理面板的HTML
   * @param credentials 认证信息
   * @returns HTML字符串
   */
  private static getAuthManagementHtml(credentials: Record<string, any>): string {
    const credentialsList = Object.entries(credentials).map(([url, cred]: [string, any]) => {
      return `
        <tr>
          <td>${url}</td>
          <td>${cred.username}</td>
          <td>••••••••</td>
          <td>${new Date(cred.lastUsed).toLocaleString()}</td>
          <td>
            <button onclick="testCredential('${url}')" class="button">测试</button>
            <button onclick="deleteCredential('${url}')" class="button danger">删除</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SVN认证管理</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        h1 {
            color: var(--vscode-foreground);
            margin-bottom: 20px;
        }
        
        .actions {
            margin-bottom: 20px;
        }
        
        .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 2px;
            cursor: pointer;
            margin-right: 10px;
            font-size: 13px;
        }
        
        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .button.danger {
            background-color: var(--vscode-errorForeground);
            color: white;
        }
        
        .button.danger:hover {
            opacity: 0.8;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            background-color: var(--vscode-editor-background);
        }
        
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        
        th {
            background-color: var(--vscode-editor-selectionBackground);
            font-weight: bold;
        }
        
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
        
        .empty-icon {
            font-size: 48px;
            margin-bottom: 16px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔐 SVN认证管理</h1>
        
        <div class="actions">
            <button class="button" onclick="addCredential()">➕ 添加认证</button>
            <button class="button" onclick="refreshCredentials()">🔄 刷新</button>
            <button class="button danger" onclick="clearAllCredentials()">🗑️ 清除所有</button>
        </div>
        
        ${Object.keys(credentials).length > 0 ? `
        <table>
            <thead>
                <tr>
                    <th>仓库URL</th>
                    <th>用户名</th>
                    <th>密码</th>
                    <th>最后使用</th>
                    <th>操作</th>
                </tr>
            </thead>
            <tbody>
                ${credentialsList}
            </tbody>
        </table>
        ` : `
        <div class="empty-state">
            <div class="empty-icon">🔒</div>
            <h3>暂无保存的认证信息</h3>
            <p>当SVN操作需要认证时，认证信息将自动保存在这里</p>
            <button class="button" onclick="addCredential()">手动添加认证</button>
        </div>
        `}
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function testCredential(url) {
            vscode.postMessage({
                command: 'testCredential',
                url: url
            });
        }
        
        function deleteCredential(url) {
            if (confirm('确认删除该仓库的认证信息？')) {
                vscode.postMessage({
                    command: 'deleteCredential',
                    url: url
                });
            }
        }
        
        function addCredential() {
            vscode.postMessage({
                command: 'addCredential'
            });
        }
        
        function refreshCredentials() {
            vscode.postMessage({
                command: 'refreshCredentials'
            });
        }
        
        function clearAllCredentials() {
            if (confirm('确认清除所有认证信息？此操作不可恢复！')) {
                vscode.postMessage({
                    command: 'clearAllCredentials'
                });
            }
        }
    </script>
</body>
</html>`;
  }
}
