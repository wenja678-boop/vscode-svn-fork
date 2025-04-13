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
    isNewerThanLocal?: boolean; // 添加标记，表示此版本是否比本地版本更新
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
    private _minLoadedRevision: string | null = null; // 记录已加载的最小版本号
    private _isInitialLoad: boolean = true; // 标记是否为初始加载
    private _localRevision: string | null = null; // 存储本地修订版本号

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
        this._minLoadedRevision = null; // 确保初始化为null
        this._isInitialLoad = true; // 初始加载标记

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
    private async _loadLogs(limit: number = 50, isLoadingMore: boolean = false) {
        try {
            // 确定版本范围
            let revisionRange = "HEAD:1";
            
            if (isLoadingMore && this._minLoadedRevision) {
                // 如果是加载更多且已有最小版本号，从最小版本号的前一个版本开始获取
                const minRevision = parseInt(this._minLoadedRevision);
                revisionRange = `${minRevision - 1}:1`;
                this._log(`加载更多日志，从版本 ${minRevision - 1} 开始，限制数量: ${limit}`);
            } else {
                // 首次加载或刷新操作，从HEAD开始
                this._log(`初始加载日志，从HEAD开始，限制数量: ${limit}`);
                // 清空已有日志和最小版本号
                if (!isLoadingMore) {
                    this._logEntries = [];
                    this._minLoadedRevision = null;
                    this._isInitialLoad = true;
                }
            }
            
            // 显示加载中状态
            this._panel.webview.postMessage({ command: 'setLoading', value: true });

            // 获取本地修订版本号
            if (!isLoadingMore || this._localRevision === null) {
                await this._getLocalRevision();
            }
            
            // 构建SVN命令，使用确定的版本范围
            const logCommand = `log "${this._targetPath}" -r ${revisionRange} -l ${limit} --verbose --xml`;
            this._log(`执行SVN日志命令: ${logCommand}`);
            
            const logXml = await this.svnService.executeSvnCommand(logCommand, path.dirname(this._targetPath), false);
            
            // 检查XML是否包含paths标签
            if (!logXml.includes('<paths>')) {
                this._log('警告: SVN日志XML中没有找到paths标签，可能需要检查SVN版本或命令参数');
                
                // 尝试使用不同的命令格式
                this._log('尝试使用不同的命令格式获取详细日志');
                const altCommand = `log -v -r ${revisionRange} "${this._targetPath}" -l ${limit} --xml`;
                this._log(`执行替代SVN命令: ${altCommand}`);
                const altLogXml = await this.svnService.executeSvnCommand(altCommand, path.dirname(this._targetPath), false);
                
                if (altLogXml.includes('<paths>')) {
                    this._log('成功获取包含路径信息的日志');
                    // 解析XML日志
                    const newEntries = this._parseLogXml(altLogXml);
                    this._updateLogEntries(newEntries, isLoadingMore);
                } else {
                    this._log('仍然无法获取路径信息，可能是SVN版本不支持或其他问题');
                    // 解析原始XML日志
                    const newEntries = this._parseLogXml(logXml);
                    this._updateLogEntries(newEntries, isLoadingMore);
                }
            } else {
                // 解析XML日志
                this._log('解析SVN日志XML');
                const newEntries = this._parseLogXml(logXml);
                this._updateLogEntries(newEntries, isLoadingMore);
            }
            
            this._log(`解析完成，获取到 ${this._logEntries.length} 条日志记录`);
            
            // 标记哪些版本比本地版本更新
            this._markNewerRevisions();
            
            // 更新界面
            this._log('更新日志列表界面');
            this._updateLogList(isLoadingMore);
            
            // 只有在初始加载时才更新界面其他部分
            if (this._isInitialLoad) {
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
                
                this._isInitialLoad = false;
            }
            
            // 隐藏加载状态
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        } catch (error: any) {
            this._log(`获取SVN日志失败: ${error.message}`);
            vscode.window.showErrorMessage(`获取SVN日志失败: ${error.message}`);
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
        }
    }

    /**
     * 获取当前文件或目录的本地修订版本号
     */
    private async _getLocalRevision() {
        try {
            this._log('获取本地修订版本号');
            
            // 使用SVN info命令获取当前文件/目录的版本信息
            const infoCommand = `info --xml "${this._targetPath}"`;
            this._log(`执行SVN命令: ${infoCommand}`);
            
            const infoXml = await this.svnService.executeSvnCommand(infoCommand, path.dirname(this._targetPath), false);
            
            // 从XML中提取版本号
            const revisionMatch = /<commit\s+revision="([^"]+)">/.exec(infoXml) || 
                                  /<entry\s+[^>]*?revision="([^"]+)"/.exec(infoXml);
            
            if (revisionMatch && revisionMatch[1]) {
                this._localRevision = revisionMatch[1];
                this._log(`获取到本地修订版本号: ${this._localRevision}`);
                
                // 通知前端更新本地版本号显示
                this._panel.webview.postMessage({
                    command: 'updateLocalRevision',
                    localRevision: this._localRevision
                });
            } else {
                this._log('未能从XML中提取版本号');
                this._localRevision = null;
            }
        } catch (error: any) {
            this._log(`获取本地修订版本号失败: ${error.message}`);
            this._localRevision = null;
        }
    }

    /**
     * 标记哪些版本比本地版本更新
     */
    private _markNewerRevisions() {
        if (!this._localRevision) {
            this._log('没有本地版本号信息，无法标记更新版本');
            return;
        }
        
        const localRevisionNum = parseInt(this._localRevision);
        this._log(`标记比本地版本(${localRevisionNum})更新的版本`);
        
        for (const entry of this._logEntries) {
            const revisionNum = parseInt(entry.revision);
            // 在SVN中，版本号更大表示更新的版本
            // 如果日志条目的版本号大于本地版本号，表示本地尚未更新到此版本
            entry.isNewerThanLocal = revisionNum > localRevisionNum;
            
            if (entry.isNewerThanLocal) {
                this._log(`标记版本 ${entry.revision} 为本地尚未更新的版本`);
            }
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
    private _updateLogList(isLoadingMore: boolean = false) {
        this._log('发送更新日志列表消息到Webview');
        
        // 检查目标路径是否是文件夹
        const isDirectory = fs.lstatSync(this._targetPath).isDirectory();
        
        // 发送日志条目到Webview，包含isLoadingMore标记
        this._panel.webview.postMessage({
            command: 'updateLogList',
            logEntries: this._logEntries,
            selectedRevision: this._selectedRevision,
            targetSvnRelativePath: isDirectory ? this._targetSvnRelativePath : '',
            isDirectory: isDirectory,
            isLoadingMore: isLoadingMore, // 标记是否为加载更多操作
            hasMoreLogs: this._minLoadedRevision !== '1' // 如果最小版本号不是1，说明还有更多日志可加载
        });

        // 如果有日志条目，且没有选中的修订版本，自动选择第一个
        // 注意：只在非"加载更多"模式下执行此操作
        if (this._logEntries.length > 0 && !this._selectedRevision && !isLoadingMore) {
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
                        this._log(`加载更多日志，限制: ${message.limit || 50}，最小已加载版本: ${this._minLoadedRevision || '无'}`);
                        await this._loadLogs(message.limit || 50, true); // 传入true表示加载更多模式
                        break;
                    case 'refresh':
                        this._log('刷新日志');
                        // 重置最小版本号和初始加载标记
                        this._minLoadedRevision = null;
                        this._isInitialLoad = true;
                        // 重置本地版本号，确保刷新时获取最新版本
                        this._localRevision = null;
                        // 重新获取SVN相对路径
                        await this._getSvnRelativePath();
                        // 加载日志（非加载更多模式）
                        await this._loadLogs();
                        break;
                    case 'viewFileDiff':
                        this._log(`查看文件差异: 路径=${message.path}, 修订版本=${message.revision}`);
                        await this._viewFileDiff(message.path, message.revision);
                        break;
                    case 'filterLogs':
                        this._log(`筛选日志: 修订版本=${message.revision || '无'}, 作者=${message.author || '无'}, 内容=${message.content || '无'}, 起始日期=${message.startDate || '无'}, 结束日期=${message.endDate || '无'}, 使用日期=${message.useDate || false}`);
                        await this._filterLogs(message.revision, message.author, message.content, message.startDate, message.endDate, message.useDate || false);
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
                    case 'updateLocalRevision':
                        this._localRevision = message.localRevision;
                        this._log('更新本地修订版本号: ' + this._localRevision);
                        
                        // 更新界面显示
                        if (this._localRevision) {
                            const localRevisionNumber = document.getElementById('localRevisionNumber');
                            if (localRevisionNumber) {
                                localRevisionNumber.textContent = this._localRevision;
                            }
                        }
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
                    padding-left: 15px; /* 增加左侧padding */
                    margin-bottom: 10px;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                    cursor: pointer;
                    position: relative; /* 添加相对定位，用于放置新标记 */
                }
                .log-entry:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .log-entry.selected {
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                }
                .log-entry.newer-than-local {
                    border-left: 4px solid #ff9800; /* 保留左侧橙色边框标记 */
                }
                .local-revision-info {
                    margin: 10px;
                    padding: 5px 10px;
                    background-color: var(--vscode-editor-infoForeground, rgba(100, 200, 255, 0.1));
                    border-left: 4px solid var(--vscode-notificationsInfoIcon-foreground, #75beff);
                    border-radius: 3px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .local-revision-label {
                    font-weight: bold;
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
                /* 筛选表单样式 */
                .filter-form {
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    align-items: center;
                }
                
                .filter-mode-toggle {
                    display: flex;
                    align-items: center;
                    margin-right: 15px;
                    padding: 5px;
                    background-color: var(--vscode-button-secondaryBackground);
                    border-radius: 4px;
                }
                
                #revisionFilterSection, #dateFilterSection {
                    display: flex;
                    gap: 10px;
                }
                
                input[type="date"].filter-input {
                    width: 140px;
                    padding: 4px 8px;
                }
                
                .filter-group {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                }
                
                .filter-label {
                    white-space: nowrap;
                }
                
                .filter-input {
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    padding: 4px 8px;
                    border-radius: 2px;
                    width: 120px;
                }
                
                .filter-input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    border-color: var(--vscode-focusBorder);
                }
                
                .filter-button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    cursor: pointer;
                    border-radius: 2px;
                    white-space: nowrap;
                }
                
                .filter-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                
                .filter-clear {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                
                .filter-clear:hover {
                    background-color: var(--vscode-button-secondaryHoverBackground);
                }
                
                .filter-result {
                    margin-left: auto;
                    color: var(--vscode-descriptionForeground);
                    font-size: 0.9em;
                }
                
                /* 响应式设计 */
                @media (max-width: 800px) {
                    .filter-form {
                        flex-direction: column;
                        align-items: flex-start;
                    }
                    
                    .filter-group {
                        width: 100%;
                    }
                    
                    .filter-input {
                        flex: 1;
                        width: auto;
                    }
                    
                    .filter-result {
                        margin-left: 0;
                        margin-top: 5px;
                    }
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
            
            <!-- 本地版本信息 -->
            <div class="local-revision-info" id="localRevisionInfo" style="display: none;">
                <div>
                    <span class="local-revision-label">本地修订版本:</span>
                    <span id="localRevisionNumber">--</span>
                </div>
                <div>
                    <span>橙色边框表示该版本尚未更新到本地</span>
                </div>
            </div>
            
            <!-- 日志筛选表单 -->
            <div class="filter-form">
                <div class="filter-mode-toggle">
                    <label class="filter-label">
                        <input type="checkbox" id="dateFilterToggle" class="filter-checkbox">
                        <span>使用日期筛选</span>
                    </label>
                </div>
                
                <!-- 修订版本筛选区域 -->
                <div id="revisionFilterSection">
                    <div class="filter-group">
                        <span class="filter-label">修订版本:</span>
                        <input type="text" id="revisionFilter" class="filter-input" placeholder="如: 100 或 100:200">
                    </div>
                </div>
                
                <!-- 日期筛选区域 -->
                <div id="dateFilterSection" style="display: none;">
                    <div class="filter-group">
                        <span class="filter-label">起始日期:</span>
                        <input type="date" id="startDateFilter" class="filter-input">
                    </div>
                    <div class="filter-group">
                        <span class="filter-label">结束日期:</span>
                        <input type="date" id="endDateFilter" class="filter-input">
                    </div>
                </div>
                
                <div class="filter-group">
                    <span class="filter-label">作者:</span>
                    <input type="text" id="authorFilter" class="filter-input" placeholder="作者名称">
                </div>
                <div class="filter-group">
                    <span class="filter-label">内容:</span>
                    <input type="text" id="contentFilter" class="filter-input" placeholder="日志内容">
                </div>
                <button id="filterButton" class="filter-button">筛选</button>
                <button id="clearFilterButton" class="filter-button filter-clear">清除</button>
                <div class="filter-result" id="filterResult"></div>
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
                    const localRevisionInfo = document.getElementById('localRevisionInfo');
                    const localRevisionNumber = document.getElementById('localRevisionNumber');
                    
                    // 筛选表单元素
                    const revisionFilter = document.getElementById('revisionFilter');
                    const authorFilter = document.getElementById('authorFilter');
                    const contentFilter = document.getElementById('contentFilter');
                    const filterButton = document.getElementById('filterButton');
                    const clearFilterButton = document.getElementById('clearFilterButton');
                    const filterResult = document.getElementById('filterResult');
                    
                    // 日期筛选表单元素
                    const dateFilterToggle = document.getElementById('dateFilterToggle');
                    const revisionFilterSection = document.getElementById('revisionFilterSection');
                    const dateFilterSection = document.getElementById('dateFilterSection');
                    const startDateFilter = document.getElementById('startDateFilter');
                    const endDateFilter = document.getElementById('endDateFilter');
                    
                    // 默认设置当前日期为结束日期，三天前为开始日期
                    const today = new Date();
                    const threeDaysAgo = new Date(today);
                    threeDaysAgo.setDate(today.getDate() - 3);
                    
                    // 格式化为 YYYY-MM-DD
                    startDateFilter.value = threeDaysAgo.toISOString().split('T')[0];
                    endDateFilter.value = today.toISOString().split('T')[0];
                    
                    // 日期筛选切换事件
                    dateFilterToggle.addEventListener('change', () => {
                        const useDate = dateFilterToggle.checked;
                        revisionFilterSection.style.display = useDate ? 'none' : 'block';
                        dateFilterSection.style.display = useDate ? 'block' : 'none';
                        debugLog('切换筛选模式: ' + (useDate ? '日期筛选' : '修订版本筛选'));
                    });
                    
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
                    
                    // 存储本地修订版本号
                    let localRevision = null;
                    
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
                                this._log('更新目标路径: ' + message.targetPath);
                                this._targetPath = message.targetPath;
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
                            case 'filterResult':
                                debugLog('筛选结果: ' + message.count + ' 条记录');
                                if (message.error) {
                                    // 如果有错误信息，显示错误
                                    filterResult.textContent = message.error;
                                    filterResult.style.color = 'var(--vscode-errorForeground)';
                                } else {
                                    // 显示正常结果
                                    filterResult.textContent = '找到 ' + message.count + ' 条记录';
                                    filterResult.style.color = 'var(--vscode-descriptionForeground)';
                                }
                                break;
                            case 'updateLocalRevision':
                                localRevision = message.localRevision;
                                debugLog('更新本地修订版本号: ' + localRevision);
                                
                                // 更新界面显示
                                if (localRevision) {
                                    localRevisionNumber.textContent = localRevision;
                                    localRevisionInfo.style.display = 'flex';
                                } else {
                                    localRevisionInfo.style.display = 'none';
                                }
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
                            const isNewerThanLocal = entry.isNewerThanLocal;
                            const messagePreview = entry.message.length > 100 
                                ? entry.message.substring(0, 100) + '...' 
                                : entry.message;
                            
                            // 为版本号旁边的标记定义新样式
                            const inlineNewerBadge = isNewerThanLocal ? 
                                '<span style="display: inline-block; background-color: #ff9800; color: white; font-size: 0.8em; padding: 1px 5px; border-radius: 3px; margin-left: 5px; vertical-align: middle;">未更新</span>' : 
                                '';
                            
                            html += \`
                                <div class="log-entry \${isSelected ? 'selected' : ''} \${isNewerThanLocal ? 'newer-than-local' : ''}" data-revision="\${entry.revision}">
                                    <div class="log-header">
                                        <span class="log-revision">修订版本 \${entry.revision} \${inlineNewerBadge}</span>
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
                        
                        // 添加详情头部，包含版本对比信息
                        const isNewerThanLocal = details.isNewerThanLocal;
                        const versionCompareInfo = localRevision && details.revision ? 
                            (isNewerThanLocal ? 
                                \`<span style="color: #ff9800; font-weight: bold;">此版本 (r\${details.revision}) 尚未更新到本地 (r\${localRevision})</span>\` : 
                                \`<span>此版本 (r\${details.revision}) 已包含在本地版本 (r\${localRevision}) 中</span>\`) : 
                            '';
                        
                        html += \`
                            <div class="detail-header">
                                <div class="detail-title">修订版本 \${details.revision}</div>
                                <div class="detail-info">
                                    <span>作者: \${details.author}</span>
                                    <span>日期: \${details.date}</span>
                                </div>
                                \${versionCompareInfo ? \`<div style="margin-top: 5px;">\${versionCompareInfo}</div>\` : ''}
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
                    
                    // 筛选按钮点击事件
                    filterButton.addEventListener('click', () => {
                        const useDate = dateFilterToggle.checked;
                        const revision = revisionFilter.value.trim();
                        const author = authorFilter.value.trim();
                        const content = contentFilter.value.trim();
                        const startDate = startDateFilter.value.trim();
                        const endDate = endDateFilter.value.trim();
                        
                        debugLog('执行筛选: 使用日期=' + useDate + 
                                 ', 修订版本=' + (revision || '无') + 
                                 ', 作者=' + (author || '无') + 
                                 ', 内容=' + (content || '无') + 
                                 ', 起始日期=' + (startDate || '无') + 
                                 ', 结束日期=' + (endDate || '无'));
                        
                        // 确保至少有一个筛选条件
                        if (useDate) {
                            // 日期筛选模式下，如果未设置日期，将使用默认的3天
                            if (!author && !content && !startDate && !endDate) {
                                debugLog('没有输入筛选条件，日期筛选模式下将使用默认的3天');
                            }
                        } else {
                            // 修订版本筛选模式下，确保至少有一个筛选条件
                            if (!revision && !author && !content) {
                                debugLog('没有输入筛选条件');
                                filterResult.textContent = '请至少输入一个筛选条件';
                                return;
                            }
                        }
                        
                        // 发送筛选消息到扩展
                        vscode.postMessage({
                            command: 'filterLogs',
                            revision: revision,
                            author: author,
                            content: content,
                            startDate: startDate,
                            endDate: endDate,
                            useDate: useDate
                        });
                    });
                    
                    // 清除筛选按钮点击事件
                    clearFilterButton.addEventListener('click', () => {
                        debugLog('清除筛选条件');
                        
                        // 清空筛选输入框
                        revisionFilter.value = '';
                        authorFilter.value = '';
                        contentFilter.value = '';
                        startDateFilter.value = threeDaysAgo.toISOString().split('T')[0];
                        endDateFilter.value = today.toISOString().split('T')[0];
                        dateFilterToggle.checked = false;
                        revisionFilterSection.style.display = 'block';
                        dateFilterSection.style.display = 'none';
                        filterResult.textContent = '';
                        
                        // 刷新日志列表
                        vscode.postMessage({
                            command: 'refresh'
                        });
                    });
                    
                    // 添加回车键提交筛选
                    function handleFilterKeyPress(e) {
                        if (e.key === 'Enter') {
                            filterButton.click();
                        }
                    }
                    
                    revisionFilter.addEventListener('keypress', handleFilterKeyPress);
                    authorFilter.addEventListener('keypress', handleFilterKeyPress);
                    contentFilter.addEventListener('keypress', handleFilterKeyPress);
                    
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
     * 筛选日志条目
     */
    private async _filterLogs(revision: string, author: string, content: string, startDate?: string, endDate?: string, useDate: boolean = false) {
        try {
            this._log(`开始筛选日志: 修订版本=${revision || '无'}, 作者=${author || '无'}, 内容=${content || '无'}, 起始日期=${startDate || '无'}, 结束日期=${endDate || '无'}, 使用日期=${useDate}`);
            
            // 显示加载中状态
            this._panel.webview.postMessage({ command: 'setLoading', value: true });
            
            // 如果本地版本号未获取，先获取它
            if (this._localRevision === null) {
                await this._getLocalRevision();
            }
            
            // 构建SVN命令参数
            let commandArgs = '';
            
            // 添加日期或修订版本筛选
            if (useDate) {
                // 使用日期筛选
                if (startDate || endDate) {
                    let dateRangeStr = '';
                    
                    // 构建日期范围，格式：{startDate}:{endDate}
                    if (startDate && endDate) {
                        dateRangeStr = `{${startDate}}:{${endDate}}`;
                    } else if (startDate) {
                        dateRangeStr = `{${startDate}}:HEAD`;
                    } else if (endDate) {
                        // 如果只有结束日期，从最早的版本开始
                        dateRangeStr = `1:{${endDate}}`;
                    }
                    
                    if (dateRangeStr) {
                        commandArgs += ` -r ${dateRangeStr} `;
                    }
                } else {
                    // 如果没有指定日期，默认显示最近3天的记录
                    const now = new Date();
                    const threeDaysAgo = new Date(now);
                    threeDaysAgo.setDate(now.getDate() - 3);
                    
                    // 格式化日期，YYYY-MM-DD
                    const startDateStr = `${threeDaysAgo.getFullYear()}-${String(threeDaysAgo.getMonth() + 1).padStart(2, '0')}-${String(threeDaysAgo.getDate()).padStart(2, '0')}`;
                    const endDateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                    
                    this._log(`未指定日期，使用默认日期范围: ${startDateStr} 至 ${endDateStr}`);
                    commandArgs += ` -r {${startDateStr}}:{${endDateStr}} `;
                }
            } else {
                // 使用修订版本筛选
                if (revision && revision.trim()) {
                    // 支持单个版本号、版本范围或多个版本号
                    // 例如: 100, 100:200, 100,105,110
                    commandArgs += ` -r ${revision.trim()} `;
                } else {
                    // 如果没有指定修订版本，默认获取最近50条记录
                    const logLimit = 50;
                    this._log(`未指定修订版本，默认获取最近${logLimit}条记录`);
                    commandArgs += ` -l ${logLimit} `;
                }
            }
            
            // 如果没有使用日期参数且没有指定修订版本号，限制获取的日志条目数量，防止缓冲区溢出
            if (!useDate && (!revision || !revision.trim())) {
                const logLimit = 50; // 默认获取最近50条记录
                commandArgs += ` -l ${logLimit} `;
            }
            
            // 执行SVN命令获取筛选后的日志
            const logCommand = `log "${this._targetPath}" ${commandArgs} --verbose --xml`;
            this._log(`执行SVN命令: ${logCommand}`);
            
            const logXml = await this.svnService.executeSvnCommand(logCommand, path.dirname(this._targetPath), false);
            
            // 解析XML获取日志条目
            this._logEntries = this._parseLogXml(logXml);
            this._log(`解析得到 ${this._logEntries.length} 条日志条目`);
            
            // 客户端筛选（作者和内容）
            if (author || content) {
                const filteredEntries = this._logEntries.filter(entry => {
                    // 作者筛选
                    if (author && !entry.author.toLowerCase().includes(author.toLowerCase())) {
                        return false;
                    }
                    
                    // 内容筛选
                    if (content && !entry.message.toLowerCase().includes(content.toLowerCase())) {
                        return false;
                    }
                    
                    return true;
                });
                
                this._log(`客户端筛选后剩余 ${filteredEntries.length} 条日志条目`);
                this._logEntries = filteredEntries;
            }
            
            // 标记哪些版本比本地版本更新
            this._markNewerRevisions();
            
            // 更新界面
            this._updateLogList();
            
            // 隐藏加载状态
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
            
            // 发送筛选结果数量
            this._panel.webview.postMessage({
                command: 'filterResult',
                count: this._logEntries.length
            });
        } catch (error: any) {
            this._log(`筛选日志失败: ${error.message}`);
            
            // 给用户更友好的错误提示
            let errorMessage = `筛选日志失败: ${error.message}`;
            
            // 处理特定错误类型
            if (error.message.includes('maxBuffer length exceeded')) {
                errorMessage = '日志数据量过大，请添加更具体的筛选条件或使用修订版本范围限制查询结果数量';
                this._log('建议: 使用修订版本范围缩小查询范围，如: "1000:1100"');
            }
            
            vscode.window.showErrorMessage(errorMessage);
            this._panel.webview.postMessage({ command: 'setLoading', value: false });
            
            // 即使出错，也保持界面响应性
            this._panel.webview.postMessage({
                command: 'filterResult',
                count: 0,
                error: errorMessage
            });
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

    // 添加新方法，用于更新日志条目数组并记录最小版本号
    private _updateLogEntries(newEntries: SvnLogEntry[], isLoadingMore: boolean) {
        if (newEntries.length === 0) {
            this._log('没有获取到新的日志条目');
            return;
        }
        
        // 如果是加载更多，将新条目追加到现有条目后
        if (isLoadingMore) {
            this._logEntries = [...this._logEntries, ...newEntries];
        } else {
            // 否则替换现有条目
            this._logEntries = newEntries;
        }
        
        // 记录最小版本号
        if (this._logEntries.length > 0) {
            const minRevision = Math.min(...this._logEntries.map(entry => parseInt(entry.revision)));
            this._minLoadedRevision = minRevision.toString();
            this._log(`更新已加载的最小版本号: ${this._minLoadedRevision}`);
        }
        
        // 记录日志条目的路径信息（仅记录新增的条目）
        newEntries.forEach((entry, index) => {
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
    }
}