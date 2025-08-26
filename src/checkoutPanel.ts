import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';

/**
 * SVN检出面板类
 */
export class SvnCheckoutPanel {
  /**
   * 面板视图类型标识
   */
  public static readonly viewType = 'svnCheckout';

  private static currentPanel: SvnCheckoutPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  
  // 检出参数
  private readonly _svnUrl: string;
  private readonly _targetDirectory: string;
  private readonly _svnService: SvnService;
  private readonly _credentials?: { username?: string; password?: string };
  
  // 检出状态
  private _isCheckingOut = false;
  private _isCancelled = false;

  /**
   * 创建或显示检出面板
   * @param extensionUri 扩展URI
   * @param svnUrl SVN地址
   * @param targetDirectory 目标目录
   * @param svnService SVN服务实例
   * @param credentials 认证信息
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    svnUrl: string,
    targetDirectory: string,
    svnService: SvnService,
    credentials?: { username?: string; password?: string }
  ) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果已有面板存在，则显示它
    if (SvnCheckoutPanel.currentPanel) {
      SvnCheckoutPanel.currentPanel._panel.reveal(column);
      return;
    }

    // 否则，创建新面板
    const panel = vscode.window.createWebviewPanel(
      SvnCheckoutPanel.viewType,
      'SVN检出',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'out'),
          vscode.Uri.joinPath(extensionUri, 'src')
        ]
      }
    );

    SvnCheckoutPanel.currentPanel = new SvnCheckoutPanel(
      panel, 
      extensionUri, 
      svnUrl, 
      targetDirectory, 
      svnService, 
      credentials
    );
  }

  /**
   * 构造函数
   */
  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    svnUrl: string,
    targetDirectory: string,
    svnService: SvnService,
    credentials?: { username?: string; password?: string }
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._svnUrl = svnUrl;
    this._targetDirectory = targetDirectory;
    this._svnService = svnService;
    this._credentials = credentials;

    // 设置webview的初始HTML内容
    this._update();

