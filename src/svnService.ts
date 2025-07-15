import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';
import { SvnFilterService } from './filterService';

const exec = promisify(cp.exec);
const fsExists = promisify(fs.exists);

/**
 * SVN操作服务类
 */
export class SvnService {
  // 存储自定义SVN工作副本路径
  private customSvnRoot: string | undefined;
  private outputChannel: vscode.OutputChannel;
  private filterService: SvnFilterService;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('SVN命令诊断');
    this.filterService = new SvnFilterService();
  }

  /**
   * 获取用户配置的编码设置
   */
  private getEncodingConfig(): { encoding: string; locale: string } {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    const encoding = config.get<string>('encoding', 'utf8');
    const locale = config.get<string>('svnLocale', 'en_US.UTF-8');
    
    this.outputChannel.appendLine(`[getEncodingConfig] 编码设置: ${encoding}, 语言环境: ${locale}`);
    return { encoding, locale };
  }

  /**
   * 执行SVN命令
   * @param command SVN命令
   * @param path 工作目录
   * @param useXml 是否使用XML输出
   * @returns 命令执行结果
   */
  public async executeSvnCommand(command: string, path: string, useXml: boolean = false): Promise<string> {
    try {
      this.outputChannel.appendLine(`\n[executeSvnCommand] 执行SVN命令: svn ${command}`);
      this.outputChannel.appendLine(`[executeSvnCommand] 工作目录: ${path}`);
      
      // 获取用户配置的编码设置
      const { encoding, locale } = this.getEncodingConfig();
      
      // 设置环境变量以解决编码问题
      const env = {
        ...process.env,
        LANG: locale,
        LC_ALL: locale,
        LANGUAGE: locale,
        SVN_EDITOR: 'vim'
      };
      
      this.outputChannel.appendLine(`[executeSvnCommand] 设置环境变量: LANG=${locale}, LC_ALL=${locale}, LANGUAGE=${locale}`);
      
      // 根据 useXml 参数决定是否添加 --xml 标志
      const xmlFlag = useXml ? '--xml' : '';
      
      if (xmlFlag) {
        this.outputChannel.appendLine(`[executeSvnCommand] 添加XML输出标志: ${xmlFlag}`);
      }
      
      // 对于diff命令，添加特殊处理
      if (command.includes('diff') && !command.includes('--force')) {
        command = `${command} --force`;
        this.outputChannel.appendLine(`[executeSvnCommand] 为diff命令添加--force参数`);
      }
      
      // 记录最终命令
      const finalCommand = `svn ${command} ${xmlFlag}`;
      this.outputChannel.appendLine(`[executeSvnCommand] 最终命令: ${finalCommand}`);
      
      // 执行命令
      this.outputChannel.appendLine(`[executeSvnCommand] 开始执行命令...`);
      return new Promise<string>((resolve, reject) => {
        const svnProcess = cp.exec(
          finalCommand, 
          { 
            cwd: path, 
            env,
            encoding: encoding as BufferEncoding, // 使用用户配置的编码
            maxBuffer: 50 * 1024 * 1024 // 增加缓冲区大小到50MB
          },
          (error, stdout, stderr) => {
            if (error) {
              this.outputChannel.appendLine(`[executeSvnCommand] 命令执行失败，错误码: ${error.code}`);
              if (stderr) {
                this.outputChannel.appendLine(`[executeSvnCommand] 错误输出: ${stderr}`);
                reject(new Error(`SVN错误: ${stderr}`));
              } else {
                this.outputChannel.appendLine(`[executeSvnCommand] 错误信息: ${error.message}`);
                reject(error);
              }
            } else {
              this.outputChannel.appendLine(`[executeSvnCommand] 命令执行成功，输出长度: ${stdout.length} 字节，使用编码: ${encoding}`);
              if (stdout.length < 1000) {
                this.outputChannel.appendLine(`[executeSvnCommand] 输出内容: ${stdout.replace(/\n/g, '\\n')}`);
              } else {
                this.outputChannel.appendLine(`[executeSvnCommand] 输出内容前1000个字符: ${stdout.substring(0, 1000).replace(/\n/g, '\\n')}...`);
              }
              resolve(stdout);
            }
          }
        );
        
        // 记录命令输出
        svnProcess.stdout?.on('data', (data) => {
          this.outputChannel.appendLine(`[executeSvnCommand] 命令输出: ${data.toString().replace(/\n/g, '\\n')}`);
        });
        
        svnProcess.stderr?.on('data', (data) => {
          this.outputChannel.appendLine(`[executeSvnCommand] 错误输出: ${data.toString().replace(/\n/g, '\\n')}`);
        });
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[executeSvnCommand] 捕获到异常: ${error.message}`);
      if (error.stderr) {
        this.outputChannel.appendLine(`[executeSvnCommand] 错误输出: ${error.stderr}`);
        throw new Error(`SVN错误: ${error.stderr}`);
      }
      throw error;
    }
  }

  /**
   * 检查SVN是否已安装
   * @returns 是否已安装
   */
  public async isSvnInstalled(): Promise<boolean> {
    try {
      await exec('svn --version');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 设置自定义SVN工作副本路径
   * @param svnRootPath SVN工作副本根目录路径
   * @returns 是否设置成功
   */
  public async setCustomSvnRoot(svnRootPath: string): Promise<boolean> {
    // 检查路径是否存在
    if (!await fsExists(svnRootPath)) {
      return false;
    }

    // 检查是否包含.svn目录
    const svnDirPath = path.join(svnRootPath, '.svn');
    if (!await fsExists(svnDirPath)) {
      return false;
    }

    // 设置自定义SVN工作副本路径
    this.customSvnRoot = svnRootPath;
    
    // 保存到配置中，以便在会话之间保持
    await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', svnRootPath, vscode.ConfigurationTarget.Workspace);
    
    return true;
  }

  /**
   * 获取自定义SVN工作副本路径
   * @returns SVN工作副本根目录路径
   */
  public getCustomSvnRoot(): string | undefined {
    if (!this.customSvnRoot) {
      // 从配置中读取
      this.customSvnRoot = vscode.workspace.getConfiguration('vscode-svn').get<string>('customSvnRoot');
    }
    return this.customSvnRoot;
  }

  /**
   * 清除自定义SVN工作副本路径
   */
  public async clearCustomSvnRoot(): Promise<void> {
    this.customSvnRoot = undefined;
    await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', undefined, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * 检查路径是否在SVN工作副本中
   * @param fsPath 文件系统路径
   * @returns 是否在SVN工作副本中
   */
  public async isInWorkingCopy(fsPath: string): Promise<boolean> {
    try {
      // 首先尝试直接使用svn info命令
      try {
        // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
        let targetPath = fsPath;
        if (fsPath.includes('@')) {
          targetPath = `${fsPath}@`;
        }
        
        await this.executeSvnCommand('info', targetPath);
        return true;
      } catch (error) {
        // 如果直接检查失败，并且有自定义SVN根目录，则使用自定义根目录
        if (this.getCustomSvnRoot()) {
          // 获取相对于自定义SVN根目录的路径
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          // 如果路径以..开头，说明文件不在SVN根目录下
          if (relativePath.startsWith('..')) {
            return false;
          }
          
          // 特殊处理：如果相对路径包含@符号，需要在路径后添加额外的@来转义
          let escapedPath = relativePath;
          if (relativePath.includes('@')) {
            escapedPath = `${relativePath}@`;
          }
          
          // 尝试在自定义SVN根目录下执行svn info命令
          try {
            await this.executeSvnCommand(`info "${escapedPath}"`, this.getCustomSvnRoot()!);
            return true;
          } catch (error) {
            return false;
          }
        }
        return false;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取文件状态
   * @param filePath 文件路径
   * @returns 文件状态
   */
  public async getFileStatus(filePath: string): Promise<string> {
    try {
      let cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`[getFileStatus] 获取文件状态: ${filePath}`);
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }
      
      // 如果有自定义SVN根目录，并且直接检查失败，则使用自定义根目录
      if (this.getCustomSvnRoot()) {
        try {
          const result = await this.executeSvnCommand(`status "${fileName}"`, cwd);
          if (result) {
            // 如果直接检查成功，使用直接结果
            this.outputChannel.appendLine(`[getFileStatus] 直接检查成功，状态结果: ${result.substring(0, 100).replace(/\n/g, '\\n')}`);
            return this.parseStatusCode(result);
          }
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            cwd = this.getCustomSvnRoot()!;
            fileName = relativePath;
            // 如果相对路径包含@符号，也需要转义
            if (needsEscaping && !fileName.endsWith('@')) {
              fileName = `${fileName}@`;
            }
          }
        }
      }
      
      const result = await this.executeSvnCommand(`status "${fileName}"`, cwd);
      this.outputChannel.appendLine(`[getFileStatus] 状态结果: ${result.substring(0, 100).replace(/\n/g, '\\n')}`);
      return this.parseStatusCode(result);
    } catch (error: any) {
      this.outputChannel.appendLine(`[getFileStatus] 获取状态失败: ${error.message}`);
      return '未知状态';
    }
  }

  /**
   * 解析SVN状态码
   * @param statusResult SVN状态命令结果
   * @returns 状态描述
   */
  private parseStatusCode(statusResult: string): string {
    this.outputChannel.appendLine(`[parseStatusCode] 解析状态码: ${statusResult.substring(0, 100).replace(/\n/g, '\\n')}`);
    
    if (statusResult.trim() === '') {
      return '无修改';
    }
    
    // 检查是否是XML格式的输出
    if (statusResult.includes('<?xml') && statusResult.includes('<wc-status')) {
      // 解析XML格式的状态
      const itemMatch = statusResult.match(/item="([^"]+)"/);
      if (itemMatch && itemMatch[1]) {
        const statusCode = itemMatch[1];
        this.outputChannel.appendLine(`[parseStatusCode] 从XML中提取的状态码: ${statusCode}`);
        
        switch (statusCode) {
          case 'modified': return '已修改';
          case 'added': return '已添加';
          case 'deleted': return '已删除';
          case 'replaced': return '已替换';
          case 'conflicted': return '冲突';
          case 'unversioned': return '未版本控制';
          case 'missing': return '丢失';
          case 'ignored': return '已忽略';
          case 'obstructed': return '类型变更';
          default: return `未知状态(${statusCode})`;
        }
      }
    }
    
    // 如果不是XML格式或无法解析XML，则使用原来的方式解析
    const statusCode = statusResult.trim().charAt(0);
    this.outputChannel.appendLine(`[parseStatusCode] 使用第一个字符作为状态码: ${statusCode}`);
    
    switch (statusCode) {
      case 'M': return '已修改';
      case 'A': return '已添加';
      case 'D': return '已删除';
      case 'R': return '已替换';
      case 'C': return '冲突';
      case '?': return '未版本控制';
      case '!': return '丢失';
      case 'I': return '已忽略';
      case '~': return '类型变更';
      default: return `未知状态(${statusCode})`;
    }
  }

  /**
   * 添加文件到SVN
   * @param filePath 文件路径
   */
  public async addFile(filePath: string): Promise<void> {
    // 检查文件是否应该被排除
    if (this.filterService.shouldExcludeFile(filePath)) {
      vscode.window.showWarningMessage(`文件 ${path.basename(filePath)} 在排除列表中，已跳过添加`);
      return;
    }
    
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
    // 因为在SVN中@符号用于指定版本号
    const needsEscaping = fileName.includes('@');
    if (needsEscaping) {
      fileName = `${fileName}@`;
    }
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
        await this.executeSvnCommand(infoCommand, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
          // 如果相对路径包含@符号，也需要转义
          if (needsEscaping && !fileName.endsWith('@')) {
            fileName = `${fileName}@`;
          }
        }
      }
    }
    
    await this.executeSvnCommand(`add "${fileName}"`, cwd);
  }

  /**
   * 删除文件
   * @param filePath 文件路径
   */
  public async removeFile(filePath: string): Promise<void> {
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
    // 因为在SVN中@符号用于指定版本号
    const needsEscaping = fileName.includes('@');
    if (needsEscaping) {
      fileName = `${fileName}@`;
    }
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
        await this.executeSvnCommand(infoCommand, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
          // 如果相对路径包含@符号，也需要转义
          if (needsEscaping && !fileName.endsWith('@')) {
            fileName = `${fileName}@`;
          }
        }
      }
    }
    
    await this.executeSvnCommand(`remove "${fileName}"`, cwd);
  }

  /**
   * 确保输出面板可见并为新操作做准备
   * @param title 操作标题
   * @private
   */
  private showOutputChannel(title: string): void {
    this.outputChannel.clear();
    this.outputChannel.show(true); // true参数表示聚焦到输出面板
    this.outputChannel.appendLine(`========== ${title}开始 ==========`);
    this.outputChannel.appendLine(`时间: ${new Date().toLocaleString()}`);
    this.outputChannel.appendLine('--------------------------------------');
  }

  /**
   * 提交文件或文件夹
   * @param fsPath 文件系统路径
   * @param message 提交信息
   */
  public async commit(fsPath: string, message: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN提交操作');
    this.outputChannel.appendLine(`提交路径: ${fsPath}`);
    this.outputChannel.appendLine(`提交信息: ${message}`);
    
    // 检查文件是否应该被排除
    if (this.filterService.shouldExcludeFile(fsPath)) {
      this.outputChannel.appendLine(`文件 ${fsPath} 被过滤器排除，跳过提交操作`);
      this.outputChannel.appendLine('========== SVN提交操作跳过 ==========');
      vscode.window.showWarningMessage(`文件 ${path.basename(fsPath)} 在排除列表中，已跳过提交`);
      return;
    }
    
    try {
      const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type === vscode.FileType.Directory;
      
      this.outputChannel.appendLine('正在检查文件状态...');
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', fsPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          if (!relativePath.startsWith('..')) {
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${this.getCustomSvnRoot()!}`);
            this.outputChannel.appendLine(`相对路径: ${relativePath}`);
            this.outputChannel.appendLine('正在提交文件...');
            
            // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            if (isDirectory) {
              const result = await this.executeSvnCommand(`commit "${escapedPath}" -m "${message}"`, this.getCustomSvnRoot()!);
              this.outputChannel.appendLine(result);
              this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
              return;
            } else {
              const result = await this.executeSvnCommand(`commit "${escapedPath}" -m "${message}"`, this.getCustomSvnRoot()!);
              this.outputChannel.appendLine(result);
              this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
              return;
            }
          }
        }
      }
      
      this.outputChannel.appendLine('正在提交文件...');
      if (isDirectory) {
        const result = await this.executeSvnCommand(`commit -m "${message}"`, fsPath);
        this.outputChannel.appendLine(result);
      } else {
        const cwd = path.dirname(fsPath);
        let fileName = path.basename(fsPath);
        
        // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
        if (fileName.includes('@')) {
          fileName = `${fileName}@`;
        }
        
        this.outputChannel.appendLine(`工作目录: ${cwd}`);
        this.outputChannel.appendLine(`文件名: ${fileName}`);
        const result = await this.executeSvnCommand(`commit "${fileName}" -m "${message}"`, cwd);
        this.outputChannel.appendLine(result);
      }
      
      this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN提交操作失败 ==========');
      
      // 检查是否是"out of date"错误
      if (this.isOutOfDateError(error.message)) {
        await this.handleOutOfDateError(fsPath, message);
        return; // 如果用户选择了处理，则不再抛出错误
      }
      
      throw error;
    }
  }

  /**
   * 更新工作副本
   * @param fsPath 文件系统路径
   */
  public async update(fsPath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN更新操作');
    this.outputChannel.appendLine(`更新路径: ${fsPath}`);
    
    // 检查文件或文件夹是否应该被排除
    const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type === vscode.FileType.Directory;
    if ((isDirectory && this.filterService.shouldExcludeFolder(fsPath)) || 
        (!isDirectory && this.filterService.shouldExcludeFile(fsPath))) {
      this.outputChannel.appendLine(`路径 ${fsPath} 被过滤器排除，跳过更新操作`);
      this.outputChannel.appendLine('========== SVN更新操作跳过 ==========');
      vscode.window.showWarningMessage(`${isDirectory ? '文件夹' : '文件'} ${path.basename(fsPath)} 在排除列表中，已跳过更新`);
      return;
    }
    
    try {
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', fsPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          if (!relativePath.startsWith('..')) {
            // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${this.getCustomSvnRoot()!}`);
            this.outputChannel.appendLine(`相对路径: ${escapedPath}`);
            const result = await this.executeSvnCommand(`update "${escapedPath}"`, this.getCustomSvnRoot()!);
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN更新操作完成 ==========');
            return;
          }
        }
      }
      
      // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
      let targetPath = fsPath;
      if (fsPath.includes('@') && !isDirectory) { // 只对文件应用转义，目录更新通常不需要指定路径
        targetPath = `${fsPath}@`;
        this.outputChannel.appendLine(`转义路径: ${targetPath}`);
      }
      
      this.outputChannel.appendLine('正在更新工作副本...');
      const updateCommand = isDirectory ? 'update' : `update "${targetPath}"`;
      const workingDir = isDirectory ? fsPath : path.dirname(fsPath);
      const result = await this.executeSvnCommand(updateCommand, workingDir);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN更新操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN更新操作失败 ==========');
      throw error;
    }
  }

  /**
   * 恢复文件到版本库状态
   * @param filePath 文件路径
   */
  public async revertFile(filePath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN恢复操作');
    this.outputChannel.appendLine(`恢复文件: ${filePath}`);
    
    try {
      this.outputChannel.appendLine('正在恢复文件到版本库状态...');
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      let fileName = path.basename(filePath);
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        // 对于revert，我们需要处理完整路径
        filePath = `${filePath}@`;
      }
      
      const result = await this.executeSvnCommand(`revert "${filePath}"`, path.dirname(filePath));
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN恢复操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN恢复操作失败 ==========');
      throw new Error(`恢复文件失败: ${error.message}`);
    }
  }

  /**
   * 恢复文件夹到版本库状态（递归恢复）
   * @param folderPath 文件夹路径
   */
  public async revertFolder(folderPath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN文件夹恢复操作');
    this.outputChannel.appendLine(`恢复文件夹: ${folderPath}`);
    
    // 检查文件夹是否应该被排除
    if (this.filterService.shouldExcludeFolder(folderPath)) {
      this.outputChannel.appendLine(`文件夹 ${folderPath} 被过滤器排除，跳过恢复操作`);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作跳过 ==========');
      vscode.window.showWarningMessage(`文件夹 ${path.basename(folderPath)} 在排除列表中，已跳过恢复`);
      return;
    }
    
    try {
      let workingDir = folderPath;
      let targetPath = '.';
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', folderPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, folderPath);
          if (!relativePath.startsWith('..')) {
            workingDir = this.getCustomSvnRoot()!;
            targetPath = relativePath || '.';
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${workingDir}`);
            this.outputChannel.appendLine(`相对路径: ${targetPath}`);
          }
        }
      }
      
      this.outputChannel.appendLine('正在恢复文件夹到版本库状态（递归）...');
      this.outputChannel.appendLine(`工作目录: ${workingDir}`);
      this.outputChannel.appendLine(`目标路径: ${targetPath}`);
      
      // 使用 -R 参数进行递归恢复
      const result = await this.executeSvnCommand(`revert -R "${targetPath}"`, workingDir);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作失败 ==========');
      throw new Error(`恢复文件夹失败: ${error.message}`);
    }
  }

  /**
   * 获取文件日志
   * @param filePath 文件路径
   * @param limit 限制条数
   * @returns 日志信息
   */
  public async getLog(filePath: string, limit: number = 10): Promise<string> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN日志查询');
    this.outputChannel.appendLine(`文件路径: ${filePath}`);
    this.outputChannel.appendLine(`限制条数: ${limit}`);
    
    try {
      let cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`工作目录: ${cwd}`);
      this.outputChannel.appendLine(`文件名: ${fileName}`);
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
          await this.executeSvnCommand(infoCommand, cwd);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            cwd = this.getCustomSvnRoot()!;
            fileName = relativePath;
            // 如果相对路径包含@符号，也需要转义
            if (needsEscaping && !fileName.endsWith('@')) {
              fileName = `${fileName}@`;
            }
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${cwd}`);
            this.outputChannel.appendLine(`相对路径: ${fileName}`);
          }
        }
      }
      
      this.outputChannel.appendLine('正在获取日志...');
      const result = await this.executeSvnCommand(`log "${fileName}" -l ${limit}`, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN日志查询完成 ==========');
      
      return result;
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN日志查询失败 ==========');
      throw error;
    }
  }

  /**
   * 一次性提交多个文件
   * @param files 文件路径数组
   * @param message 提交信息
   * @param basePath 基础路径（用于确定工作目录）
   */
  public async commitFiles(files: string[], message: string, basePath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN批量提交操作');
    this.outputChannel.appendLine(`基础路径: ${basePath}`);
    this.outputChannel.appendLine(`提交信息: ${message}`);
    this.outputChannel.appendLine(`原始文件数量: ${files.length}`);
    
    // 应用过滤器
    const filteredFiles = this.filterService.filterFiles(files, basePath);
    const excludedFiles = files.filter(file => !filteredFiles.includes(file));
    
    this.outputChannel.appendLine(`过滤后文件数量: ${filteredFiles.length}`);
    if (excludedFiles.length > 0) {
      this.outputChannel.appendLine('被排除的文件:');
      excludedFiles.forEach((file, index) => {
        this.outputChannel.appendLine(`  ${index + 1}. ${file} (已排除)`);
      });
    }
    
    this.outputChannel.appendLine('要提交的文件列表:');
    filteredFiles.forEach((file, index) => {
      this.outputChannel.appendLine(`  ${index + 1}. ${file}`);
    });
    
    try {
      if (filteredFiles.length === 0) {
        throw new Error('没有可提交的文件（所有文件都被过滤器排除）');
      }
      
      // 检查是否使用自定义SVN根目录
      let workingDir = basePath;
      let fileArgs = '';
      
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', basePath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          workingDir = this.getCustomSvnRoot()!;
          
          this.outputChannel.appendLine(`使用自定义SVN根目录: ${workingDir}`);
          this.outputChannel.appendLine('正在处理文件路径...');
          
          // 构建相对路径参数
          fileArgs = filteredFiles.map(file => {
            const relativePath = path.relative(this.getCustomSvnRoot()!, file);
            if (relativePath.startsWith('..')) {
              throw new Error(`文件 ${file} 不在SVN工作副本中`);
            }
            
            // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`  ${file} -> ${escapedPath}`);
            return `"${escapedPath}"`;
          }).join(' ');
        }
      }
      
      // 如果没有使用自定义SVN根目录，或者检查成功
      if (fileArgs === '') {
        this.outputChannel.appendLine('正在处理文件路径...');
        
        // 构建文件参数
        fileArgs = filteredFiles.map(file => {
          // 如果文件在基础路径下，使用相对路径
          if (file.startsWith(workingDir)) {
            const relativePath = path.relative(workingDir, file);
            
            // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`  ${file} -> ${escapedPath}`);
            return `"${escapedPath}"`;
          }
          
          // 否则使用绝对路径
          // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
          let escapedPath = file;
          if (file.includes('@')) {
            escapedPath = `${file}@`;
          }
          
          this.outputChannel.appendLine(`  ${file} -> ${escapedPath} (绝对路径)`);
          return `"${escapedPath}"`;
        }).join(' ');
      }
      
      this.outputChannel.appendLine(`工作目录: ${workingDir}`);
      
      // 执行提交命令
      this.outputChannel.appendLine('正在提交文件...');
      const result = await this.executeSvnCommand(`commit ${fileArgs} -m "${message}"`, workingDir);
      this.outputChannel.appendLine(result);
      
      this.outputChannel.appendLine('========== SVN批量提交操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN批量提交操作失败 ==========');
      
      // 检查是否是"out of date"错误
      if (this.isOutOfDateError(error.message)) {
        await this.handleOutOfDateError(basePath, message, filteredFiles);
        return; // 如果用户选择了处理，则不再抛出错误
      }
      
      throw error;
    }
  }

  /**
   * 检查是否是"out of date"错误
   * @param errorMessage 错误消息
   * @returns 是否是"out of date"错误
   */
  private isOutOfDateError(errorMessage: string): boolean {
    return errorMessage.includes('out of date') || 
           errorMessage.includes('E155011') || 
           errorMessage.includes('E170004');
  }

  /**
   * 处理"out of date"错误
   * @param fsPath 文件系统路径
   * @param message 提交信息
   * @param files 可选的文件列表（用于批量提交）
   */
  private async handleOutOfDateError(fsPath: string, message: string, files?: string[]): Promise<void> {
    const result = await vscode.window.showWarningMessage(
      'SVN提交失败：工作副本版本过时，需要先更新到最新版本后再提交',
      {
        modal: true,
        detail: '这通常发生在其他人已经提交了对相同文件或文件夹的修改。\n\n建议先更新工作副本到最新版本，然后再重新提交。'
      },
      '自动更新并重试提交',
      '仅更新不重试',
      '取消'
    );

    if (result === '自动更新并重试提交') {
      try {
        // 先更新工作副本
        await this.update(fsPath);
        
        // 显示更新成功提示
        vscode.window.showInformationMessage('工作副本已更新到最新版本');
        
        // 询问是否继续提交
        const continueResult = await vscode.window.showInformationMessage(
          '工作副本已更新完成，是否继续提交？',
          '继续提交',
          '取消'
        );
        
        if (continueResult === '继续提交') {
          // 重新尝试提交
          if (files && files.length > 0) {
            // 批量提交
            await this.commitFiles(files, message, fsPath);
          } else {
            // 单文件提交
            await this.commit(fsPath, message);
          }
          
          vscode.window.showInformationMessage('提交成功！');
        }
      } catch (updateError: any) {
        vscode.window.showErrorMessage(`更新失败: ${updateError.message}`);
        throw updateError;
      }
    } else if (result === '仅更新不重试') {
      try {
        await this.update(fsPath);
        vscode.window.showInformationMessage('工作副本已更新到最新版本，请手动重新提交');
      } catch (updateError: any) {
        vscode.window.showErrorMessage(`更新失败: ${updateError.message}`);
        throw updateError;
      }
    } else {
      // 用户选择取消，抛出原始错误
      throw new Error('SVN提交失败：工作副本版本过时，需要先更新');
    }
  }
}
