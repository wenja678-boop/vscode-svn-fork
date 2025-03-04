import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

const exec = promisify(cp.exec);
const fsExists = promisify(fs.exists);

/**
 * SVN操作服务类
 */
export class SvnService {
  // 存储自定义SVN工作副本路径
  private customSvnRoot: string | undefined;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('SVN命令诊断');
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
      
      // 设置环境变量以解决编码问题
      const env = {
        ...process.env,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        LANGUAGE: 'en_US.UTF-8',
        SVN_EDITOR: 'vim'
      };
      
      this.outputChannel.appendLine(`[executeSvnCommand] 设置环境变量: LANG=en_US.UTF-8, LC_ALL=en_US.UTF-8, LANGUAGE=en_US.UTF-8`);
      
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
            maxBuffer: 10 * 1024 * 1024 // 增加缓冲区大小到10MB
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
              this.outputChannel.appendLine(`[executeSvnCommand] 命令执行成功，输出长度: ${stdout.length} 字节`);
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
        await this.executeSvnCommand('info', fsPath);
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
          
          // 尝试在自定义SVN根目录下执行svn info命令
          try {
            await this.executeSvnCommand(`info "${relativePath}"`, this.getCustomSvnRoot()!);
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
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        await this.executeSvnCommand(`info "${fileName}"`, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
        }
      }
    }
    
    await this.executeSvnCommand(`add "${fileName}"`, cwd);
  }

  /**
   * 提交文件或文件夹
   * @param fsPath 文件系统路径
   * @param message 提交信息
   */
  public async commit(fsPath: string, message: string): Promise<void> {
    const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type === vscode.FileType.Directory;
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        await this.executeSvnCommand('info', fsPath);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
        if (!relativePath.startsWith('..')) {
          if (isDirectory) {
            await this.executeSvnCommand(`commit "${relativePath}" -m "${message}"`, this.getCustomSvnRoot()!);
            return;
          } else {
            await this.executeSvnCommand(`commit "${relativePath}" -m "${message}"`, this.getCustomSvnRoot()!);
            return;
          }
        }
      }
    }
    
    if (isDirectory) {
      await this.executeSvnCommand(`commit -m "${message}"`, fsPath);
    } else {
      const cwd = path.dirname(fsPath);
      const fileName = path.basename(fsPath);
      await this.executeSvnCommand(`commit "${fileName}" -m "${message}"`, cwd);
    }
  }

  /**
   * 更新工作副本
   * @param fsPath 文件系统路径
   */
  public async update(fsPath: string): Promise<void> {
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        await this.executeSvnCommand('info', fsPath);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
        if (!relativePath.startsWith('..')) {
          await this.executeSvnCommand(`update "${relativePath}"`, this.getCustomSvnRoot()!);
          return;
        }
      }
    }
    
    await this.executeSvnCommand('update', fsPath);
  }

  /**
   * 还原文件修改
   * @param filePath 文件路径
   */
  public async revertFile(filePath: string): Promise<void> {
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        await this.executeSvnCommand(`info "${fileName}"`, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
        }
      }
    }
    
    await this.executeSvnCommand(`revert "${fileName}"`, cwd);
  }

  /**
   * 获取文件日志
   * @param filePath 文件路径
   * @param limit 限制条数
   * @returns 日志信息
   */
  public async getLog(filePath: string, limit: number = 10): Promise<string> {
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        await this.executeSvnCommand(`info "${fileName}"`, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
        }
      }
    }
    
    return await this.executeSvnCommand(`log "${fileName}" -l ${limit}`, cwd);
  }
} 