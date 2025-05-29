import * as vscode from 'vscode';
import { SvnService } from './svnService';
import { SvnDiffProvider } from './diffProvider';
import { CommitLogStorage } from './commitLogStorage';
import { SvnFilterService } from './filterService';
import { TemplateManager } from './templateManager';
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
    private readonly filterService: SvnFilterService;
    private readonly templateManager: TemplateManager;
    private _filterStats: { totalFiles: number, filteredFiles: number, excludedFiles: number } = { totalFiles: 0, filteredFiles: 0, excludedFiles: 0 };

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
        this.filterService = new SvnFilterService();
        this.templateManager = new TemplateManager(extensionUri);
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

        // 检查是否已存在面板
        if (SvnFolderCommitPanel.currentPanel) {
            // 比较文件夹路径，如果不同则关闭旧面板
            if (SvnFolderCommitPanel.currentPanel.folderPath !== folderPath) {
                console.log(`文件夹路径不同，关闭旧面板: ${SvnFolderCommitPanel.currentPanel.folderPath} -> ${folderPath}`);
                SvnFolderCommitPanel.currentPanel.dispose();
                // 注意：dispose() 方法会将 currentPanel 设置为 undefined
            } else {
                // 相同路径，直接显示现有面板
                SvnFolderCommitPanel.currentPanel._panel.reveal(column);
                return;
            }
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
        webview.html = await this._getHtmlForWebview();
    }

    private _getFilterInfo(): { totalFiles: number, filteredFiles: number, excludedFiles: number } {
        return this._filterStats;
    }

    private async _updateFileStatuses() {
        try {
            // 使用原生格式获取状态
            const statusResult = await this.svnService.executeSvnCommand('status', this.folderPath, false);
            console.log('SVN status result:', statusResult);
            this.outputChannel.appendLine(`[_updateFileStatuses] SVN status 原始输出:\n${statusResult}`);

            // 首先处理所有文件状态
            const allFileStatuses = statusResult
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('>'))  // 过滤空行和树冲突的详细信息
                .map(line => {
                    // SVN status 输出格式：
                    // 第一列：文件状态 (M:修改, A:新增, D:删除, ?:未版本控制, C:冲突, !:丢失等)
                    // 后面跟着空格，然后是文件路径
                    const status = line[0];
                    // 找到第一个非空格字符后的文件路径
                    const match = line.match(/^.\s+(.+)$/);
                    const filePath = match ? match[1].trim() : line.substring(1).trim();
                    console.log('Processing line:', { status, filePath });
                    this.outputChannel.appendLine(`[_updateFileStatuses] 处理行: "${line}" -> 状态: "${status}", 文件路径: "${filePath}"`);

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

            // 应用过滤器排除不需要的文件
            this.outputChannel.appendLine(`[_updateFileStatuses] 开始应用过滤器，原始文件数量: ${allFileStatuses.length}`);
            const filteredFileStatuses = allFileStatuses.filter(fileStatus => {
                // 检查文件是否应该被排除
                const shouldExclude = this.filterService.shouldExcludeFile(fileStatus.path, this.folderPath);
                if (shouldExclude) {
                    console.log(`文件被过滤器排除: ${fileStatus.displayName}`);
                    this.outputChannel.appendLine(`[_updateFileStatuses] 文件被过滤器排除: ${fileStatus.displayName} (${fileStatus.status})`);
                } else {
                    this.outputChannel.appendLine(`[_updateFileStatuses] 文件通过过滤器: ${fileStatus.displayName} (${fileStatus.status})`);
                }
                return !shouldExclude;
            });

            // 记录过滤结果
            const excludedCount = allFileStatuses.length - filteredFileStatuses.length;
            this._filterStats = {
                totalFiles: allFileStatuses.length,
                filteredFiles: filteredFileStatuses.length,
                excludedFiles: excludedCount
            };
            
            if (excludedCount > 0) {
                console.log(`过滤器排除了 ${excludedCount} 个文件`);
                this.outputChannel.appendLine(`过滤器排除了 ${excludedCount} 个文件，显示 ${filteredFileStatuses.length} 个文件`);
            }

            this._fileStatuses = filteredFileStatuses;
            console.log('Processed and filtered file statuses:', this._fileStatuses);
            this.outputChannel.appendLine(`[_updateFileStatuses] 最终文件状态列表 (${this._fileStatuses.length} 个文件):`);
            this._fileStatuses.forEach((file, index) => {
                this.outputChannel.appendLine(`  ${index + 1}. ${file.displayName} (${file.status}) - ${file.type}`);
            });
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
                this.outputChannel.appendLine(`添加 ${unversionedFiles.length} 个未版本控制的文件`);
                for (const file of unversionedFiles) {
                    await this.svnService.addFile(file);
                }
            }

            // 处理丢失的文件（missing files）- 需要先标记为删除
            const missingFiles = files.filter(file => 
                this._fileStatuses.find(f => f.path === file)?.type === 'missing'
            );
            
            if (missingFiles.length > 0) {
                this.outputChannel.appendLine(`标记 ${missingFiles.length} 个丢失的文件为删除状态`);
                for (const file of missingFiles) {
                    await this.svnService.removeFile(file);
                }
            }

            // 分离文件和目录
            const fileEntries = await Promise.all(files.map(async file => {
                // 检查文件是否是missing状态
                const fileStatus = this._fileStatuses.find(f => f.path === file);
                if (fileStatus?.type === 'missing') {
                    // missing文件已经不存在，视为文件（非目录）
                    return { path: file, isDirectory: false };
                }
                
                try {
                    const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(file))).type === vscode.FileType.Directory;
                    return { path: file, isDirectory };
                } catch (error) {
                    // 如果文件不存在，视为文件（非目录）
                    return { path: file, isDirectory: false };
                }
            }));
            
            const onlyFiles = fileEntries.filter(entry => !entry.isDirectory).map(entry => entry.path);
            const directories = fileEntries.filter(entry => entry.isDirectory).map(entry => entry.path);
            
            // 如果只有文件，使用 commitFiles
            if (onlyFiles.length > 0 && directories.length === 0) {
                await this.svnService.commitFiles(onlyFiles, message, this.folderPath);
            } 
            // 如果有目录，或者混合了文件和目录，使用单独提交
            else {
                for (const file of files) {
                    await this.svnService.commit(file, message);
                }
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

                    // 对于删除的文件和丢失的文件
                    if (fileStatus.type === 'deleted' || fileStatus.type === 'missing') {
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

    private async _getHtmlForWebview(): Promise<string> {
        try {
            // 准备模板变量
            const templateVariables = {
                FILTER_INFO: this._renderFilterInfo(),
                FILE_LIST: this._renderFileList(this._fileStatuses),
                PREFIX_OPTIONS: this._renderPrefixOptions(),
                LATEST_PREFIX: this.logStorage.getLatestPrefix()
            };

            // 使用内联模板（CSS 和 JS 内嵌在 HTML 中）
            return await this.templateManager.loadInlineTemplate('folderCommitPanel', templateVariables);
        } catch (error) {
            console.error('加载模板失败，使用备用模板:', error);
            // 如果模板加载失败，返回一个简单的备用模板
            return this._getFallbackHtml();
        }
    }

    private _getFallbackHtml(): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
                <style>
                    body { padding: 20px; font-family: var(--vscode-font-family); }
                    .error { color: var(--vscode-errorForeground); }
                </style>
            </head>
            <body>
                <div class="error">
                    <h2>模板加载失败</h2>
                    <p>无法加载文件夹提交面板模板，请检查模板文件是否存在。</p>
                </div>
            </body>
            </html>
        `;
    }

    private _renderFilterInfo(): string {
        const filterInfo = this._getFilterInfo();
        const hasExcluded = filterInfo.excludedFiles > 0;
        const cssClass = hasExcluded ? 'filter-info has-excluded' : 'filter-info';
        
        if (filterInfo.totalFiles === 0) {
            return `<div class="${cssClass}">📁 没有检测到文件变更</div>`;
        }
        
        if (hasExcluded) {
            return `<div class="${cssClass}">
                🔍 文件统计: 总共 ${filterInfo.totalFiles} 个文件，显示 ${filterInfo.filteredFiles} 个，
                <strong>排除了 ${filterInfo.excludedFiles} 个文件</strong>
                <br>💡 被排除的文件不会显示在列表中，也不会被提交到SVN
            </div>`;
        } else {
            return `<div class="${cssClass}">📊 显示 ${filterInfo.filteredFiles} 个文件</div>`;
        }
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

            // 确定是否显示恢复按钮（只在文件是已修改、已删除或丢失状态时显示）
            const showRevertButton = file.type === 'modified' || file.type === 'deleted' || file.type === 'missing';

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