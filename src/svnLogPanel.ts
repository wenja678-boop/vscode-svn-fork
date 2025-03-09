import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SvnService } from './svnService';

/**
 * SVN日志条目接口
 */
interface SvnLogEntry {
    revision: string;
    author: string;
    date: string;
    message: string;
    paths?: SvnLogPath[];
}

/**
 * SVN日志路径变更接口
 */
interface SvnLogPath {
    action: string;
    path: string;
}

/**
 * SVN日志面板类
 * 用于显示文件或文件夹的SVN日志记录
 */
export class SvnLogPanel {
    public static currentPanel: SvnLogPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _logEntries: SvnLogEntry[] = [];
    private _selectedRevision: string | undefined;
    private _targetPath: string;
    private _targetSvnRelativePath: string = ''; // 存储文件夹的SVN相对路径
    private _outputChannel: vscode.OutputChannel;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        targetPath: string,
        private readonly svnService: SvnService
    ) {
        this._panel = panel;
        this._targetPath = targetPath;
        this._outputChannel = vscode.window.createOutputChannel('SVN日志面板');
        this._log('SVN日志面板已创建，目标路径: ' + targetPath);

        // 设置网页视图内容
        this._panel.webview.html = this._getHtmlForWebview();

        // 监听面板关闭事件
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 设置消息处理
        this._setupMessageHandlers();

        // 获取文件夹的SVN相对路径
        this._getSvnRelativePath();

        // 初始加载日志
        this._loadLogs();
    }

    /**
     * 记录日志
     */
    private _log(message: string) {
        this._outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    /**
     * 获取当前目标路径
     */
    public get targetPath(): string {
        return this._targetPath;
    }

    /**
     * 设置新的目标路径
     */
    public set targetPath(value: string) {
        this._targetPath = value;
        this._log('目标路径已更新: ' + value);
    }

    /**
     * 创建或显示SVN日志面板
     */
    public static async createOrShow(
        extensionUri: vscode.Uri,
        targetPath: string,
        svnService: SvnService
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 如果面板已经存在，先关闭它
        if (SvnLogPanel.currentPanel) {
            // 记录当前的日志信息
            const logMessage = `关闭并重新打开SVN日志面板，目标路径: ${targetPath}`;
            SvnLogPanel.currentPanel._log(logMessage);
            
            // 关闭并清理当前面板
            SvnLogPanel.currentPanel.dispose();
            SvnLogPanel.currentPanel = undefined;
        }

        // 创建一个新面板
        const panel = vscode.window.createWebviewPanel(
            'svnLogView',
            `SVN日志: ${path.basename(targetPath)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media')
                ]
            }
        );

        SvnLogPanel.currentPanel = new SvnLogPanel(panel, extensionUri, targetPath, svnService);
    }

    /**
     * 加载SVN日志
     */
    private async _loadLogs(limit: number = 50) {
        try {
            this._log(`开始加载SVN日志，限制数量: ${limit}`);
            // 显示加载中状态
            this._panel.webview.postMessage({ command: 'setLoading', value: true });

            // 直接使用executeSvnCommand方法获取日志，确保使用--verbose参数
            const logCommand = `log "${this._targetPath}" -l ${limit} --verbose --xml`;
            this._log(`执行SVN日志命令: ${logCommand}`);
            const logXml = await this.svnService.executeSvnCommand(logCommand, path.dirname(this._targetPath), false);
            
            // 检查XML是否包含paths标签
            if (!logXml.includes('<paths>')) {
                this._log('警告: SVN日志XML中没有找到paths标签，可能需要检查SVN版本或命令参数');
                
                // 尝试使用不同的命令格式
                this._log('尝试使用不同的命令格式获取详细日志');
                const altCommand = `log -v "${this._targetPath}" -l ${limit} --xml`;
                this._log(`执行替代SVN命令: ${altCommand}`);
                const altLogXml = await this.svnService.executeSvnCommand(altCommand, path.dirname(this._targetPath), false);
                
                if (altLogXml.includes('<paths>')) {
                    this._log('成功获取包含路径信息的日志');
                    // 解析XML日志
                    this._logEntries = this._parseLogXml(altLogXml);
                } else {
                    this._log('仍然无法获取路径信息，可能是SVN版本不支持或其他问题');
                    // 解析原始XML日志
                    this._logEntries = this._parseLogXml(logXml);
                }
            } else {
                // 解析XML日志
                this._log('解析SVN日志XML');
                this._logEntries = this._parseLogXml(logXml);
            }
            
            this._log(`解析完成，获取到 ${this._logEntries.length} 条日志记录`);
            
            // 记录日志条目的路径信息
            this._logEntries.forEach((entry, index) => {
                this._log(`日志条目 #${index + 1}, 修订版本: ${entry.revision}, 路径数量: ${entry.paths?.length || 0}`);
                if (entry.paths && entry.paths.length > 0) {
                    entry.paths.slice(0, 3).forEach((path, pathIndex) => {
                        this._log(`  - 路径 #${pathIndex + 1}: 操作=${path.action}, 路径=${path.path}`);
                    });
                    if (entry.paths.length > 3) {
                        this._log(`  - ... 还有 ${entry.paths.length - 3} 个路径`);
                    }
                }
            });
            
            // 更新界面
            this._log('更新日志列表界面');
            this._updateLogList();
            
            // 更新目标路径名称
            const targetName = path.basename(this._targetPath);
            this._panel.webview.postMessage({
                command: 'updateTargetName',
                targetName: targetName
            });
            
            // 更新目标路径
            this._panel.webview.postMessage({
                command: 'updateTargetPath',
                targetPath: this._targetPath.replace(/\\/g, '\\\\')
            });
            
            // 更新isDirectory状态
            const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
            this._panel.webview.postMessage({
                command: 'updateIsDirectory',
                isDirectory: isDirectory
            });
            
            // 更新SVN相对路径
            this._panel.webview.postMessage({
                command: 'updateSvnRelativePath',
                targetSvnRelativePath: isDirectory ? this._targetSvnRelativePath : ''
            });
            
            // 隐藏加载状态
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        } catch (error: any) {
            this._log(`获取SVN日志失败: ${error.message}`);
            vscode.window.showErrorMessage(`获取SVN日志失败: ${error.message}`);
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    /**
     * 解析SVN日志XML
     */
    private _parseLogXml(logXml: string): SvnLogEntry[] {
        const entries: SvnLogEntry[] = [];
        
        try {
            this._log('开始解析SVN日志XML');
            
            // 记录原始XML内容的一部分用于调试
            const xmlPreview = logXml.substring(0, 500) + (logXml.length > 500 ? '...' : '');
            this._log(`XML预览: ${xmlPreview}`);
            
            // 使用正则表达式解析XML
            // 匹配日志条目
            const entryRegex = /<logentry\s+revision="([^"]+)">([\s\S]*?)<\/logentry>/g;
            let entryMatch;
            
            while ((entryMatch = entryRegex.exec(logXml)) !== null) {
                const revision = entryMatch[1];
                const entryContent = entryMatch[2];
                
                this._log(`解析修订版本 ${revision} 的日志条目`);
                
                // 解析作者
                const authorMatch = /<author>(.*?)<\/author>/s.exec(entryContent);
                const author = authorMatch ? authorMatch[1] : '未知';
                
                // 解析日期
                const dateMatch = /<date>(.*?)<\/date>/s.exec(entryContent);
                const dateStr = dateMatch ? dateMatch[1] : '';
                const date = dateStr ? this._formatDate(dateStr) : '未知';
                
                // 解析提交信息
                const msgMatch = /<msg>([\s\S]*?)<\/msg>/s.exec(entryContent);
                const message = msgMatch ? msgMatch[1].trim() : '';
                
                // 解析变更路径
                const paths: SvnLogPath[] = [];
                const pathsMatch = /<paths>([\s\S]*?)<\/paths>/s.exec(entryContent);
                
                if (pathsMatch) {
                    this._log(`找到路径信息: ${revision}`);
                    const pathContent = pathsMatch[1];
                    
                    // 打印路径内容用于调试
                    this._log(`路径内容: ${pathContent.substring(0, 200)}${pathContent.length > 200 ? '...' : ''}`);
                    
                    // 使用更灵活的正则表达式匹配路径
                    // 匹配任何包含action属性的path标签
                    const pathRegex = /<path[^>]*?action="([^"]+)"[^>]*>([\s\S]*?)<\/path>/g;
                    let pathMatch;
                    
                    while ((pathMatch = pathRegex.exec(pathContent)) !== null) {
                        const action = pathMatch[1];
                        const pathText = pathMatch[2].trim();
                        
                        this._log(`找到路径: 操作=${action}, 路径=${pathText}`);
                        
                        paths.push({
                            action: action,
                            path: pathText
                        });
                    }
                    
                    this._log(`解析到 ${paths.length} 个路径`);
                    
                    // 如果没有找到路径，尝试使用更简单的正则表达式
                    if (paths.length === 0) {
                        this._log('使用备用正则表达式解析路径');
                        
                        // 简单匹配任何path标签
                        const simplePath = /<path[^>]*>([\s\S]*?)<\/path>/g;
                        let simpleMatch;
                        
                        while ((simpleMatch = simplePath.exec(pathContent)) !== null) {
                            // 尝试从标签属性中提取action
                            const actionMatch = /action="([^"]+)"/.exec(simpleMatch[0]);
                            const action = actionMatch ? actionMatch[1] : 'M'; // 默认为修改
                            const pathText = simpleMatch[1].trim();
                            
                            this._log(`使用备用方法找到路径: 操作=${action}, 路径=${pathText}`);
                            
                            paths.push({
                                action: action,
                                path: pathText
                            });
                        }
                        
                        this._log(`使用备用方法解析到 ${paths.length} 个路径`);
                    }
                } else {
                    this._log(`未找到路径信息: ${revision}`);
                }
                
                entries.push({
                    revision,
                    author,
                    date,
                    message,
                    paths
                });
            }
            
            this._log(`XML解析完成，解析到 ${entries.length} 条日志记录`);
        } catch (error) {
            this._log(`解析SVN日志XML失败: ${error}`);
            console.error('解析SVN日志XML失败:', error);
        }
        
        return entries;
    }

    /**
     * 格式化SVN日期
     */
    private _formatDate(dateStr: string): string {
        try {
            const date = new Date(dateStr);
            return date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (error) {
            return dateStr;
        }
    }

    /**
     * 更新日志列表
     */
    private _updateLogList() {
        this._log('发送更新日志列表消息到Webview');
        
        // 检查目标路径是否是文件夹
        const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
        
        // 发送日志条目到Webview
        this._panel.webview.postMessage({
            command: 'updateLogList',
            logEntries: this._logEntries,
            selectedRevision: this._selectedRevision,
            targetSvnRelativePath: isDirectory ? this._targetSvnRelativePath : '',
            isDirectory: isDirectory
        });

        // 如果有日志条目，且没有选中的修订版本，自动选择第一个
        if (this._logEntries.length > 0 && !this._selectedRevision) {
            const firstRevision = this._logEntries[0].revision;
            this._log(`自动选择第一个日志条目，修订版本: ${firstRevision}`);
            this._showRevisionDetails(firstRevision);
        }
    }

    /**
     * 显示修订版本的详细信息
     */
    private async _showRevisionDetails(revision: string) {
        try {
            this._log(`显示修订版本详情: ${revision}`);
            this._selectedRevision = revision;
            
            // 直接通过SVN命令获取选中版本的详细修改记录
            this._log(`直接获取修订版本 ${revision} 的详细信息`);
            
            // 构建命令：获取指定版本的详细日志
            const logCommand = `log -r ${revision} --verbose --xml "${this._targetPath}"`;
            this._log(`执行SVN命令: ${logCommand}`);
            
            // 显示加载中状态
            this._panel.webview.postMessage({ command: 'setLoading', value: true });
            
            // 执行命令获取详细日志
            const logXml = await this.svnService.executeSvnCommand(
                logCommand,
                path.dirname(this._targetPath),
                false
            );
            
            // 检查XML是否包含paths标签
            if (!logXml.includes('<paths>')) {
                this._log(`警告: 修订版本 ${revision} 的日志XML中没有找到paths标签`);
                
                // 尝试使用不同的命令格式
                const altCommand = `log -r ${revision} -v --xml "${this._targetPath}"`;
                this._log(`尝试替代命令: ${altCommand}`);
                
                const altLogXml = await this.svnService.executeSvnCommand(
                    altCommand,
                    path.dirname(this._targetPath),
                    false
                );
                
                if (altLogXml.includes('<paths>')) {
                    this._log('成功获取包含路径信息的日志');
                    // 解析单个版本的XML日志
                    const detailEntries = this._parseLogXml(altLogXml);
                    if (detailEntries.length > 0) {
                        const detailEntry = detailEntries[0];
                        this._log(`解析到详细信息，路径数量: ${detailEntry.paths?.length || 0}`);
                        
                        // 发送详细信息到Webview
                        const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
                        this._panel.webview.postMessage({
                            command: 'showRevisionDetails',
                            revision: revision,
                            details: detailEntry,
                            targetSvnRelativePath: isDirectory ? this._targetSvnRelativePath : '',
                            isDirectory: isDirectory
                        });
                    } else {
                        this._log('解析详细日志失败，未找到日志条目');
                        this._fallbackToExistingEntry(revision);
                    }
                } else {
                    this._log('仍然无法获取路径信息，回退到现有日志条目');
                    this._fallbackToExistingEntry(revision);
                }
            } else {
                // 解析单个版本的XML日志
                const detailEntries = this._parseLogXml(logXml);
                if (detailEntries.length > 0) {
                    const detailEntry = detailEntries[0];
                    this._log(`解析到详细信息，路径数量: ${detailEntry.paths?.length || 0}`);
                    
                    // 发送详细信息到Webview
                    const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
                    this._panel.webview.postMessage({
                        command: 'showRevisionDetails',
                        revision: revision,
                        details: detailEntry,
                        targetSvnRelativePath: isDirectory ? this._targetSvnRelativePath : '',
                        isDirectory: isDirectory
                    });
                } else {
                    this._log('解析详细日志失败，未找到日志条目');
                    this._fallbackToExistingEntry(revision);
                }
            }
            
            // 隐藏加载状态
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        } catch (error: any) {
            this._log(`获取修订版本详情失败: ${error.message}`);
            vscode.window.showErrorMessage(`获取修订版本详情失败: ${error.message}`);
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
            this._fallbackToExistingEntry(revision);
        }
    }
    
    /**
     * 回退到现有的日志条目
     */
    private _fallbackToExistingEntry(revision: string) {
        this._log(`回退到现有日志条目: ${revision}`);
        // 查找选中的日志条目
        const logEntry = this._logEntries.find(entry => entry.revision === revision);
        
        if (logEntry) {
            this._log(`找到现有日志条目，路径数量: ${logEntry.paths?.length || 0}`);
            // 发送详细信息到Webview
            const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
            this._panel.webview.postMessage({
                command: 'showRevisionDetails',
                revision: revision,
                details: logEntry,
                targetSvnRelativePath: isDirectory ? this._targetSvnRelativePath : '',
                isDirectory: isDirectory
            });
        } else {
            this._log(`未找到修订版本 ${revision} 的现有日志条目`);
        }
    }

    /**
     * 设置消息处理器
     */
    private _setupMessageHandlers() {
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                this._log(`收到Webview消息: ${message.command}`);
                switch (message.command) {
                    case 'selectRevision':
                        this._log(`选择修订版本: ${message.revision}`);
                        await this._showRevisionDetails(message.revision);
                        break;
                    case 'loadMoreLogs':
                        this._log(`加载更多日志，限制: ${message.limit || 50}`);
                        await this._loadLogs(message.limit || 50);
                        break;
                    case 'refresh':
                        this._log('刷新日志');
                        // 重新获取SVN相对路径
                        await this._getSvnRelativePath();
                        // 加载日志
                        await this._loadLogs();
                        break;
                    case 'viewFileDiff':
                        this._log(`查看文件差异: 路径=${message.path}, 修订版本=${message.revision}`);
                        await this._viewFileDiff(message.path, message.revision);
                        break;
                    case 'debug':
                        this._log(`[Webview调试] ${message.message}`);
                        break;
                    case 'updateSvnRelativePath':
                        this._targetSvnRelativePath = message.targetSvnRelativePath;
                        this._log('更新SVN相对路径: ' + this._targetSvnRelativePath);
                        break;
                    case 'updateIsDirectory':
                        this._log('更新isDirectory: ' + message.isDirectory);
                        break;
                    case 'updateTargetName':
                        this._log('更新目标路径名称: ' + message.targetName);
                        const targetElement = document.querySelector('.toolbar span');
                        if (targetElement) {
                            targetElement.textContent = 'SVN日志: ' + message.targetName;
                        }
                        break;
                    case 'updateTargetPath':
                        this._log('更新目标路径: ' + message.targetPath);
                        this._targetPath = message.targetPath;
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * 查看文件差异
     */
    private async _viewFileDiff(filePath: string, revision: string) {
        try {
            // 获取前一个版本号
            const prevRevision = parseInt(revision) - 1;
            this._log(`查看文件差异: 路径=${filePath}, 版本=${prevRevision}:${revision}`);
            
            // 显示加载中状态
            this._panel.webview.postMessage({ command: 'setLoading', value: true });
            
            // 检查路径是否以/trunk/开头（SVN仓库路径）
            const isSvnRepoPath = filePath.startsWith('/trunk/') || filePath.startsWith('/branches/') || filePath.startsWith('/tags/');
            this._log(`路径类型: ${isSvnRepoPath ? 'SVN仓库路径' : '本地路径'}`);
            
            // 首先尝试获取SVN仓库URL
            let repoUrl = '';
            let workingDir = path.dirname(this._targetPath);
            
            try {
                // 获取SVN仓库URL
                const infoCommand = `info --xml "${this._targetPath}"`;
                this._log(`执行SVN命令获取仓库URL: ${infoCommand}`);
                
                const infoXml = await this.svnService.executeSvnCommand(infoCommand, workingDir, false);
                
                // 解析XML获取仓库URL
                const urlMatch = /<url>(.*?)<\/url>/s.exec(infoXml);
                if (urlMatch && urlMatch[1]) {
                    const fullUrl = urlMatch[1];
                    this._log(`找到SVN仓库URL: ${fullUrl}`);
                    
                    // 提取仓库根URL
                    if (fullUrl.includes('/trunk/')) {
                        repoUrl = fullUrl.substring(0, fullUrl.indexOf('/trunk/'));
                    } else if (fullUrl.includes('/branches/')) {
                        repoUrl = fullUrl.substring(0, fullUrl.indexOf('/branches/'));
                    } else if (fullUrl.includes('/tags/')) {
                        repoUrl = fullUrl.substring(0, fullUrl.indexOf('/tags/'));
                    } else {
                        repoUrl = fullUrl;
                    }
                    
                    this._log(`提取的仓库根URL: ${repoUrl}`);
                }
            } catch (error: any) {
                this._log(`获取仓库URL失败: ${error.message}`);
            }
            
            // 如果成功获取到仓库URL，使用URL方式访问
            if (repoUrl && isSvnRepoPath) {
                const fileUrl = `${repoUrl}${filePath}`;
                this._log(`构建文件完整URL: ${fileUrl}`);
                
                try {
                    // 创建临时文件来存储两个版本的内容
                    const tempDir = path.join(os.tmpdir(), 'vscode-svn-diff');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    
                    const fileName = path.basename(filePath);
                    const prevFilePath = path.join(tempDir, `${fileName}.r${prevRevision}`);
                    const currentFilePath = path.join(tempDir, `${fileName}.r${revision}`);
                    
                    this._log(`创建临时文件: ${prevFilePath} 和 ${currentFilePath}`);
                    
                    // 获取前一个版本的文件内容
                    const prevCommand = `cat "${fileUrl}@${prevRevision}"`;
                    this._log(`执行命令获取前一个版本内容: ${prevCommand}`);
                    const prevContent = await this.svnService.executeSvnCommand(prevCommand, workingDir, false);
                    
                    // 获取当前版本的文件内容
                    const currentCommand = `cat "${fileUrl}@${revision}"`;
                    this._log(`执行命令获取当前版本内容: ${currentCommand}`);
                    const currentContent = await this.svnService.executeSvnCommand(currentCommand, workingDir, false);
                    
                    // 写入临时文件
                    fs.writeFileSync(prevFilePath, prevContent);
                    fs.writeFileSync(currentFilePath, currentContent);
                    
                    // 使用VSCode原生的差异对比界面
                    const title = `${fileName} (r${prevRevision} vs r${revision})`;
                    this._log(`打开VSCode差异对比界面: ${title}`);
                    
                    // 打开差异对比界面
                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        vscode.Uri.file(prevFilePath),
                        vscode.Uri.file(currentFilePath),
                        title
                    );
                    
                    // 隐藏加载状态
                    this._panel.webview.postMessage({ command: 'setLoading', value: false });
                    return;
                } catch (error: any) {
                    this._log(`使用URL方式获取文件内容失败: ${error.message}`);
                }
            }
            
            // 如果URL方式失败或无法获取URL，尝试使用其他方法
            this._log('尝试使用其他方法获取差异');
            
            // 尝试使用SVN的diff命令获取差异，然后创建临时文件
            try {
                const tempDir = path.join(os.tmpdir(), 'vscode-svn-diff');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }
                
                const fileName = path.basename(filePath);
                const diffFilePath = path.join(tempDir, `${fileName}.diff`);
                
                // 尝试使用不同的命令格式
                const commands = [
                    repoUrl ? `diff -r ${prevRevision}:${revision} "${repoUrl}${filePath}"` : '',
                    `diff -r ${prevRevision}:${revision} "${filePath}"`,
                    `diff -r ${prevRevision}:${revision} "${path.basename(filePath)}"`,
                    `diff -r ${prevRevision} -r ${revision} "${filePath}"`
                ].filter(cmd => cmd); // 过滤掉空命令
                
                let diffContent = '';
                
                for (const cmd of commands) {
                    try {
                        this._log(`尝试命令: ${cmd}`);
                        const diff = await this.svnService.executeSvnCommand(cmd, workingDir, false);
                        
                        if (diff && diff.trim() !== '') {
                            this._log(`命令 "${cmd}" 成功获取差异信息`);
                            diffContent = diff;
                            break;
                        } else {
                            this._log(`命令 "${cmd}" 返回空结果`);
                        }
                    } catch (error: any) {
                        this._log(`命令 "${cmd}" 失败: ${error.message}`);
                    }
                }
                
                if (!diffContent && repoUrl && isSvnRepoPath) {
                    try {
                        const urlDiffCommand = `diff "${repoUrl}${filePath}@${prevRevision}" "${repoUrl}${filePath}@${revision}"`;
                        this._log(`尝试URL直接比较: ${urlDiffCommand}`);
                        
                        const urlDiff = await this.svnService.executeSvnCommand(urlDiffCommand, workingDir, false);
                        
                        if (urlDiff && urlDiff.trim() !== '') {
                            this._log('URL直接比较成功获取差异信息');
                            diffContent = urlDiff;
                        }
                    } catch (error: any) {
                        this._log(`URL直接比较失败: ${error.message}`);
                    }
                }
                
                if (diffContent) {
                    // 将差异内容写入临时文件
                    fs.writeFileSync(diffFilePath, diffContent);
                    
                    // 打开差异文件
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(diffFilePath));
                    await vscode.window.showTextDocument(document);
                    
                    // 隐藏加载状态
                    this._panel.webview.postMessage({ command: 'setLoading', value: false });
                    return;
                }
            } catch (error: any) {
                this._log(`创建差异文件失败: ${error.message}`);
            }
            
            this._log('所有命令都失败，无法获取差异信息');
            vscode.window.showInformationMessage(`无法获取文件差异信息: ${filePath}`);
            
            // 隐藏加载状态
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        } catch (error: any) {
            this._log(`获取文件差异失败: ${error.message}`);
            vscode.window.showErrorMessage(`获取文件差异失败: ${error.message}`);
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    /**
     * 获取Webview的HTML内容
     */
    private _getHtmlForWebview(): string {
        const targetName = path.basename(this._targetPath);
        const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
        
        return `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>SVN日志: ${targetName}</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                    padding: 0;
                    margin: 0;
                }
                .container {
                    display: flex;
                    height: calc(100vh - 40px); /* 减去工具栏高度 */
                    overflow: hidden;
                }
                .log-list {
                    width: 30%;
                    border-right: 1px solid var(--vscode-panel-border);
                    overflow-y: auto;
                    padding: 10px;
                }
                .log-details {
                    width: 70%;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                }
                .detail-header {
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                }
                .detail-title {
                    font-size: 1.2em;
                    font-weight: bold;
                    margin-bottom: 5px;
                }
                .detail-info {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 5px;
                    color: var(--vscode-descriptionForeground);
                }
                .detail-message {
                    white-space: pre-wrap;
                    word-break: break-word;
                    padding: 10px;
                    background-color: var(--vscode-textBlockQuote-background);
                    border-left: 5px solid var(--vscode-textBlockQuote-border);
                    margin: 10px;
                    max-height: 150px;
                    overflow-y: auto;
                }
                .detail-content-container {
                    display: flex;
                    flex-direction: column;
                    flex: 1;
                    overflow: hidden;
                }
                .file-list-container {
                    flex: 1;
                    overflow-y: auto;
                    border-top: 1px solid var(--vscode-panel-border);
                    padding: 0 10px;
                }
                .file-list-header {
                    position: sticky;
                    top: 0;
                    background-color: var(--vscode-editor-background);
                    padding: 10px 0;
                    font-weight: bold;
                    z-index: 1;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .file-list-title-container {
                    display: flex;
                    align-items: center;
                }
                .file-list-title {
                    font-weight: bold;
                    margin-right: 10px;
                }
                .file-count {
                    color: var(--vscode-descriptionForeground);
                    font-size: 0.9em;
                }
                .file-list-filter {
                    display: flex;
                    align-items: center;
                }
                .filter-label {
                    display: flex;
                    align-items: center;
                    cursor: pointer;
                    user-select: none;
                    font-size: 0.9em;
                    color: var(--vscode-foreground);
                }
                .filter-checkbox {
                    margin-right: 5px;
                    cursor: pointer;
                }
                .log-entry {
                    padding: 10px;
                    margin-bottom: 10px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    cursor: pointer;
                }
                .log-entry:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .log-entry.selected {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                }
                .log-header {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 5px;
                }
                .log-revision {
                    font-weight: bold;
                }
                .log-author {
                    font-style: italic;
                }
                .log-date {
                    color: var(--vscode-descriptionForeground);
                    font-size: 0.9em;
                }
                .log-message {
                    white-space: pre-wrap;
                    word-break: break-word;
                    margin-top: 5px;
                }
                .path-list-header {
                    display: flex;
                    font-weight: bold;
                    padding: 5px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    margin-bottom: 5px;
                    position: sticky;
                    top: 40px;
                    background-color: var(--vscode-editor-background);
                    z-index: 1;
                }
                .path-list-header .path-action {
                    width: 60px;
                }
                .path-list-header .path-filename {
                    width: 200px;
                }
                .path-list-header .path-filepath {
                    flex: 1;
                }
                .path-list-header .path-detail {
                    width: 80px;
                    text-align: center;
                }
                .path-item {
                    padding: 5px;
                    margin-bottom: 5px;
                    display: flex;
                    align-items: center;
                }
                .path-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .path-action {
                    width: 60px;
                    font-weight: bold;
                    text-align: center;
                }
                .path-action.A {
                    color: #4CAF50; /* 添加 - 绿色 */
                }
                .path-action.M {
                    color: #2196F3; /* 修改 - 蓝色 */
                }
                .path-action.D {
                    color: #F44336; /* 删除 - 红色 */
                }
                .path-action.R {
                    color: #FF9800; /* 替换 - 橙色 */
                }
                .path-filename {
                    width: 200px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .path-filepath {
                    flex: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    color: var(--vscode-descriptionForeground);
                }
                .path-detail {
                    width: 80px;
                    text-align: center;
                }
                .detail-button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 3px 8px;
                    cursor: pointer;
                    border-radius: 2px;
                    font-size: 0.9em;
                }
                .detail-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .loading {
                    display: none;
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: rgba(0, 0, 0, 0.5);
                    justify-content: center;
                    align-items: center;
                    z-index: 999;
                }
                .loading-text {
                    color: white;
                    font-size: 1.2em;
                }
                .toolbar {
                    padding: 10px;
                    display: flex;
                    justify-content: space-between;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    height: 20px;
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    cursor: pointer;
                    border-radius: 2px;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .empty-state {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100%;
                    color: var(--vscode-descriptionForeground);
                }
                .empty-icon {
                    font-size: 3em;
                    margin-bottom: 10px;
                }
                .load-more {
                    text-align: center;
                    padding: 10px;
                    margin-top: 10px;
                }
                .highlight {
                    background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
                    color: var(--vscode-editor-foreground);
                    font-weight: bold;
                    border-radius: 2px;
                    padding: 0 2px;
                }
            </style>
        </head>
        <body>
            <div class="toolbar">
                <div>
                    <button id="refreshButton">刷新</button>
                </div>
                <div>
                    <span>SVN日志: ${targetName}</span>
                </div>
            </div>
            <div class="container">
                <div class="log-list" id="logList">
                    <div class="empty-state">
                        <div class="empty-icon">📋</div>
                        <div>加载中，请稍候...</div>
                    </div>
                </div>
                <div class="log-details" id="logDetails">
                    <div class="empty-state">
                        <div class="empty-icon">📝</div>
                        <div>请选择一个日志条目查看详情</div>
                    </div>
                </div>
            </div>
            <div class="loading" id="loading">
                <div class="loading-text">加载中...</div>
            </div>
            
            <script>
                (function() {
                    const vscode = acquireVsCodeApi();
                    const logList = document.getElementById('logList');
                    const logDetails = document.getElementById('logDetails');
                    const loading = document.getElementById('loading');
                    const refreshButton = document.getElementById('refreshButton');
                    
                    // 存储目标路径信息
                    let targetPath = "${this._targetPath.replace(/\\/g, '\\\\')}";
                    let targetName = "${targetName}";
                    let isDirectory = ${isDirectory};
                    let targetSvnRelativePath = "${this._targetSvnRelativePath.replace(/\\/g, '\\\\')}";
                    
                    // 存储"只显示相关文件"选项的状态，默认为true（勾选）
                    let showRelatedFilesOnly = true;
                    
                    let selectedRevision = null;
                    let logEntries = [];
                    
                    // 辅助函数：获取路径的最后一部分（文件名或目录名）
                    function basename(path) {
                        // 处理路径分隔符
                        path = path.replace(/\\\\/g, '/');
                        // 移除末尾的斜杠
                        if (path.endsWith('/')) {
                            path = path.slice(0, -1);
                        }
                        // 获取最后一部分
                        const parts = path.split('/');
                        return parts[parts.length - 1] || '';
                    }
                    
                    // 调试日志函数
                    function debugLog(message) {
                        console.log('[SVN日志面板] ' + message);
                        vscode.postMessage({
                            command: 'debug',
                            message: message
                        });
                    }
                    
                    debugLog('Webview脚本已初始化');
                    debugLog('目标路径: ' + targetPath + ', 是否为目录: ' + isDirectory);
                    
                    // 初始化
                    window.addEventListener('message', event => {
                        const message = event.data;
                        debugLog('收到消息: ' + message.command);
                        
                        switch (message.command) {
                            case 'setLoading':
                                loading.style.display = message.value ? 'flex' : 'none';
                                break;
                            case 'updateLogList':
                                logEntries = message.logEntries;
                                debugLog('收到日志条目: ' + logEntries.length + '条');
                                
                                // 更新isDirectory状态
                                if (message.hasOwnProperty('isDirectory')) {
                                    isDirectory = message.isDirectory;
                                    debugLog('更新isDirectory: ' + isDirectory);
                                }
                                
                                // 更新SVN相对路径
                                if (message.targetSvnRelativePath) {
                                    targetSvnRelativePath = message.targetSvnRelativePath;
                                    debugLog('更新SVN相对路径: ' + targetSvnRelativePath);
                                }
                                
                                // 如果有选中的修订版本，使用它
                                if (message.selectedRevision) {
                                    selectedRevision = message.selectedRevision;
                                    debugLog('使用服务器提供的选中修订版本: ' + selectedRevision);
                                } else if (logEntries.length > 0) {
                                    // 否则，如果有日志条目，默认选择第一个
                                    selectedRevision = logEntries[0].revision;
                                    debugLog('默认选择第一个修订版本: ' + selectedRevision);
                                    
                                    // 自动触发选择第一个日志条目
                                    vscode.postMessage({
                                        command: 'selectRevision',
                                        revision: selectedRevision
                                    });
                                }
                                
                                renderLogList(logEntries);
                                break;
                            case 'updateSvnRelativePath':
                                targetSvnRelativePath = message.targetSvnRelativePath;
                                debugLog('更新SVN相对路径: ' + targetSvnRelativePath);
                                break;
                            case 'updateIsDirectory':
                                isDirectory = message.isDirectory;
                                debugLog('更新isDirectory: ' + isDirectory);
                                break;
                            case 'updateTargetName':
                                debugLog('更新目标路径名称: ' + message.targetName);
                                targetName = message.targetName;
                                const targetElement = document.querySelector('.toolbar span');
                                if (targetElement) {
                                    targetElement.textContent = 'SVN日志: ' + message.targetName;
                                }
                                break;
                            case 'updateTargetPath':
                                debugLog('更新目标路径: ' + message.targetPath);
                                targetPath = message.targetPath;
                                break;
                            case 'showRevisionDetails':
                                debugLog('显示修订版本详情: ' + message.revision);
                                if (message.details && message.details.paths) {
                                    debugLog('路径数量: ' + message.details.paths.length);
                                } else {
                                    debugLog('没有路径信息');
                                }
                                
                                // 更新isDirectory状态
                                if (message.hasOwnProperty('isDirectory')) {
                                    isDirectory = message.isDirectory;
                                    debugLog('更新isDirectory: ' + isDirectory);
                                }
                                
                                // 更新SVN相对路径
                                if (message.targetSvnRelativePath) {
                                    targetSvnRelativePath = message.targetSvnRelativePath;
                                    debugLog('更新SVN相对路径: ' + targetSvnRelativePath);
                                }
                                
                                renderRevisionDetails(message.details);
                                break;
                        }
                    });
                    
                    // 渲染日志列表
                    function renderLogList(entries) {
                        debugLog('渲染日志列表');
                        if (!entries || entries.length === 0) {
                            logList.innerHTML = \`
                                <div class="empty-state">
                                    <div class="empty-icon">📋</div>
                                    <div>没有找到日志记录</div>
                                </div>
                            \`;
                            return;
                        }
                        
                        let html = '';
                        
                        entries.forEach(entry => {
                            const isSelected = entry.revision === selectedRevision;
                            const messagePreview = entry.message.length > 100 
                                ? entry.message.substring(0, 100) + '...' 
                                : entry.message;
                            
                            html += \`
                                <div class="log-entry \${isSelected ? 'selected' : ''}" data-revision="\${entry.revision}">
                                    <div class="log-header">
                                        <span class="log-revision">修订版本 \${entry.revision}</span>
                                        <span class="log-author">\${entry.author}</span>
                                    </div>
                                    <div class="log-date">\${entry.date}</div>
                                    <div class="log-message">\${messagePreview}</div>
                                </div>
                            \`;
                        });
                        
                        html += \`
                            <div class="load-more">
                                <button id="loadMoreButton">加载更多</button>
                            </div>
                        \`;
                        
                        logList.innerHTML = html;
                        debugLog('日志列表渲染完成');
                        
                        // 添加点击事件
                        document.querySelectorAll('.log-entry').forEach(entry => {
                            entry.addEventListener('click', () => {
                                const revision = entry.getAttribute('data-revision');
                                selectedRevision = revision;
                                debugLog('选择修订版本: ' + revision);
                                
                                // 更新选中状态
                                document.querySelectorAll('.log-entry').forEach(e => {
                                    e.classList.remove('selected');
                                });
                                entry.classList.add('selected');
                                
                                // 发送消息到扩展
                                vscode.postMessage({
                                    command: 'selectRevision',
                                    revision: revision
                                });
                            });
                        });
                        
                        // 如果有选中的修订版本，滚动到选中的条目
                        if (selectedRevision) {
                            const selectedEntry = document.querySelector('.log-entry[data-revision="' + selectedRevision + '"]');
                            if (selectedEntry) {
                                debugLog('滚动到选中的日志条目');
                                selectedEntry.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                            }
                        }
                        
                        // 加载更多按钮
                        const loadMoreButton = document.getElementById('loadMoreButton');
                        if (loadMoreButton) {
                            loadMoreButton.addEventListener('click', () => {
                                debugLog('点击加载更多按钮');
                                vscode.postMessage({
                                    command: 'loadMoreLogs',
                                    limit: 50
                                });
                            });
                        }
                    }
                    
                    // 渲染修订版本详情
                    function renderRevisionDetails(details) {
                        debugLog('开始渲染修订版本详情');
                        if (!details) {
                            debugLog('没有详情数据');
                            logDetails.innerHTML = \`
                                <div class="empty-state">
                                    <div class="empty-icon">📝</div>
                                    <div>请选择一个日志条目查看详情</div>
                                </div>
                            \`;
                            return;
                        }
                        
                        // 创建详情内容容器
                        let html = \`<div class="detail-content-container">\`;
                        
                        // 添加详情头部
                        html += \`
                            <div class="detail-header">
                                <div class="detail-title">修订版本 \${details.revision}</div>
                                <div class="detail-info">
                                    <span>作者: \${details.author}</span>
                                    <span>日期: \${details.date}</span>
                                </div>
                            </div>
                            <div class="detail-message">\${details.message}</div>
                        \`;
                        
                        // 添加文件列表
                        if (details.paths && details.paths.length > 0) {
                            debugLog('开始渲染文件列表，文件数量: ' + details.paths.length);
                            
                            html += \`
                                <div class="file-list-container">
                                    <div class="file-list-header">
                                        <div class="file-list-title-container">
                                            <span class="file-list-title">变更文件列表</span>
                                            <span class="file-count">共 \${details.paths.length} 个文件</span>
                                        </div>
                                        <div class="file-list-filter">
                                            <label class="filter-label">
                                                <input type="checkbox" id="showRelatedFilesOnly" class="filter-checkbox" checked="\${showRelatedFilesOnly}" />
                                                <span>只显示相关文件</span>
                                            </label>
                                        </div>
                                    </div>
                                    <div class="path-list-header">
                                        <div class="path-action">操作</div>
                                        <div class="path-filename">文件名</div>
                                        <div class="path-filepath">相对路径</div>
                                        <div class="path-detail">操作</div>
                                    </div>
                            \`;
                            
                            details.paths.forEach((path, index) => {
                                let actionLabel = '';
                                switch (path.action) {
                                    case 'A': actionLabel = '添加'; break;
                                    case 'M': actionLabel = '修改'; break;
                                    case 'D': actionLabel = '删除'; break;
                                    case 'R': actionLabel = '替换'; break;
                                    default: actionLabel = path.action;
                                }
                                
                                // 获取文件名和相对路径
                                const filePath = path.path;
                                const fileName = filePath.split('/').pop();
                                const relativePath = filePath;
                                
                                debugLog(\`文件 #\${index + 1}: \${fileName}, 操作: \${path.action}\`);
                                
                                // 根据调用方式（文件夹或文件）对路径或文件名进行高亮
                                let fileNameHtml = fileName;
                                let relativePathHtml = relativePath;
                                
                                // 如果是通过文件夹方式呼出的，高亮路径
                                if (isDirectory) {
                                    // 获取目标文件夹的完整路径和相对路径
                                    const targetDirPath = targetPath;
                                    
                                    // 检查文件路径是否与文件夹的SVN相对路径一致
                                    if (targetSvnRelativePath && relativePath === targetSvnRelativePath) {
                                        // 如果完全一致，整个路径高亮
                                        relativePathHtml = '<span class="highlight">' + relativePath + '</span>';
                                        debugLog('完全匹配，高亮整个路径: ' + relativePath);
                                        path.isRelated = true;
                                    } 
                                    // 检查文件路径是否包含文件夹的SVN相对路径
                                    else if (targetSvnRelativePath && relativePath.includes(targetSvnRelativePath)) {
                                        // 高亮匹配的部分
                                        relativePathHtml = relativePath.replace(
                                            targetSvnRelativePath,
                                            '<span class="highlight">' + targetSvnRelativePath + '</span>'
                                        );
                                        debugLog('部分匹配，高亮SVN相对路径: ' + targetSvnRelativePath + ' 在路径: ' + relativePath);
                                        path.isRelated = true;
                                    }
                                    // 如果没有匹配到SVN相对路径，使用原来的高亮逻辑
                                    else {
                                        // 检查SVN路径是否包含目标文件夹路径的一部分
                                        // 首先尝试从完整路径中提取相对路径部分
                                        let relativeDirPath = '';
                                        
                                        // 如果是以/trunk/开头的SVN路径
                                        if (relativePath.startsWith('/trunk/')) {
                                            // 提取/trunk/之后的部分
                                            const trunkPath = relativePath.substring('/trunk/'.length);
                                            
                                            // 检查目标路径中是否包含这部分
                                            const targetDirName = basename(targetDirPath);
                                            
                                            // 尝试在路径中查找目标目录名
                                            if (trunkPath.includes(targetDirName)) {
                                                // 构建正则表达式，匹配目录名及其前后的路径分隔符
                                                const dirRegex = new RegExp('(^|/)' + targetDirName + '(/|$)', 'g');
                                                
                                                // 替换匹配的部分，添加高亮
                                                relativePathHtml = relativePath.replace(
                                                    dirRegex,
                                                    function(match, p1, p2) { 
                                                        return p1 + '<span class="highlight">' + targetDirName + '</span>' + p2; 
                                                    }
                                                );
                                                
                                                debugLog('高亮目录: ' + targetDirName + ' 在路径: ' + relativePath);
                                                path.isRelated = true;
                                            } else {
                                                // 如果找不到精确匹配，尝试高亮包含目标目录名的部分路径
                                                const pathParts = trunkPath.split('/');
                                                for (let i = 0; i < pathParts.length; i++) {
                                                    if (pathParts[i] === targetDirName) {
                                                        // 构建要高亮的路径部分
                                                        const highlightPath = pathParts.slice(0, i + 1).join('/');
                                                        
                                                        // 在相对路径中高亮这部分
                                                        relativePathHtml = relativePath.replace(
                                                            highlightPath,
                                                            '<span class="highlight">' + highlightPath + '</span>'
                                                        );
                                                        
                                                        debugLog('高亮路径部分: ' + highlightPath + ' 在路径: ' + relativePath);
                                                        path.isRelated = true;
                                                        break;
                                                    }
                                                }
                                            }
                                        } else {
                                            // 对于其他格式的路径，尝试简单匹配目标目录名
                                            const targetDirName = basename(targetDirPath);
                                            
                                            if (relativePath.includes(targetDirName)) {
                                                relativePathHtml = relativePath.replace(
                                                    new RegExp('(^|/)' + targetDirName + '(/|$)', 'g'),
                                                    function(match, p1, p2) { 
                                                        return p1 + '<span class="highlight">' + targetDirName + '</span>' + p2; 
                                                    }
                                                );
                                                
                                                debugLog('高亮目录名: ' + targetDirName + ' 在路径: ' + relativePath);
                                                path.isRelated = true;
                                            }
                                        }
                                    }
                                } 
                                // 如果是通过文件方式呼出的，高亮文件名
                                else {
                                    // 检查文件名是否与目标文件名匹配
                                    if (fileName === targetName) {
                                        fileNameHtml = '<span class="highlight">' + fileName + '</span>';
                                        debugLog('高亮文件名: ' + fileName);
                                        path.isRelated = true;
                                    }
                                    
                                    // 在文件模式下，不使用相对路径匹配逻辑，保持相对路径原样
                                    debugLog('文件模式，不高亮相对路径');
                                }
                                
                                // 只有修改和添加的文件才能查看差异
                                const canViewDiff = path.action === 'M' || path.action === 'A';
                                
                                html += \`
                                    <div class="path-item" data-related="\${path.isRelated ? 'true' : 'false'}">
                                        <div class="path-action \${path.action}" title="\${actionLabel}">\${path.action}</div>
                                        <div class="path-filename" title="\${fileName}">\${fileNameHtml}</div>
                                        <div class="path-filepath" title="\${relativePath}">\${relativePathHtml}</div>
                                        <div class="path-detail">
                                            \${canViewDiff ? 
                                                \`<button class="detail-button" data-path="\${path.path}" data-revision="\${details.revision}">显示差异</button>\` : 
                                                \`<button class="detail-button" disabled>显示差异</button>\`
                                            }
                                        </div>
                                    </div>
                                \`;
                            });
                            
                            html += \`</div>\`; // 关闭file-list-container
                        } else {
                            debugLog('没有文件列表数据');
                            html += \`
                                <div class="file-list-container">
                                    <div class="empty-state">
                                        <div class="empty-icon">📂</div>
                                        <div>没有找到变更文件</div>
                                    </div>
                                </div>
                            \`;
                        }
                        
                        html += \`</div>\`; // 关闭detail-content-container
                        
                        logDetails.innerHTML = html;
                        debugLog('详情内容渲染完成');
                        
                        // 添加详细按钮点击事件
                        document.querySelectorAll('.detail-button:not([disabled])').forEach(button => {
                            button.addEventListener('click', (e) => {
                                e.stopPropagation();
                                const path = button.getAttribute('data-path');
                                const revision = button.getAttribute('data-revision');
                                debugLog('点击显示差异按钮: 路径=' + path + ', 修订版本=' + revision);
                                
                                vscode.postMessage({
                                    command: 'viewFileDiff',
                                    path: path,
                                    revision: revision
                                });
                            });
                        });
                        
                        // 添加"只显示相关文件"复选框的点击事件
                        const showRelatedFilesOnlyCheckbox = document.getElementById('showRelatedFilesOnly');
                        if (showRelatedFilesOnlyCheckbox) {
                            // 设置复选框的初始状态
                            showRelatedFilesOnlyCheckbox.checked = showRelatedFilesOnly;
                            
                            showRelatedFilesOnlyCheckbox.addEventListener('change', () => {
                                const isChecked = showRelatedFilesOnlyCheckbox.checked;
                                debugLog('只显示相关文件复选框状态: ' + isChecked);
                                
                                // 更新全局变量，保持状态
                                showRelatedFilesOnly = isChecked;
                                
                                // 获取所有文件项
                                const pathItems = document.querySelectorAll('.path-item');
                                
                                // 根据复选框状态显示或隐藏文件项
                                pathItems.forEach(item => {
                                    const isRelated = item.getAttribute('data-related') === 'true';
                                    
                                    if (isChecked) {
                                        // 如果勾选了复选框，只显示相关文件
                                        item.style.display = isRelated ? '' : 'none';
                                    } else {
                                        // 如果取消勾选，显示所有文件
                                        item.style.display = '';
                                    }
                                });
                                
                                // 更新文件计数
                                const fileCount = document.querySelector('.file-count');
                                if (fileCount) {
                                    const totalFiles = details.paths.length;
                                    const visibleFiles = isChecked 
                                        ? Array.from(pathItems).filter(item => item.getAttribute('data-related') === 'true').length 
                                        : totalFiles;
                                    
                                    fileCount.textContent = '共 ' + totalFiles + ' 个文件' + (isChecked ? '，显示 ' + visibleFiles + ' 个相关文件' : '');
                                }
                            });
                            
                            // 自动触发一次过滤，应用当前的过滤状态
                            if (showRelatedFilesOnly) {
                                // 获取所有文件项
                                const pathItems = document.querySelectorAll('.path-item');
                                
                                // 根据复选框状态显示或隐藏文件项
                                pathItems.forEach(item => {
                                    const isRelated = item.getAttribute('data-related') === 'true';
                                    item.style.display = isRelated ? '' : 'none';
                                });
                                
                                // 更新文件计数
                                const fileCount = document.querySelector('.file-count');
                                if (fileCount) {
                                    const totalFiles = details.paths.length;
                                    const visibleFiles = Array.from(pathItems).filter(item => item.getAttribute('data-related') === 'true').length;
                                    
                                    fileCount.textContent = '共 ' + totalFiles + ' 个文件，显示 ' + visibleFiles + ' 个相关文件';
                                }
                            }
                        }
                    }
                    
                    // 刷新按钮事件
                    refreshButton.addEventListener('click', () => {
                        debugLog('点击刷新按钮');
                        vscode.postMessage({
                            command: 'refresh'
                        });
                    });
                })();
            </script>
        </body>
        </html>`;
    }

    /**
     * 获取文件夹的SVN相对路径
     */
    private async _getSvnRelativePath() {
        try {
            this._log('获取文件夹的SVN相对路径: ' + this._targetPath);
            
            // 检查目标路径是否是文件夹
            const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
            if (!isDirectory) {
                this._log('目标路径是文件，不获取SVN相对路径');
                this._targetSvnRelativePath = ''; // 清空相对路径
                return;
            }
            
            // 获取SVN仓库URL
            const infoCommand = `info --xml "${this._targetPath}"`;
            this._log(`执行SVN命令获取仓库信息: ${infoCommand}`);
            
            const infoXml = await this.svnService.executeSvnCommand(infoCommand, path.dirname(this._targetPath), false);
            
            // 解析XML获取仓库URL和相对路径
            const urlMatch = /<url>(.*?)<\/url>/s.exec(infoXml);
            const relativeUrlMatch = /<relative-url>(.*?)<\/relative-url>/s.exec(infoXml);
            
            if (relativeUrlMatch && relativeUrlMatch[1]) {
                // 如果有relative-url标签，直接使用
                this._targetSvnRelativePath = relativeUrlMatch[1];
                this._log(`找到SVN相对路径(relative-url): ${this._targetSvnRelativePath}`);
            } else if (urlMatch && urlMatch[1]) {
                // 如果没有relative-url标签，从url中提取
                const fullUrl = urlMatch[1];
                this._log(`找到SVN仓库URL: ${fullUrl}`);
                
                // 提取相对路径
                if (fullUrl.includes('/trunk/')) {
                    this._targetSvnRelativePath = fullUrl.substring(fullUrl.indexOf('/trunk/'));
                } else if (fullUrl.includes('/branches/')) {
                    this._targetSvnRelativePath = fullUrl.substring(fullUrl.indexOf('/branches/'));
                } else if (fullUrl.includes('/tags/')) {
                    this._targetSvnRelativePath = fullUrl.substring(fullUrl.indexOf('/tags/'));
                }
                
                this._log(`提取的SVN相对路径: ${this._targetSvnRelativePath}`);
            }
            
            // 如果面板已经初始化，更新Webview中的SVN相对路径
            if (this._panel) {
                this._panel.webview.postMessage({
                    command: 'updateSvnRelativePath',
                    targetSvnRelativePath: this._targetSvnRelativePath
                });
            }
        } catch (error: any) {
            this._log(`获取SVN相对路径失败: ${error.message}`);
        }
    }

    /**
     * 释放资源
     */
    public dispose() {
        this._log('释放SVN日志面板资源');
        SvnLogPanel.currentPanel = undefined;
        this._panel.dispose();
        
        // 释放所有可释放资源
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
        
        // 释放输出通道
        this._outputChannel.dispose();
    }
}