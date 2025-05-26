import * as vscode from 'vscode';
import * as path from 'path';
import { minimatch } from 'minimatch';

/**
 * SVN过滤服务类
 * 用于过滤不需要进行SVN操作的文件和文件夹
 */
export class SvnFilterService {
  
  /**
   * 检查文件是否应该被排除
   * @param filePath 文件路径
   * @param basePath 基础路径（用于计算相对路径）
   * @returns 是否应该被排除
   */
  public shouldExcludeFile(filePath: string, basePath?: string): boolean {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    const excludeFiles = config.get<string[]>('excludeFiles', []);
    const excludeFolders = config.get<string[]>('excludeFolders', []);
    
    // 获取文件名和相对路径
    const fileName = path.basename(filePath);
    const relativePath = basePath ? path.relative(basePath, filePath) : filePath;
    
    // 检查文件名是否匹配排除模式
    for (const pattern of excludeFiles) {
      if (this.matchPattern(fileName, pattern) || this.matchPattern(relativePath, pattern)) {
        return true;
      }
    }
    
    // 检查路径中是否包含被排除的文件夹
    const pathParts = relativePath.split(path.sep);
    for (const part of pathParts) {
      if (excludeFolders.includes(part)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * 检查文件夹是否应该被排除
   * @param folderPath 文件夹路径
   * @param basePath 基础路径（用于计算相对路径）
   * @returns 是否应该被排除
   */
  public shouldExcludeFolder(folderPath: string, basePath?: string): boolean {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    const excludeFolders = config.get<string[]>('excludeFolders', []);
    
    // 获取文件夹名和相对路径
    const folderName = path.basename(folderPath);
    const relativePath = basePath ? path.relative(basePath, folderPath) : folderPath;
    
    // 检查文件夹名是否在排除列表中
    if (excludeFolders.includes(folderName)) {
      return true;
    }
    
    // 检查相对路径中是否包含被排除的文件夹
    const pathParts = relativePath.split(path.sep);
    for (const part of pathParts) {
      if (excludeFolders.includes(part)) {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * 过滤文件列表
   * @param files 文件路径列表
   * @param basePath 基础路径
   * @returns 过滤后的文件列表
   */
  public filterFiles(files: string[], basePath?: string): string[] {
    return files.filter(file => !this.shouldExcludeFile(file, basePath));
  }
  
  /**
   * 过滤文件夹列表
   * @param folders 文件夹路径列表
   * @param basePath 基础路径
   * @returns 过滤后的文件夹列表
   */
  public filterFolders(folders: string[], basePath?: string): string[] {
    return folders.filter(folder => !this.shouldExcludeFolder(folder, basePath));
  }
  
  /**
   * 使用glob模式匹配
   * @param text 要匹配的文本
   * @param pattern 匹配模式
   * @returns 是否匹配
   */
  private matchPattern(text: string, pattern: string): boolean {
    try {
      // 使用minimatch进行glob模式匹配
      return minimatch(text, pattern, { 
        matchBase: true,  // 允许基础名称匹配
        dot: true,        // 匹配以.开头的文件
        nocase: process.platform === 'win32'  // Windows下忽略大小写
      });
    } catch (error) {
      // 如果模式无效，则进行简单的字符串匹配
      return text.includes(pattern);
    }
  }
  
  /**
   * 获取当前的排除配置
   * @returns 排除配置对象
   */
  public getExcludeConfig(): { files: string[], folders: string[] } {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    return {
      files: config.get<string[]>('excludeFiles', []),
      folders: config.get<string[]>('excludeFolders', [])
    };
  }
  
  /**
   * 更新排除配置
   * @param files 排除的文件模式列表
   * @param folders 排除的文件夹列表
   */
  public async updateExcludeConfig(files: string[], folders: string[]): Promise<void> {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    await config.update('excludeFiles', files, vscode.ConfigurationTarget.Workspace);
    await config.update('excludeFolders', folders, vscode.ConfigurationTarget.Workspace);
  }
  
  /**
   * 显示排除配置信息
   */
  public showExcludeInfo(): void {
    const config = this.getExcludeConfig();
    const message = `当前排除配置：\n\n文件模式：\n${config.files.join('\n')}\n\n文件夹：\n${config.folders.join('\n')}`;
    vscode.window.showInformationMessage(message, { modal: true });
  }
} 