    // 监听面板关闭事件
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // 处理来自webview的消息
    this._panel.webview.onDidReceiveMessage(
      message => {
        switch (message.command) {
          case 'startCheckout':
            this._startCheckout();
            return;
          case 'cancelCheckout':
            this._cancelCheckout();
            return;
          case 'close':
            this.dispose();
            return;
        }
      },
      null,
      this._disposables
    );
  }

  /**
   * 开始检出操作
   */
  private async _startCheckout() {
    if (this._isCheckingOut) {
      return;
    }

    this._isCheckingOut = true;
    this._isCancelled = false;

    // 发送开始检出消息到webview
    this._panel.webview.postMessage({
      command: 'updateStatus',
      status: 'starting',
      message: '正在准备检出...',
      progress: 0
    });

    try {
      // 执行检出操作
      const result = await this._svnService.checkout(
        this._svnUrl,
        this._targetDirectory,
        this._credentials?.username,
        this._credentials?.password,
        (message: string, progress?: number) => {
          // 发送进度更新到webview
          if (!this._isCancelled) {
            this._panel.webview.postMessage({
              command: 'updateProgress',
              message,
              progress
            });
          }
        }
      );

      if (this._isCancelled) {
        // 检出被取消
        this._panel.webview.postMessage({
          command: 'updateStatus',
          status: 'cancelled',
          message: '检出操作已取消',
          progress: 0
        });
      } else if (result.success) {
        // 检出成功
        this._panel.webview.postMessage({
          command: 'updateStatus',
          status: 'completed',
          message: '检出完成！',
          progress: 100,
          details: result.message
        });

        // 显示成功提示
        vscode.window.showInformationMessage(
          '🎉 SVN检出成功完成！',
          '打开文件夹',
          '关闭'
        ).then(selection => {
          if (selection === '打开文件夹') {
            // 在新窗口中打开检出的文件夹
            vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this._targetDirectory), true);
          }
        });
      } else {
        // 检出失败
        this._panel.webview.postMessage({
          command: 'updateStatus',
          status: 'failed',
          message: '检出失败',
          progress: 0,
          details: result.message
        });

        // 显示错误提示
        vscode.window.showErrorMessage(`SVN检出失败: ${result.message}`);
      }
    } catch (error: any) {
      // 发生异常
      this._panel.webview.postMessage({
        command: 'updateStatus',
        status: 'failed',
        message: '检出操作发生异常',
        progress: 0,
        details: error.message
      });

      vscode.window.showErrorMessage(`SVN检出异常: ${error.message}`);
    } finally {
      this._isCheckingOut = false;
    }
  }

  /**
   * 取消检出操作
   */
  private _cancelCheckout() {
    if (this._isCheckingOut) {
      this._isCancelled = true;
      
      // 发送取消消息到webview
      this._panel.webview.postMessage({
        command: 'updateStatus',
        status: 'cancelling',
        message: '正在取消检出操作...',
        progress: 0
      });
    }
  }

  /**
   * 释放资源
   */
  public dispose() {
    SvnCheckoutPanel.currentPanel = undefined;

    // 清理资源
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  /**
   * 更新webview内容
   */
  private _update() {
    const webview = this._panel.webview;
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  /**
   * 获取webview的HTML内容
   */
  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
    <title>SVN检出</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
        }
        
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        
        .header {
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 15px;
            margin-bottom: 20px;
        }
        
        .header h1 {
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 24px;
        }
        
        .info-section {
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .info-item {
            margin-bottom: 10px;
        }
        
        .info-label {
            font-weight: bold;
            color: var(--vscode-foreground);
            margin-right: 10px;
        }
        
        .info-value {
            color: var(--vscode-descriptionForeground);
            word-break: break-all;
        }
        
        .progress-section {
            margin: 20px 0;
        }
        
        .progress-bar {
            width: 100%;
            height: 20px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            overflow: hidden;
            margin: 10px 0;
        }
        
        .progress-fill {
            height: 100%;
            background-color: var(--vscode-progressBar-background);
            width: 0%;
            transition: width 0.3s ease;
        }
        
        .progress-text {
            text-align: center;
            margin: 10px 0;
            color: var(--vscode-foreground);
        }
        
        .status-section {
            margin: 20px 0;
            padding: 15px;
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
        }
        
        .status-ready {
            background-color: var(--vscode-inputValidation-infoBackground);
            border-color: var(--vscode-inputValidation-infoBorder);
        }
        
        .status-running {
            background-color: var(--vscode-inputValidation-warningBackground);
            border-color: var(--vscode-inputValidation-warningBorder);
        }
        
        .status-completed {
            background-color: var(--vscode-list-successIcon-foreground);
            color: white;
        }
        
        .status-failed {
            background-color: var(--vscode-inputValidation-errorBackground);
            border-color: var(--vscode-inputValidation-errorBorder);
        }
        
        .status-cancelled {
            background-color: var(--vscode-button-secondaryBackground);
            border-color: var(--vscode-button-secondaryBorder);
        }
        
        .buttons {
            margin: 20px 0;
            text-align: center;
        }
        
        .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 10px 20px;
            margin: 0 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-family: var(--vscode-font-family);
        }
        
        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        
        .button-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        
        .button-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        
        .details {
            margin-top: 15px;
            padding: 10px;
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            white-space: pre-wrap;
            word-break: break-word;
            max-height: 200px;
            overflow-y: auto;
        }
        
        .icon {
            font-size: 16px;
            margin-right: 8px;
        }
        
        .hidden {
            display: none;
        }
        
        .loading {
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔄 SVN检出</h1>
        </div>
        
        <div class="info-section">
            <div class="info-item">
                <span class="info-label">🌐 SVN地址:</span>
                <span class="info-value">${this._svnUrl}</span>
            </div>
            <div class="info-item">
                <span class="info-label">📁 目标目录:</span>
                <span class="info-value">${this._targetDirectory}</span>
            </div>
            <div class="info-item">
                <span class="info-label">🔐 认证方式:</span>
                <span class="info-value">${this._credentials?.username ? `用户名: ${this._credentials.username}` : '使用默认凭据'}</span>
            </div>
        </div>
        
        <div class="status-section status-ready" id="statusSection">
            <div id="statusMessage">
                <span class="icon">ℹ️</span>
                <span>准备开始检出，点击"开始检出"按钮</span>
            </div>
            <div class="details hidden" id="statusDetails"></div>
        </div>
        
        <div class="progress-section">
            <div class="progress-bar">
                <div class="progress-fill" id="progressFill"></div>
            </div>
            <div class="progress-text" id="progressText">等待开始...</div>
        </div>
        
        <div class="buttons">
            <button class="button" id="startButton" onclick="startCheckout()">
                🚀 开始检出
            </button>
            <button class="button button-secondary hidden" id="cancelButton" onclick="cancelCheckout()">
                ❌ 取消
            </button>
            <button class="button button-secondary" id="closeButton" onclick="closePanel()">
                🔚 关闭
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentStatus = 'ready';
        
        function startCheckout() {
            vscode.postMessage({ command: 'startCheckout' });
        }
        
        function cancelCheckout() {
            vscode.postMessage({ command: 'cancelCheckout' });
        }
        
        function closePanel() {
            vscode.postMessage({ command: 'close' });
        }
        
        function updateProgress(message, progress) {
            const progressFill = document.getElementById('progressFill');
            const progressText = document.getElementById('progressText');
            
            if (progress !== undefined) {
                progressFill.style.width = progress + '%';
            }
            
            if (message) {
                progressText.textContent = message;
            }
        }
        
        function updateStatus(status, message, progress, details) {
            currentStatus = status;
            const statusSection = document.getElementById('statusSection');
            const statusMessage = document.getElementById('statusMessage');
            const statusDetails = document.getElementById('statusDetails');
            const startButton = document.getElementById('startButton');
            const cancelButton = document.getElementById('cancelButton');
            const closeButton = document.getElementById('closeButton');
            
            // 更新状态样式
            statusSection.className = 'status-section status-' + status;
            
            // 更新状态消息
            let icon = 'ℹ️';
            switch (status) {
                case 'starting':
                case 'running':
                    icon = '⏳';
                    break;
                case 'completed':
                    icon = '✅';
                    break;
                case 'failed':
                    icon = '❌';
                    break;
                case 'cancelled':
                    icon = '⏹️';
                    break;
                case 'cancelling':
                    icon = '🛑';
                    break;
            }
            
            statusMessage.innerHTML = '<span class="icon">' + icon + '</span><span>' + message + '</span>';
            
            // 更新详细信息
            if (details) {
                statusDetails.textContent = details;
                statusDetails.classList.remove('hidden');
            } else {
                statusDetails.classList.add('hidden');
            }
            
            // 更新进度
            if (progress !== undefined) {
                updateProgress(message, progress);
            }
            
            // 更新按钮状态
            switch (status) {
                case 'ready':
                    startButton.classList.remove('hidden');
                    startButton.disabled = false;
                    cancelButton.classList.add('hidden');
                    closeButton.disabled = false;
                    break;
                case 'starting':
                case 'running':
                    startButton.classList.add('hidden');
                    cancelButton.classList.remove('hidden');
                    cancelButton.disabled = false;
                    closeButton.disabled = true;
                    break;
                case 'cancelling':
                    cancelButton.disabled = true;
                    closeButton.disabled = true;
                    break;
                case 'completed':
                case 'failed':
                case 'cancelled':
                    startButton.classList.add('hidden');
                    cancelButton.classList.add('hidden');
                    closeButton.disabled = false;
                    closeButton.textContent = '🔚 关闭';
                    break;
            }
        }
        
        // 监听来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'updateStatus':
                    updateStatus(message.status, message.message, message.progress, message.details);
                    break;
                case 'updateProgress':
                    updateProgress(message.message, message.progress);
                    break;
            }
        });
    </script>
</body>
</html>`;
  }
}
