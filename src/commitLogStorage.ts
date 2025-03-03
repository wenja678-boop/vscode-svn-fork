import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * 提交日志存储类
 */
export class CommitLogStorage {
  private context: vscode.ExtensionContext;
  private logs: Array<{
    timestamp: number;
    message: string;
    filePath: string;
  }>;
  private prefixes: string[] = [];
  private static readonly MAX_PREFIX_HISTORY = 10;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.logs = this.loadLogs();
    this.prefixes = this.loadPrefixes();
  }

  /**
   * 获取日志存储路径
   * 每次调用时都重新计算，确保使用最新的工作区
   */
  private getStoragePath(): string {
    // 获取当前工作区根目录
    let workspaceRoot = '';
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else {
      // 如果没有工作区，则使用扩展的全局存储路径作为备选
      workspaceRoot = this.context.globalStoragePath;
    }
    
    // 在工作区根目录下创建 .svn-logs 隐藏文件夹
    return path.join(workspaceRoot, '.svn-logs', 'commit_logs.json');
  }

  /**
   * 获取前缀存储路径
   */
  private getPrefixStoragePath(): string {
    let workspaceRoot = '';
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    } else {
      workspaceRoot = this.context.globalStoragePath;
    }
    
    return path.join(workspaceRoot, '.svn-logs', 'prefix_history.json');
  }

  /**
   * 加载历史日志
   */
  private loadLogs(): Array<{timestamp: number; message: string; filePath: string}> {
    try {
      const storagePath = this.getStoragePath();
      if (fs.existsSync(storagePath)) {
        const data = fs.readFileSync(storagePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('加载提交日志失败:', error);
    }
    return [];
  }

  /**
   * 加载前缀历史
   */
  private loadPrefixes(): string[] {
    try {
      const prefixPath = this.getPrefixStoragePath();
      if (fs.existsSync(prefixPath)) {
        const data = fs.readFileSync(prefixPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('加载前缀历史失败:', error);
    }
    return [];
  }

  /**
   * 保存日志到本地
   */
  private saveLogs(): void {
    try {
      const storagePath = this.getStoragePath();
      // 确保目录存在
      const dir = path.dirname(storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(storagePath, JSON.stringify(this.logs, null, 2));
    } catch (error) {
      console.error('保存提交日志失败:', error);
    }
  }

  /**
   * 保存前缀历史
   */
  private savePrefixes(): void {
    try {
      const prefixPath = this.getPrefixStoragePath();
      // 确保目录存在
      const dir = path.dirname(prefixPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(prefixPath, JSON.stringify(this.prefixes, null, 2));
    } catch (error) {
      console.error('保存前缀历史失败:', error);
    }
  }

  /**
   * 添加新的提交日志
   */
  public addLog(message: string, filePath: string): void {
    this.logs.unshift({
      timestamp: Date.now(),
      message,
      filePath
    });
    // 只保留最近的100条记录
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(0, 100);
    }
    this.saveLogs();
    
    // 尝试提取前缀并保存
    const lines = message.split('\n');
    if (lines.length > 0 && lines[0].trim()) {
      this.addPrefix(lines[0].trim());
    }
  }

  /**
   * 添加前缀到历史记录
   */
  public addPrefix(prefix: string): void {
    // 如果前缀已存在，先移除它
    const index = this.prefixes.indexOf(prefix);
    if (index !== -1) {
      this.prefixes.splice(index, 1);
    }
    
    // 添加到列表开头
    this.prefixes.unshift(prefix);
    
    // 限制数量
    if (this.prefixes.length > CommitLogStorage.MAX_PREFIX_HISTORY) {
      this.prefixes = this.prefixes.slice(0, CommitLogStorage.MAX_PREFIX_HISTORY);
    }
    
    this.savePrefixes();
  }

  /**
   * 获取历史日志
   * 每次获取前重新加载，确保数据最新
   */
  public getLogs(): Array<{timestamp: number; message: string; filePath: string}> {
    // 重新加载日志，确保获取最新数据
    this.logs = this.loadLogs();
    return this.logs;
  }

  /**
   * 获取前缀历史
   */
  public getPrefixes(): string[] {
    // 重新加载前缀，确保获取最新数据
    this.prefixes = this.loadPrefixes();
    return this.prefixes;
  }

  /**
   * 获取最近使用的前缀
   */
  public getLatestPrefix(): string {
    const prefixes = this.getPrefixes();
    return prefixes.length > 0 ? prefixes[0] : '';
  }
} 