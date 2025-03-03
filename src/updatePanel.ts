import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';

/**
 * SVN更新面板
 */
export class SvnUpdatePanel {
  public static currentPanel: SvnUpdatePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly fsPath: string;
  private readonly svnService: SvnService;
  private disposables: vscode.Disposable[] = [];
  private updateOutput: string = '';
  private isUpdating: boolean = false;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    fsPath: string,
    svnService: SvnService
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.fsPath = fsPath;
    this.svnService = svnService;

    // 设置WebView内容
    this.update();

    // 当面板关闭时清理资源
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 处理来自WebView的消息
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'startUpdate':
            await this.startUpdate();
            return;
          case 'close':
            this.panel.dispose();
            return;
        }
      },
      null,
      this.disposables
    );
  }

  /**
   * 创建或显示更新面板
   */
  public static async createOrShow(
    extensionUri: vscode.Uri,
    fsPath: string,
    svnService: SvnService
  ): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果已经有面板，则显示它
    if (SvnUpdatePanel.currentPanel) {
      SvnUpdatePanel.currentPanel.panel.reveal(column);
      return;
    }

    // 否则，创建一个新面板
    const panel = vscode.window.createWebviewPanel(
      'svnUpdate',
      `SVN更新: ${path.basename(fsPath)}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true
      }
    );

    SvnUpdatePanel.currentPanel = new SvnUpdatePanel(
      panel,
      extensionUri,
      fsPath,
      svnService
    );

    // 自动开始更新
    await SvnUpdatePanel.currentPanel.startUpdate();
  }

  /**
   * 开始更新
   */
  private async startUpdate() {
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;
    this.updateOutput = '正在更新，请稍候...\n';
    this.updateWebview();

    try {
      // 执行SVN更新命令并获取输出
      const updateResult = await this.svnService.executeSvnCommand('update', this.fsPath);
      
      // 解析更新结果
      this.updateOutput = this.formatUpdateOutput(updateResult);
      
      // 更新WebView内容
      this.updateWebview();
      
      // 显示成功消息
      vscode.window.showInformationMessage(`SVN更新完成`);
    } catch (error: any) {
      this.updateOutput = `更新失败: ${error.message}\n`;
      this.updateWebview();
      vscode.window.showErrorMessage(`SVN更新失败: ${error.message}`);
    } finally {
      this.isUpdating = false;
      this.updateWebview();
    }
  }

  /**
   * 格式化更新输出
   */
  private formatUpdateOutput(output: string): string {
    // 如果输出为空，返回默认消息
    if (!output || output.trim() === '') {
      return '更新完成，没有文件被更新。';
    }

    // 处理输出
    let formattedOutput = '更新结果:\n\n';
    
    // 按行分割输出
    const lines = output.split('\n');
    
    // 处理每一行
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '') {
        continue;
      }
      
      // 检查是否是更新行（通常以字母+空格开头，如"A "、"U "等）
      if (/^[A-Z]\s+/.test(trimmedLine)) {
        const action = trimmedLine.charAt(0);
        const filePath = trimmedLine.substring(1).trim();
        
        let actionText = '';
        switch (action) {
          case 'A': actionText = '添加'; break;
          case 'D': actionText = '删除'; break;
          case 'U': actionText = '更新'; break;
          case 'C': actionText = '冲突'; break;
          case 'G': actionText = '合并'; break;
          case 'E': actionText = '已存在'; break;
          case 'R': actionText = '替换'; break;
          default: actionText = action;
        }
        
        formattedOutput += `[${actionText}] ${filePath}\n`;
      } else {
        // 其他行直接添加
        formattedOutput += `${trimmedLine}\n`;
      }
    }
    
    return formattedOutput;
  }

  /**
   * 更新WebView内容
   */
  private update() {
    this.panel.title = `SVN更新: ${path.basename(this.fsPath)}`;
    this.updateWebview();
  }

  /**
   * 更新WebView内容
   */
  private updateWebview() {
    const webview = this.panel.webview;
    webview.html = this.getHtmlForWebview();
  }

  /**
   * 获取WebView的HTML内容
   */
  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SVN更新</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 10px;
        }
        .container {
          display: flex;
          flex-direction: column;
          height: 100vh;
        }
        .output-container {
          flex: 1;
          padding: 10px;
          border: 1px solid var(--vscode-panel-border);
          background-color: var(--vscode-editor-background);
          overflow: auto;
          white-space: pre-wrap;
          font-family: monospace;
          margin-bottom: 10px;
        }
        .button-container {
          display: flex;
          justify-content: flex-end;
        }
        button {
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 8px 12px;
          margin-left: 10px;
          cursor: pointer;
        }
        button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        h2 {
          margin-top: 0;
          color: var(--vscode-foreground);
        }
        .file-info {
          margin-bottom: 10px;
          color: var(--vscode-descriptionForeground);
        }
        .update-button {
          margin-top: 10px;
          margin-bottom: 10px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>SVN更新</h2>
        <div class="file-info">${this.fsPath}</div>
        <div class="output-container">${this.updateOutput}</div>
        
        <div class="button-container">
          <button id="update-button" class="update-button" ${this.isUpdating ? 'disabled' : ''}>
            ${this.isUpdating ? '正在更新...' : '重新更新'}
          </button>
          <button id="close-button">关闭</button>
        </div>
      </div>

      <script>
        (function() {
          const vscode = acquireVsCodeApi();
          
          // 获取元素
          const updateButton = document.getElementById('update-button');
          const closeButton = document.getElementById('close-button');
          
          // 更新按钮点击事件
          updateButton.addEventListener('click', () => {
            updateButton.disabled = true;
            updateButton.textContent = '正在更新...';
            
            vscode.postMessage({
              command: 'startUpdate'
            });
          });
          
          // 关闭按钮点击事件
          closeButton.addEventListener('click', () => {
            vscode.postMessage({
              command: 'close'
            });
          });
        }());
      </script>
    </body>
    </html>`;
  }

  /**
   * 释放资源
   */
  private dispose() {
    SvnUpdatePanel.currentPanel = undefined;

    // 清理资源
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
} 