import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { SvnFilterService } from './filterService';

const exec = promisify(cp.exec);
const fsExists = promisify(fs.exists);

interface SvnStatus {
  status: string;
  filePath: string;
}

/**
 * SVN服务类，负责执行SVN命令和管理SVN工作副本
 */
export class SvnService {
  // 存储自定义SVN工作副本路径
  private customSvnRoot: string | undefined;
  private outputChannel: vscode.OutputChannel;
  private filterService: SvnFilterService;
  private _workingCopyPath: string | undefined;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('SVN');
    this.filterService = new SvnFilterService();
  }

  /**
   * 获取编码配置
   * @returns 编码配置对象
   */
  private getEncodingConfig() {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    return {
      defaultFileEncoding: config.get<string>('defaultFileEncoding', 'auto'),
      forceUtf8Output: config.get<boolean>('forceUtf8Output', true),
      enableEncodingDetection: config.get<boolean>('enableEncodingDetection', true),
      encodingFallbacks: config.get<string[]>('encodingFallbacks', ['utf8', 'gbk', 'gb2312', 'big5']),
      showEncodingInfo: config.get<boolean>('showEncodingInfo', false)
    };
  }

  /**
   * 检测文件编码
   * @param filePath 文件路径
   * @returns 编码类型
   */
  private detectFileEncoding(filePath: string): string {
    const config = this.getEncodingConfig();
    
    // 如果禁用了编码检测，直接使用默认编码
    if (!config.enableEncodingDetection) {
      return config.defaultFileEncoding === 'auto' ? 'utf8' : config.defaultFileEncoding;
    }
    
    // 如果指定了非auto编码，直接使用
    if (config.defaultFileEncoding !== 'auto') {
      this.outputChannel.appendLine(`[detectFileEncoding] 使用配置的默认编码: ${config.defaultFileEncoding}`);
      return config.defaultFileEncoding;
    }

    try {
      const buffer = fs.readFileSync(filePath);
      
      // 检测BOM
      if (buffer.length >= 3) {
        if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
          return 'utf8-bom';
        }
      }
      
      if (buffer.length >= 2) {
        if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
          return 'utf16le';
        }
        if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
          return 'utf16be';
        }
      }
      
      // 尝试解析为UTF-8
      try {
        const text = buffer.toString('utf8');
        // 检查是否包含无效字符
        if (text.includes('\uFFFD')) {
          // 可能是其他编码，尝试检测
          return this.detectChineseEncoding(buffer);
        }
        return 'utf8';
      } catch {
        return this.detectChineseEncoding(buffer);
      }
    } catch (error) {
      this.outputChannel.appendLine(`[detectFileEncoding] 检测文件编码失败: ${error}`);
      return 'utf8'; // 默认使用UTF-8
    }
  }

  /**
   * 检测中文编码
   * @param buffer 文件缓冲区
   * @returns 编码类型
   */
  private detectChineseEncoding(buffer: Buffer): string {
    const config = this.getEncodingConfig();
    
    try {
      // 使用配置的备用编码列表
      const encodings = config.encodingFallbacks;
      
      for (const encoding of encodings) {
        try {
          // 使用iconv-lite库进行编码检测和转换（如果可用）
          const text = buffer.toString(encoding as BufferEncoding);
          
          // 检查是否包含常见中文字符
          const chineseRegex = /[\u4e00-\u9fff]/;
          if (chineseRegex.test(text) && !text.includes('\uFFFD')) {
            this.outputChannel.appendLine(`[detectChineseEncoding] 检测到编码: ${encoding}`);
            return encoding;
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(`[detectChineseEncoding] 编码检测失败: ${error}`);
    }
    
    return 'utf8'; // 默认返回UTF-8
  }

  /**
   * 转换文本编码为UTF-8
   * @param text 原始文本
   * @param sourceEncoding 源编码
   * @returns UTF-8编码的文本
   */
  private convertToUtf8(text: string, sourceEncoding: string): string {
    try {
      if (sourceEncoding === 'utf8' || sourceEncoding === 'utf8-bom') {
        return text;
      }
      
      // 对于非UTF-8编码，尝试重新编码
      const buffer = Buffer.from(text, sourceEncoding as BufferEncoding);
      return buffer.toString('utf8');
    } catch (error) {
      this.outputChannel.appendLine(`[convertToUtf8] 编码转换失败: ${error}`);
      return text; // 转换失败时返回原文本
    }
  }

  /**
   * 获取增强的环境变量配置
   * @returns 环境变量对象
   */
  private getEnhancedEnvironment(): NodeJS.ProcessEnv {
    const platform = os.platform();
    const baseEnv = { ...process.env };
    const config = this.getEncodingConfig();
    
    // 如果启用了强制UTF-8输出，设置相应的环境变量
    let utf8Env: Record<string, string> = {};
    
    if (config.forceUtf8Output) {
      // 基础UTF-8环境变量
      utf8Env = {
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
        LC_MESSAGES: 'en_US.UTF-8',
        LANGUAGE: 'en_US.UTF-8',
        SVN_EDITOR: 'echo'  // 避免交互式编辑器
      };
      
      // 根据平台添加特定配置
      if (platform === 'win32') {
        // Windows特定配置
        Object.assign(utf8Env, {
          PYTHONIOENCODING: 'utf-8',
          // 设置代码页为UTF-8
          CHCP: '65001'
        });
      } else if (platform === 'darwin') {
        // macOS特定配置
        Object.assign(utf8Env, {
          LC_COLLATE: 'en_US.UTF-8',
          LC_MONETARY: 'en_US.UTF-8',
          LC_NUMERIC: 'en_US.UTF-8',
          LC_TIME: 'en_US.UTF-8'
        });
      }
    } else {
      // 如果没有强制UTF-8输出，只设置基本的编辑器配置
      utf8Env = {
        SVN_EDITOR: 'echo'  // 避免交互式编辑器
      };
      
      this.outputChannel.appendLine(`[getEnhancedEnvironment] 强制UTF-8输出已禁用，使用系统默认编码`);
    }
    
    // 合并环境变量
    return Object.assign(baseEnv, utf8Env);
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
      
      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();
      
      this.outputChannel.appendLine(`[executeSvnCommand] 设置编码环境变量: LANG=${env.LANG}, LC_ALL=${env.LC_ALL}`);
      
      // 根据 useXml 参数决定是否添加 --xml 标志
      let xmlFlag = '';
      if (useXml) {
        xmlFlag = '--xml';
        this.outputChannel.appendLine(`[executeSvnCommand] 添加XML输出标志: ${xmlFlag}`);
      }
      
      // 对于diff命令，添加特殊处理以支持各种编码
      if (command.includes('diff')) {
        if (!command.includes('--force')) {
          command = `${command} --force`;
        }
        // 添加编码相关参数
        if (!command.includes('--internal-diff')) {
          command = `${command} --internal-diff`;
        }
        this.outputChannel.appendLine(`[executeSvnCommand] 为diff命令添加编码支持参数`);
      }
      
      // 对于log命令，确保使用UTF-8输出
      if (command.includes('log')) {
        if (!command.includes('--xml') && useXml) {
          // XML输出时已经包含编码信息
        }
      }
      
      // 记录最终命令
      const finalCommand = `svn ${command} ${xmlFlag}`.trim();
      this.outputChannel.appendLine(`[executeSvnCommand] 最终命令: ${finalCommand}`);
      
      // 执行命令
      this.outputChannel.appendLine(`[executeSvnCommand] 开始执行命令...`);
      return new Promise<string>((resolve, reject) => {
        const svnProcess = cp.exec(
          finalCommand, 
          { 
            cwd: path, 
            env,
            maxBuffer: 50 * 1024 * 1024, // 增加缓冲区大小到50MB
            encoding: 'utf8' as BufferEncoding  // 显式指定编码
          },
          (error, stdout, stderr) => {
            if (error) {
              this.outputChannel.appendLine(`[executeSvnCommand] 命令执行失败，错误码: ${error.code}`);
              if (stderr) {
                // 尝试编码转换
                const convertedStderr = this.processCommandOutput(stderr);
                this.outputChannel.appendLine(`[executeSvnCommand] 错误输出: ${convertedStderr}`);
                reject(new Error(`SVN错误: ${convertedStderr}`));
              } else {
                this.outputChannel.appendLine(`[executeSvnCommand] 错误信息: ${error.message}`);
                reject(error);
              }
            } else {
              // 处理输出编码
              const processedOutput = this.processCommandOutput(stdout);
              
              this.outputChannel.appendLine(`[executeSvnCommand] 命令执行成功，输出长度: ${processedOutput.length} 字节`);
              if (processedOutput.length < 1000) {
                this.outputChannel.appendLine(`[executeSvnCommand] 输出内容: ${processedOutput.replace(/\n/g, '\\n')}`);
              } else {
                this.outputChannel.appendLine(`[executeSvnCommand] 输出内容前1000个字符: ${processedOutput.substring(0, 1000).replace(/\n/g, '\\n')}...`);
              }
              resolve(processedOutput);
            }
          }
        );
        
        // 处理实时输出
        if (svnProcess.stdout) {
          svnProcess.stdout.on('data', (data) => {
            const processedData = this.processCommandOutput(data.toString());
            this.outputChannel.appendLine(`[executeSvnCommand] 命令输出: ${processedData.replace(/\n/g, '\\n')}`);
          });
        }
        
        if (svnProcess.stderr) {
          svnProcess.stderr.on('data', (data) => {
            const processedData = this.processCommandOutput(data.toString());
            this.outputChannel.appendLine(`[executeSvnCommand] 错误输出: ${processedData.replace(/\n/g, '\\n')}`);
          });
        }
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[executeSvnCommand] 捕获到异常: ${error.message}`);
      if (error.stderr) {
        const convertedStderr = this.processCommandOutput(error.stderr);
        this.outputChannel.appendLine(`[executeSvnCommand] 错误输出: ${convertedStderr}`);
        throw new Error(`SVN错误: ${convertedStderr}`);
      }
      throw error;
    }
  }

  /**
   * 处理命令输出的编码
   * @param output 原始输出
   * @returns 处理后的输出
   */
  private processCommandOutput(output: string): string {
    try {
      // 检查是否包含乱码字符
      if (output.includes('\uFFFD') || this.hasGarbledText(output)) {
        this.outputChannel.appendLine(`[processCommandOutput] 检测到可能的编码问题，尝试修复`);
        
        // 尝试不同的编码解析
        return this.fixEncodingIssues(output);
      }
      
      return output;
    } catch (error) {
      this.outputChannel.appendLine(`[processCommandOutput] 处理输出编码失败: ${error}`);
      return output; // 处理失败时返回原输出
    }
  }

  /**
   * 检测是否包含乱码文本
   * @param text 文本内容
   * @returns 是否包含乱码
   */
  private hasGarbledText(text: string): boolean {
    // 检测常见的乱码模式
    const garbledPatterns = [
      /[\u00C0-\u00FF]{2,}/,  // 连续的扩展ASCII字符
      /\?{2,}/,              // 连续的问号
      /\uFFFD/,              // 替换字符
      /[\u0080-\u00FF]{3,}/  // 连续的高位字符
    ];
    
    return garbledPatterns.some(pattern => pattern.test(text));
  }

  /**
   * 修复编码问题
   * @param text 有问题的文本
   * @returns 修复后的文本
   */
  private fixEncodingIssues(text: string): string {
    try {
      // 尝试将文本重新编码
      const buffer = Buffer.from(text, 'latin1');
      
      // 尝试不同的编码
      const encodings = ['utf8', 'gbk', 'gb2312', 'big5'];
      
      for (const encoding of encodings) {
        try {
          const decoded = buffer.toString(encoding as BufferEncoding);
          
          // 检查解码结果是否包含中文字符且没有乱码
          if (/[\u4e00-\u9fff]/.test(decoded) && !decoded.includes('\uFFFD')) {
            this.outputChannel.appendLine(`[fixEncodingIssues] 使用编码 ${encoding} 成功修复`);
            return decoded;
          }
        } catch {
          continue;
        }
      }
      
      // 如果所有编码都失败，返回原文本
      this.outputChannel.appendLine(`[fixEncodingIssues] 无法修复编码问题，返回原文本`);
      return text;
    } catch (error) {
      this.outputChannel.appendLine(`[fixEncodingIssues] 修复编码失败: ${error}`);
      return text;
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
