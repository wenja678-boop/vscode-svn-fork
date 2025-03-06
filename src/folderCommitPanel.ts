import * as vscode from 'vscode';
import { SvnService } from './svnService';
import { SvnDiffProvider } from './diffProvider';
import { CommitLogStorage } from './commitLogStorage';
import * as path from 'path';
import { AiService } from './aiService';

interface FileStatus {
    path: string;
    status: string;
    type: 'modified' | 'added' | 'deleted' | 'unversioned' | 'conflict' | 'missing';
    displayName: string;
}

export class SvnFolderCommitPanel {
    public static currentPanel: SvnFolderCommitPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _fileStatuses: FileStatus[] = [];
    private readonly aiService: AiService;
    private outputChannel: vscode.OutputChannel;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly folderPath: string,
        private readonly svnService: SvnService,
        private readonly diffProvider: SvnDiffProvider,
        private readonly logStorage: CommitLogStorage
    ) {
        this._panel = panel;
        this.aiService = new AiService();
        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setupMessageHandlers();
        this.outputChannel = vscode.window.createOutputChannel('SVN 文件夹提交');
    }

    public static async createOrShow(
        extensionUri: vscode.Uri,
        folderPath: string,
        svnService: SvnService,
        diffProvider: SvnDiffProvider,
        logStorage: CommitLogStorage
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SvnFolderCommitPanel.currentPanel) {
            SvnFolderCommitPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'svnFolderCommit',
            '提交文件夹到SVN',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        SvnFolderCommitPanel.currentPanel = new SvnFolderCommitPanel(
            panel,
            extensionUri,
            folderPath,
            svnService,
            diffProvider,
            logStorage
        );
    }

    private async _update() {
        const webview = this._panel.webview;
        this._panel.title = `提交文件夹到SVN: ${path.basename(this.folderPath)}`;
        
        // 获取文件状态
        await this._updateFileStatuses();
        
        // 生成HTML
        webview.html = this._getHtmlForWebview();
    }

    private async _updateFileStatuses() {
        try {
            // 使用原生格式获取状态
            const statusResult = await this.svnService.executeSvnCommand('status', this.folderPath, false);
            console.log('SVN status result:', statusResult);

            this._fileStatuses = statusResult
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('>'))  // 过滤空行和树冲突的详细信息
                .map(line => {
                    // SVN status 输出格式：
                    // 第一列：文件状态 (M:修改, A:新增, D:删除, ?:未版本控制, C:冲突, !:丢失等)
                    // 第8列开始：文件路径
                    const status = line[0];
                    const filePath = line.substring(8).trim();
                    console.log('Processing line:', { status, filePath });

                    let type: 'modified' | 'added' | 'deleted' | 'unversioned' | 'conflict' | 'missing';
                    switch (status) {
                        case 'M':
                            type = 'modified';
                            break;
                        case 'A':
                            type = 'added';
                            break;
                        case 'D':
                            type = 'deleted';
                            break;
                        case 'C':
                            type = 'conflict';
                            break;
                        case '!':
                            type = 'missing';
                            break;
                        case '?':
                        default:
                            type = 'unversioned';
                    }

                    // 使用 path.resolve 获取绝对路径
                    const absolutePath = path.resolve(this.folderPath, filePath);
                    
                    return {
                        path: absolutePath,
                        status: this._getStatusText(status),
                        type,
                        displayName: filePath // 使用相对路径作为显示名称
                    };
                });

            console.log('Processed file statuses:', this._fileStatuses);
        } catch (error) {
            console.error('Error updating file statuses:', error);
            vscode.window.showErrorMessage(`更新文件状态失败: ${error}`);
            this._fileStatuses = [];
        }
    }

    private _getStatusText(status: string): string {
        switch (status) {
            case 'M': return '已修改';
            case 'A': return '新增';
            case 'D': return '已删除';
            case '?': return '未版本控制';
            case '!': return '丢失';
            case 'C': return '冲突';
            case 'X': return '外部定义';
            case 'I': return '已忽略';
            case '~': return '类型变更';
            case 'R': return '已替换';
            default: return `未知状态(${status})`;
        }
    }

    private async _showFileDiff(filePath: string) {
        // 创建新的webview面板显示文件差异
        const diffPanel = vscode.window.createWebviewPanel(
            'svnFileDiff',
            `文件差异: ${path.basename(filePath)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        const diff = await this.diffProvider.getDiff(filePath);
        diffPanel.webview.html = this._getHtmlForDiffView(filePath, diff);
    }

    private async _commitFiles(files: string[], message: string) {
        try {
            if (files.length === 0) {
                throw new Error('请选择要提交的文件');
            }

            // 先添加未版本控制的文件
            const unversionedFiles = files.filter(file => 
                this._fileStatuses.find(f => f.path === file)?.type === 'unversioned'
            );
            
            if (unversionedFiles.length > 0) {
                for (const file of unversionedFiles) {
                    await this.svnService.addFile(file);
                }
            }

            // 提交选中的文件
            for (const file of files) {
                await this.svnService.commit(file, message);
            }

            // 保存提交日志
            this.logStorage.addLog(message, this.folderPath);

            vscode.window.showInformationMessage('文件已成功提交到SVN');
            this._panel.dispose();
        } catch (error: any) {
            vscode.window.showErrorMessage(`提交失败: ${error.message}`);
        }
    }

    private async _generateAICommitLog(): Promise<string> {
        try {
            // 获取选中的文件路径
            const selectedFilePaths = await new Promise<string[]>((resolve) => {
                const handler = this._panel.webview.onDidReceiveMessage(message => {
                    if (message.command === 'selectedFiles') {
                        handler.dispose();
                        resolve(message.files);
                    }
                });
                this._panel.webview.postMessage({ command: 'getSelectedFiles' });
            });

            if (!selectedFilePaths || selectedFilePaths.length === 0) {
                throw new Error('请选择要生成提交日志的文件');
            }

            // 获取所有选中文件的差异信息
            const fileStatusesAndDiffs = await Promise.all(
                selectedFilePaths.map(async (filePath) => {
                    const fileStatus = this._fileStatuses.find(f => f.path === filePath);
                    if (!fileStatus) {
                        return null;
                    }

                    // 对于新增和未版本控制的文件，不需要获取差异
                    if (fileStatus.type === 'added' || fileStatus.type === 'unversioned') {
                        return {
                            path: fileStatus.displayName,
                            status: fileStatus.status,
                            diff: `新文件: ${fileStatus.displayName}`
                        };
                    }

                    // 对于删除的文件
                    if (fileStatus.type === 'deleted') {
                        return {
                            path: fileStatus.displayName,
                            status: fileStatus.status,
                            diff: `删除文件: ${fileStatus.displayName}`
                        };
                    }

                    // 获取文件差异
                    const diff = await this.diffProvider.getDiff(filePath);
                    return {
                        path: fileStatus.displayName,
                        status: fileStatus.status,
                        diff: diff
                    };
                })
            );

            // 过滤掉无效的结果
            const validDiffs = fileStatusesAndDiffs.filter(item => item !== null);

            if (validDiffs.length === 0) {
                throw new Error('没有可用的文件差异信息');
            }

            // 格式化差异信息
            const formattedDiffs = validDiffs.map(item => 
                `文件: ${item!.path} (${item!.status})\n${item!.diff}`
            ).join('\n\n');

            // 使用 AI 生成提交日志
            const commitMessage = await this.aiService.generateCommitMessage(formattedDiffs);

            this.outputChannel.appendLine(`[generateAICommitLog] 生成的提交日志: ${commitMessage}`);
            
            return commitMessage;
        } catch (error: any) {
            vscode.window.showErrorMessage(`生成AI提交日志失败: ${error.message}`);
            return '';
        }
    }

    private _setupMessageHandlers() {
        // 添加一个标志，表示 AI 生成是否正在进行中
        let isGeneratingAILog = false;

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'commit':
                        await this._commitFiles(message.files, message.message);
                        return;
                    case 'showDiff':
                        await this._showFileDiff(message.file);
                        return;
                    case 'generateAILog':
                        // 如果已经在生成中，则不再重复调用
                        if (isGeneratingAILog) {
                            this.outputChannel.appendLine(`[generateAILog] 已有 AI 生成任务正在进行中，忽略此次请求`);
                            return;
                        }

                        try {
                            isGeneratingAILog = true;
                            this._panel.webview.postMessage({ command: 'setGeneratingStatus', status: true });
                            
                            // 生成 AI 日志
                            const aiLog = await this._generateAICommitLog();
                            
                            // 应用前缀
                            if (aiLog) {
                                const messageWithPrefix = await this._applyPrefix(aiLog);
                                this._panel.webview.postMessage({ 
                                    command: 'setCommitMessage', 
                                    message: messageWithPrefix 
                                });
                            }
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`生成 AI 提交日志失败: ${error.message}`);
                        } finally {
                            isGeneratingAILog = false;
                            this._panel.webview.postMessage({ command: 'setGeneratingStatus', status: false });
                        }
                        return;
                    case 'savePrefix':
                        // 保存前缀到历史记录
                        this.logStorage.addPrefix(message.prefix);
                        return;
                    case 'selectedFiles':
                        // 处理选中的文件列表
                        return;
                    case 'showSideBySideDiff':
                        // 查找文件状态
                        const fileStatus = this._fileStatuses.find(f => f.path === message.file);
                        if (fileStatus && fileStatus.type === 'modified') {
                            // 如果是修改状态，显示左右对比
                            await this.diffProvider.showDiff(message.file);
                        } else {
                            // 其他状态，直接打开文件
                            const uri = vscode.Uri.file(message.file);
                            try {
                                await vscode.commands.executeCommand('vscode.open', uri);
                            } catch (error: any) {
                                vscode.window.showErrorMessage(`打开文件失败: ${error.message}`);
                            }
                        }
                        return;
                    case 'revertFile':
                        await this._revertFile(message.file);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private async _applyPrefix(commitMessage: string): Promise<string> {
        // 获取当前前缀
        const prefix = await new Promise<string>((resolve) => {
            const handler = this._panel.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'currentPrefix') {
                    handler.dispose();
                    resolve(msg.prefix);
                }
            });
            this._panel.webview.postMessage({ command: 'getCurrentPrefix' });
        });
        
        // 如果有前缀，添加到提交日志前面
        const finalMessage = prefix.trim() 
            ? `${prefix.trim()}\n${commitMessage}`
            : commitMessage;

        return finalMessage;
    }

    private _getHtmlForWebview(): string {
        const webview = this._panel.webview;

        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        body { 
            padding: 10px; 
            display: flex;
            flex-direction: column;
            height: 100vh;
            margin: 0;
            box-sizing: border-box;
        }
        .filter-section {
            margin-bottom: 10px;
            padding: 8px;
            background-color: var(--vscode-panel-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .filter-section label {
            margin-right: 15px;
            user-select: none;
        }
        .file-list-container {
            flex: 1;
            overflow: auto;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            margin-bottom: 10px;
            min-height: 200px;
        }
        .file-list { 
            width: 100%;
            border-collapse: collapse;
        }
        .file-list-header {
            position: sticky;
            top: 0;
            display: grid;
            grid-template-columns: 30px minmax(150px, 2fr) minmax(200px, 3fr) 100px 180px;
            padding: 8px;
            font-weight: bold;
            background-color: var(--vscode-panel-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            z-index: 1;
        }
        .file-item { 
            display: grid;
            grid-template-columns: 30px minmax(150px, 2fr) minmax(200px, 3fr) 100px 180px;
            padding: 4px 8px;
            cursor: pointer;
            align-items: center;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .file-item:last-child {
            border-bottom: none;
        }
        .file-item:hover { 
            background-color: var(--vscode-list-hoverBackground);
        }
        .file-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .file-name, .file-path {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .file-status {
            text-align: center;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            padding: 0 4px;
        }
        .file-action {
            text-align: right;
            display: flex;
            gap: 4px;
            justify-content: flex-end;
            min-width: 0;
        }
        .file-action button {
            padding: 2px 4px;
            font-size: 11px;
            white-space: nowrap;
            min-width: fit-content;
        }
        .revert-button {
            background-color: var(--vscode-errorForeground) !important;
            opacity: 0.8;
        }
        .revert-button:hover {
            opacity: 1;
        }
        .status-modified { color: #FFCC00; }
        .status-added { color: #73C991; }
        .status-deleted { color: #F14C4C; }
        .status-unversioned { color: #C586C0; }
        .status-conflict { color: #FF0000; font-weight: bold; }
        .status-missing { color: #FF8800; }
        .commit-section { 
            flex-shrink: 0;
            padding: 10px;
            background-color: var(--vscode-panel-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .commit-section textarea { 
            width: 100%; 
            height: 80px; 
            margin: 10px 0;
            font-family: var(--vscode-editor-font-family);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            box-sizing: border-box;
        }
        .commit-section button { 
            margin-right: 10px;
            padding: 4px 12px;
        }
        .prefix-section {
            margin-bottom: 10px;
        }
        .prefix-container {
            display: flex;
            gap: 5px;
            margin-bottom: 10px;
        }
        .prefix-input {
            flex: 1;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 4px;
        }
        #prefixSelect {
            flex: 1;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px;
        }
        #applyPrefixButton {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 8px;
            cursor: pointer;
        }
        #applyPrefixButton:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 4px 8px;
            cursor: pointer;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .checkbox-group {
            display: flex;
            gap: 15px;
            align-items: center;
        }
        .checkbox-cell {
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .checkbox-cell input[type="checkbox"] {
            cursor: pointer;
        }
        textarea {
            width: 100%;
            min-height: 100px;
            margin: 10px 0;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            box-sizing: border-box;
        }
    </style>
</head>
<body>
    <div class="filter-section">
        <div class="checkbox-group">
            <label>
                <input type="checkbox" id="modified-checkbox" checked>
                已修改
            </label>
            <label>
                <input type="checkbox" id="added-checkbox" checked>
                新增
            </label>
            <label>
                <input type="checkbox" id="deleted-checkbox" checked>
                已删除
            </label>
            <label>
                <input type="checkbox" id="unversioned-checkbox" checked>
                未版本控制
            </label>
        </div>
    </div>

    <div class="file-list-container">
        <div class="file-list">
            <div class="file-list-header">
                <span class="checkbox-cell">
                    <input type="checkbox" id="selectAll">
                </span>
                <span>文件名</span>
                <span>路径</span>
                <span class="file-status">状态</span>
                <span class="file-action">操作</span>
            </div>
            <div id="fileListContent">
                ${this._renderFileList(this._fileStatuses)}
            </div>
        </div>
    </div>

    <div class="commit-section">
        <div class="prefix-section">
            <div class="prefix-container">
                <select id="prefixSelect">
                    ${this._renderPrefixOptions()}
                </select>
                <input type="text" id="prefixInput" class="prefix-input" placeholder="日志前缀" value="${this.logStorage.getLatestPrefix()}">
                <button id="applyPrefixButton">应用前缀</button>
            </div>
        </div>
        <textarea id="commitMessage" placeholder="请输入提交信息">${this.logStorage.getLatestPrefix()}</textarea>
        <div class="button-container">
            <button id="submitButton">提交</button>
            <button id="generateAIButton">使用AI生成提交日志</button>
        </div>
    </div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            let selectedFiles = new Set();
            let enabledTypes = new Set(['modified', 'added', 'deleted', 'unversioned']);

            function initializeEventListeners() {
                // 类型过滤复选框
                document.getElementById('modified-checkbox').addEventListener('change', () => toggleFileType('modified'));
                document.getElementById('added-checkbox').addEventListener('change', () => toggleFileType('added'));
                document.getElementById('deleted-checkbox').addEventListener('change', () => toggleFileType('deleted'));
                document.getElementById('unversioned-checkbox').addEventListener('change', () => toggleFileType('unversioned'));

                // 全选复选框
                document.getElementById('selectAll').addEventListener('change', (e) => toggleAllFiles(e.target.checked));

                // 前缀相关
                document.getElementById('prefixSelect').addEventListener('change', updateCommitMessage);
                document.getElementById('applyPrefixButton').addEventListener('click', applyPrefix);

                // 提交按钮
                document.getElementById('submitButton').addEventListener('click', submitCommit);
                document.getElementById('generateAIButton').addEventListener('click', generateAILog);

                // 文件项点击事件
                document.querySelectorAll('.file-item').forEach(item => {
                    const checkbox = item.querySelector('.file-checkbox');
                    const diffButton = item.querySelector('.diff-button');
                    const sideBySideButton = item.querySelector('.side-by-side-button');
                    const revertButton = item.querySelector('.revert-button');
                    const filePath = item.getAttribute('data-path');

                    if (checkbox) {
                        checkbox.addEventListener('change', (e) => {
                            if (e.target.checked) {
                                selectedFiles.add(filePath);
                            } else {
                                selectedFiles.delete(filePath);
                            }
                            updateSelectAllCheckbox();
                        });
                    }

                    if (diffButton) {
                        diffButton.addEventListener('click', (e) => {
                            e.stopPropagation();
                            showDiff(filePath);
                        });
                    }

                    if (sideBySideButton) {
                        sideBySideButton.addEventListener('click', (e) => {
                            e.stopPropagation();
                            showSideBySideDiff(filePath);
                        });
                    }

                    if (revertButton) {
                        revertButton.addEventListener('click', (e) => {
                            e.stopPropagation();
                            revertFile(filePath);
                        });
                    }
                });

                // 初始化页面状态
                updateFileList();
                updateCheckboxes();
            }

            function toggleFileType(type) {
                if (enabledTypes.has(type)) {
                    enabledTypes.delete(type);
                    document.getElementById(type + '-checkbox').checked = false;
                } else {
                    enabledTypes.add(type);
                    document.getElementById(type + '-checkbox').checked = true;
                }
                updateFileList();
            }

            function updateFileList() {
                const fileItems = document.querySelectorAll('.file-item');
                let visibleCount = 0;
                
                fileItems.forEach(item => {
                    const type = item.getAttribute('data-type');
                    if (enabledTypes.has(type)) {
                        item.style.display = '';
                        visibleCount++;
                    } else {
                        item.style.display = 'none';
                        const filePath = item.getAttribute('data-path');
                        if (selectedFiles.has(filePath)) {
                            selectedFiles.delete(filePath);
                        }
                    }
                });
                
                updateSelectAllCheckbox();
            }

            function toggleAllFiles(checked) {
                const visibleFiles = Array.from(document.querySelectorAll('.file-item'))
                    .filter(item => item.style.display !== 'none')
                    .map(item => item.getAttribute('data-path'));
                
                if (checked) {
                    visibleFiles.forEach(path => selectedFiles.add(path));
                } else {
                    visibleFiles.forEach(path => selectedFiles.delete(path));
                }
                updateCheckboxes();
            }

            function updateCheckboxes() {
                document.querySelectorAll('.file-item').forEach(item => {
                    const filePath = item.getAttribute('data-path');
                    const checkbox = item.querySelector('.file-checkbox');
                    if (checkbox) {
                        checkbox.checked = selectedFiles.has(filePath);
                    }
                });
                updateSelectAllCheckbox();
            }

            function updateSelectAllCheckbox() {
                const visibleFiles = Array.from(document.querySelectorAll('.file-item'))
                    .filter(item => item.style.display !== 'none')
                    .map(item => item.getAttribute('data-path'));
                
                const allChecked = visibleFiles.length > 0 && 
                    visibleFiles.every(path => selectedFiles.has(path));
                
                const selectAllCheckbox = document.getElementById('selectAll');
                if (selectAllCheckbox) {
                    selectAllCheckbox.checked = allChecked;
                    selectAllCheckbox.disabled = visibleFiles.length === 0;
                }
            }

            function showDiff(filePath) {
                vscode.postMessage({ command: 'showDiff', file: filePath });
            }

            function showSideBySideDiff(filePath) {
                vscode.postMessage({ command: 'showSideBySideDiff', file: filePath });
            }

            function submitCommit() {
                const message = document.getElementById('commitMessage').value;
                if (!message) {
                    vscode.postMessage({ 
                        command: 'showError',
                        text: '请输入提交信息'
                    });
                    return;
                }
                
                const selectedFilesList = Array.from(selectedFiles);
                if (selectedFilesList.length === 0) {
                    vscode.postMessage({
                        command: 'showError',
                        text: '请选择要提交的文件'
                    });
                    return;
                }

                vscode.postMessage({
                    command: 'commit',
                    message: message,
                    files: selectedFilesList
                });
            }

            function generateAILog() {
                vscode.postMessage({ command: 'generateAILog' });
            }

            function applyPrefix() {
                const prefix = document.getElementById('prefixInput').value.trim();
                if (prefix) {
                    vscode.postMessage({
                        command: 'savePrefix',
                        prefix: prefix
                    });
                    
                    const message = document.getElementById('commitMessage');
                    const currentMessage = message.value.trim();
                    
                    const lines = currentMessage.split('\\n');
                    const newMessage = prefix + '\\n' + (lines.length > 1 ? lines.slice(1).join('\\n') : currentMessage);
                    
                    message.value = newMessage;
                }
            }

            function updateCommitMessage() {
                const prefix = document.getElementById('prefixSelect').value;
                if (prefix) {
                    document.getElementById('prefixInput').value = prefix;
                }
            }

            function revertFile(filePath) {
                vscode.postMessage({ command: 'revertFile', file: filePath });
            }

            // 监听消息
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'setCommitMessage':
                        document.getElementById('commitMessage').value = message.message;
                        break;
                    case 'getSelectedFiles':
                        vscode.postMessage({
                            command: 'selectedFiles',
                            files: Array.from(selectedFiles)
                        });
                        break;
                    case 'getCurrentPrefix':
                        const prefixInput = document.getElementById('prefixInput');
                        vscode.postMessage({
                            command: 'currentPrefix',
                            prefix: prefixInput ? prefixInput.value.trim() : ''
                        });
                        break;
                    case 'setGeneratingStatus':
                        const aiButton = document.getElementById('generateAIButton');
                        if (message.status) {
                            aiButton.disabled = true;
                            aiButton.textContent = '生成中...';
                        } else {
                            aiButton.disabled = false;
                            aiButton.textContent = '使用AI生成提交日志';
                        }
                        break;
                }
            });

            // 页面加载完成后初始化
            document.addEventListener('DOMContentLoaded', initializeEventListeners);
        })();
    </script>
</body>
</html>`;
    }

    private _renderFileList(files: FileStatus[]): string {
        return files.map(file => {
            // 转义文件路径中的特殊字符
            const escapedPath = file.path
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            
            const fileName = path.basename(file.displayName);
            const filePath = path.dirname(file.displayName);
            
            const escapedFileName = fileName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const escapedFilePath = filePath.replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // 根据状态设置不同的样式类
            let statusClass = file.type;
            if (file.status.includes('冲突')) {
                statusClass = 'conflict';
            } else if (file.status.includes('丢失')) {
                statusClass = 'missing';
            }

            // 确定是否显示恢复按钮（只在文件是已修改或已删除状态时显示）
            const showRevertButton = file.type === 'modified' || file.type === 'deleted';

            return `
                <div class="file-item status-${statusClass}" 
                     data-path="${escapedPath}"
                     data-type="${file.type}">
                    <span class="checkbox-cell">
                        <input type="checkbox" class="file-checkbox">
                    </span>
                    <span class="file-name" title="${escapedFileName}">${escapedFileName}</span>
                    <span class="file-path" title="${escapedFilePath}">${escapedFilePath}</span>
                    <span class="file-status" title="${file.status}">${file.status}</span>
                    <span class="file-action">
                        ${file.type !== 'deleted' && file.type !== 'missing' ? `
                            <button class="diff-button" title="查看内联差异">差异</button>
                            <button class="side-by-side-button" title="${file.type === 'modified' ? '查看左右对比' : '打开文件'}">${file.type === 'modified' ? '对比' : '打开'}</button>
                        ` : ''}
                        ${showRevertButton ? `
                            <button class="revert-button" title="恢复文件修改">恢复</button>
                        ` : ''}
                    </span>
                </div>
            `;
        }).join('');
    }

    private _renderPrefixOptions(): string {
        const prefixes = this.logStorage.getPrefixes();
        return prefixes.map(prefix => 
            `<option value="${prefix}">${prefix}</option>`
        ).join('');
    }

    private _getHtmlForDiffView(filePath: string, diff: string): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    .diff-content {
                        font-family: monospace;
                        white-space: pre;
                        padding: 10px;
                    }
                    .diff-added { background-color: var(--vscode-diffEditor-insertedTextBackground); }
                    .diff-removed { background-color: var(--vscode-diffEditor-removedTextBackground); }
                </style>
            </head>
            <body>
                <h2>文件差异: ${path.basename(filePath)}</h2>
                <div class="diff-content">${this._formatDiff(diff)}</div>
            </body>
            </html>
        `;
    }

    private _formatDiff(diff: string): string {
        return diff
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .split('\n')
            .map(line => {
                if (line.startsWith('+')) {
                    return `<div class="diff-added">${line}</div>`;
                } else if (line.startsWith('-')) {
                    return `<div class="diff-removed">${line}</div>`;
                }
                return `<div>${line}</div>`;
            })
            .join('');
    }

    private async _revertFile(filePath: string): Promise<void> {
        try {
            const result = await vscode.window.showWarningMessage(
                '确定要恢复此文件的修改吗？此操作不可撤销。',
                '确定',
                '取消'
            );

            if (result === '确定') {
                await this.svnService.revertFile(filePath);
                vscode.window.showInformationMessage('文件已成功恢复');
                // 刷新文件状态列表
                await this._update();
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`恢复文件失败: ${error.message}`);
        }
    }

    public dispose() {
        SvnFolderCommitPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
} 