import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { SvnFilterService } from './filterService';
import { SvnAuthService } from './svnAuthService';
import { SvnAuthDialog } from './svnAuthDialog';

const exec = promisify(cp.exec);
const fsExists = promisify(fs.exists);
const lstat = promisify(fs.lstat); // 用于检查路径是文件还是目录

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
  // 存储自动检测到的工作区文件夹与其对应的SVN根目录的映射
  private detectedSvnRoots: Map<string, string> = new Map();
  private outputChannel: vscode.OutputChannel;
  private filterService: SvnFilterService;
  private authService: SvnAuthService | undefined;
  private context: vscode.ExtensionContext | undefined; // 添加context存储

  constructor(context?: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('SVN');
    this.filterService = new SvnFilterService();
    if (context) {
      this.context = context; // 存储context
      this.authService = new SvnAuthService(context);
      // 在构造函数中触发自动检测
      this.initializeSvnRoots();
    }
    // 监听工作区文件夹变化，以便重新检测
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.initializeSvnRoots());
  }

  /**
   * 初始化时自动检测所有工作区文件夹的SVN根目录
   */
  private async initializeSvnRoots(): Promise<void> {
    this.detectedSvnRoots.clear(); // 清空旧的检测结果
    this.outputChannel.appendLine('[initializeSvnRoots] 开始自动检测SVN工作副本根目录...');
    if (vscode.workspace.workspaceFolders) {
      for (const folder of vscode.workspace.workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        try {
          const svnRoot = await this._detectSvnRoot(folderPath);
          if (svnRoot) {
            this.detectedSvnRoots.set(folderPath, svnRoot);
            this.outputChannel.appendLine(`[initializeSvnRoots] 检测到 ${folderPath} 的SVN根目录: ${svnRoot}`);
          } else {
            this.outputChannel.appendLine(`[initializeSvnRoots] ${folderPath} 不是有效的SVN工作副本`);
          }
        } catch (error: any) {
          this.outputChannel.appendLine(`[initializeSvnRoots] 检测 ${folderPath} 时出错: ${error.message}`);
        }
      }
    } else {
      this.outputChannel.appendLine('[initializeSvnRoots] 没有打开的工作区文件夹');
    }
    this.outputChannel.appendLine('[initializeSvnRoots] SVN根目录自动检测完成');
  }

  /**
   * 尝试检测给定路径的SVN工作副本根目录
   * @param targetPath 目标路径（文件或目录）
   * @returns SVN根目录路径或null
   */
  private async _detectSvnRoot(targetPath: string): Promise<string | null> {
    try {
      // 确保目标路径存在
       if (!await fsExists(targetPath)) {
           this.outputChannel.appendLine(`[_detectSvnRoot] 路径不存在: ${targetPath}`);
           return null;
       }

      // 如果是文件路径，获取其所在目录
      let directoryPath = targetPath;
      try {
        const stats = await lstat(targetPath);
        if (!stats.isDirectory()) {
            directoryPath = path.dirname(targetPath);
        }
      } catch (statError) {
          this.outputChannel.appendLine(`[_detectSvnRoot] 获取路径信息失败: ${statError}`);
          return null; // 如果无法获取路径信息，则无法检测
      }


      this.outputChannel.appendLine(`[_detectSvnRoot] 尝试在目录 ${directoryPath} 中执行 'svn info'`);
      // 使用 _executeCommand 执行 svn info，明确指定工作目录为目录路径
      const infoOutput = await this._executeCommand('info', directoryPath, false); // 不强制XML，避免解析问题

      // 解析输出以查找 Working Copy Root Path
      const rootPathMatch = infoOutput.match(/^Working Copy Root Path:\s*(.*)$/m);
      if (rootPathMatch && rootPathMatch[1]) {
        const svnRoot = rootPathMatch[1].trim();
        this.outputChannel.appendLine(`[_detectSvnRoot] 从 'svn info' 输出中解析到根目录: ${svnRoot}`);
        return svnRoot;
      } else {
        this.outputChannel.appendLine(`[_detectSvnRoot] 未在 'svn info' 输出中找到 Working Copy Root Path`);
        return null; // 不是有效的 SVN 工作副本或无法解析
      }
    } catch (error: any) {
      // 如果 svn info 命令失败，说明当前目录或其父目录不是有效的 SVN 工作副本的一部分
      this.outputChannel.appendLine(`[_detectSvnRoot] 执行 'svn info' 失败，可能不是SVN工作副本: ${error.message}`);
      return null;
    }
  }


  /**
   * 获取给定文件路径对应的最有效的SVN工作副本根目录
   * 优先顺序：用户自定义 > 自动检测 > 文件所在目录 (作为最后手段)
   * @param forPath 文件或目录路径
   * @returns 有效的SVN工作目录路径
   */
  private async getEffectiveSvnRoot(forPath: string): Promise<string> {
    // 1. 检查用户自定义的根目录
    const customRoot = this.getCustomSvnRoot();
    if (customRoot) {
      // 验证自定义根目录是否包含目标路径
      const relativePath = path.relative(customRoot, forPath);
      if (!relativePath.startsWith('..')) {
        this.outputChannel.appendLine(`[getEffectiveSvnRoot] 使用用户自定义的SVN根目录: ${customRoot}`);
        return customRoot;
      } else {
        this.outputChannel.appendLine(`[getEffectiveSvnRoot] 警告: 目标路径 ${forPath} 不在用户自定义的根目录 ${customRoot} 下`);
        // 继续尝试自动检测
      }
    }

    // 2. 查找与目标路径最匹配的自动检测到的根目录
    let bestMatchRoot: string | undefined;
    let longestMatchLength = -1;

    for (const [folderPath, svnRoot] of this.detectedSvnRoots.entries()) {
      const relativePath = path.relative(svnRoot, forPath);
      // 检查 forPath 是否在 svnRoot 目录下，并且 svnRoot 是当前最长的匹配前缀
      if (!relativePath.startsWith('..') && svnRoot.length > longestMatchLength) {
         // 进一步验证 svnRoot 是否真的是 forPath 的根目录或其父目录的根
         if (forPath.startsWith(svnRoot)) {
            bestMatchRoot = svnRoot;
            longestMatchLength = svnRoot.length;
         }
      }
    }

    if (bestMatchRoot) {
      this.outputChannel.appendLine(`[getEffectiveSvnRoot] 使用自动检测到的SVN根目录: ${bestMatchRoot}`);
      return bestMatchRoot;
    }

    // 3. 如果没有找到匹配的自动检测根，尝试为当前路径动态检测一次
     this.outputChannel.appendLine(`[getEffectiveSvnRoot] 未找到匹配的缓存根目录，尝试动态检测路径: ${forPath}`);
     const dynamicallyDetectedRoot = await this._detectSvnRoot(forPath);
     if (dynamicallyDetectedRoot) {
         // 将动态检测结果添加到缓存（如果适用）
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(forPath));
          if (workspaceFolder && !this.detectedSvnRoots.has(workspaceFolder.uri.fsPath)) {
              this.detectedSvnRoots.set(workspaceFolder.uri.fsPath, dynamicallyDetectedRoot);
              this.outputChannel.appendLine(`[getEffectiveSvnRoot] 动态检测成功并缓存: ${dynamicallyDetectedRoot}`);
          } else {
               this.outputChannel.appendLine(`[getEffectiveSvnRoot] 动态检测成功: ${dynamicallyDetectedRoot}`);
          }
         return dynamicallyDetectedRoot;
     }

    // --- 不推荐回退到 dirname ---
    // 4. 作为最后的手段（谨慎使用），回退到文件所在的目录
    // this.outputChannel.appendLine(`[getEffectiveSvnRoot] 未找到SVN根目录，回退到文件所在目录: ${path.dirname(forPath)}`);
    // return path.dirname(forPath);
    // --- 更好的做法是抛出错误或返回明确的失败指示 ---
    this.outputChannel.appendLine(`[getEffectiveSvnRoot] 无法确定 ${forPath} 的有效SVN工作目录`);
    // 尝试返回最接近的工作区文件夹路径，如果存在
     const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(forPath));
     if (workspaceFolder) {
         this.outputChannel.appendLine(`[getEffectiveSvnRoot] 回退到工作区文件夹路径: ${workspaceFolder.uri.fsPath}`);
         return workspaceFolder.uri.fsPath;
     }
    // 如果连工作区都没有，只能用父目录了（但很可能出错）
    const parentDir = path.dirname(forPath);
    this.outputChannel.appendLine(`[getEffectiveSvnRoot] 最终回退到父目录: ${parentDir}`);
    return parentDir;
  }

  // --- 省略 getEncodingConfig, detectFileEncoding, detectChineseEncoding, convertToUtf8, getEnhancedEnvironment ---
  // 这些方法保持不变

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
   * 执行SVN命令（外部调用接口）
   * @param command SVN命令 (例如: "status", "info file.txt")
   * @param targetPath 目标文件或目录路径
   * @param useXml 是否使用XML输出
   * @returns 命令执行结果
   */
  public async executeSvnCommand(command: string, targetPath: string, useXml: boolean = false): Promise<string> {
    // 自动确定最合适的工作目录 (cwd)
    const effectiveSvnRoot = await this.getEffectiveSvnRoot(targetPath);
    this.outputChannel.appendLine(`[executeSvnCommand] 目标路径: ${targetPath}`);
    this.outputChannel.appendLine(`[executeSvnCommand] 确定的有效工作目录 (cwd): ${effectiveSvnRoot}`);

    // 对于需要文件/目录参数的命令，需要处理路径相对于 cwd
    // 注意: 这里的 'command' 是类似 "status file.txt" 或 "info" 这样的字符串
    // 我们需要智能地处理 targetPath，将其转换为相对于 effectiveSvnRoot 的路径（如果命令需要）
    // 或者，对于某些命令（如 info），可以直接使用绝对路径 targetPath

    // 示例：重构命令字符串以包含相对于根目录的路径（如果需要）
    // 这取决于具体的SVN命令以及 targetPath 是文件还是目录
    // 简化处理：大多数命令在正确的 cwd 下可以直接使用绝对路径 targetPath
    // 但像 'status file.txt' 这种，最好在 cwd 下使用相对路径或文件名

    let adjustedCommand = command; // 默认使用原始命令
    let commandTargetPath = targetPath; // 默认目标路径

     // 如果 targetPath 在 effectiveSvnRoot 内部，并且命令似乎需要相对路径
     if (targetPath.startsWith(effectiveSvnRoot) && command.includes(path.basename(targetPath))) {
         const relativePath = path.relative(effectiveSvnRoot, targetPath);
          // 替换命令中的绝对路径或简单文件名为相对路径（需要更复杂的逻辑来安全地执行此操作）
          // 简单的替换可能不安全，暂时注释掉
         // adjustedCommand = command.replace(targetPath, `"${relativePath}"`).replace(path.basename(targetPath), `"${relativePath}"`);
         // commandTargetPath = relativePath; // 更新目标路径为相对路径
         this.outputChannel.appendLine(`[executeSvnCommand] 目标路径相对于工作目录: ${relativePath}`);
     }

     // 对 targetPath 进行转义（特别是@符号），如果它将作为命令的一部分
      let escapedTargetPath = targetPath;
      if (escapedTargetPath.includes('@')) {
          // 检查是否已经是文件路径（而不是目录）
           try {
               const stats = await lstat(targetPath);
               if (!stats.isDirectory()) {
                   escapedTargetPath = `${targetPath}@`;
                   this.outputChannel.appendLine(`[executeSvnCommand] 对文件路径中的@进行转义: ${escapedTargetPath}`);
               }
           } catch (e) {
               // 如果无法获取状态，保守地添加@
                escapedTargetPath = `${targetPath}@`;
                this.outputChannel.appendLine(`[executeSvnCommand] 无法获取路径状态，对路径中的@进行转义: ${escapedTargetPath}`);
           }

          // 更新命令字符串中的路径（如果存在） - 同样需要小心处理
          // adjustedCommand = adjustedCommand.replace(targetPath, escapedTargetPath);
      }


    // --- 重点：传递正确的 cwd ---
    return this.executeSvnCommandWithAuth(command, effectiveSvnRoot, useXml); // cwd 始终是目录
  }

  /**
   * 执行SVN命令（支持认证重试）
   * @param command SVN命令主体 (例如: "status", "info file.txt")
   * @param cwd 工作目录 (必须是目录)
   * @param useXml 是否使用XML输出
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 命令执行结果
   */
  private async executeSvnCommandWithAuth(
    command: string,
    cwd: string, // cwd 现在是明确的目录路径
    useXml: boolean = false,
    username?: string,
    password?: string
  ): Promise<string> {
    // 确保 cwd 是目录
     try {
         const stats = await lstat(cwd);
         if (!stats.isDirectory()) {
             throw new Error(`内部错误: cwd 必须是一个目录，但收到了: ${cwd}`);
         }
     } catch (statError) {
          throw new Error(`内部错误: 无法访问 cwd 目录: ${cwd}, 错误: ${statError}`);
     }


    try {
      this.outputChannel.appendLine(`\n[executeSvnCommandWithAuth] 执行SVN命令: svn ${command}`);
      this.outputChannel.appendLine(`[executeSvnCommandWithAuth] 工作目录 (cwd): ${cwd}`); // 使用传入的 cwd

      // 步骤1: 首先尝试系统默认认证
      if (!username && !password) {
        try {
          return await this._executeCommand(command, cwd, useXml); // 使用传入的 cwd
        } catch (error: any) {
          // 检查是否是认证失败
          if (this._isAuthenticationError(error)) {
            this.outputChannel.appendLine(`[executeSvnCommandWithAuth] 系统默认认证失败，尝试获取保存的认证信息`);

            // 步骤2: 尝试使用保存的认证信息
            if (this.authService) {
              const repoUrl = await this.authService.getRepositoryRootUrl(cwd); // 使用 cwd 获取仓库 URL
              if (repoUrl) {
                const savedCredential = await this.authService.getCredential(repoUrl);
                if (savedCredential) {
                  this.outputChannel.appendLine(`[executeSvnCommandWithAuth] 找到保存的认证信息，用户名: ${savedCredential.username}`);
                  try {
                    const result = await this._executeCommand(command, cwd, useXml, savedCredential.username, savedCredential.password); // 使用传入的 cwd
                    // 更新最后使用时间
                    await this.authService.updateLastUsed(repoUrl);
                    return result;
                  } catch (authError: any) {
                    if (this._isAuthenticationError(authError)) {
                      this.outputChannel.appendLine(`[executeSvnCommandWithAuth] 保存的认证信息已失效，需要重新输入`);
                      // 删除失效的认证信息
                      await this.authService.removeCredential(repoUrl);
                    } else {
                      throw authError; // 不是认证错误，直接抛出
                    }
                  }
                }
              }

              // 步骤3: 提示用户输入认证信息
              if (this.authService.getDefaultAuthPrompt()) {
                const authResult = await SvnAuthDialog.showAuthDialog(repoUrl || cwd); // 使用 cwd 作为备选 URL
                if (authResult) {
                  try {
                    const result = await this._executeCommand(command, cwd, useXml, authResult.username, authResult.password); // 使用传入的 cwd

                    // 保存认证信息（如果用户选择保存）
                    if (authResult.saveCredentials && repoUrl && this.authService.getAutoSaveCredentials()) {
                      await this.authService.saveCredential(repoUrl, authResult.username, authResult.password);
                      SvnAuthDialog.showAuthSuccessMessage(repoUrl, authResult.username, true);
                    } else {
                      SvnAuthDialog.showAuthSuccessMessage(repoUrl || cwd, authResult.username, false);
                    }

                    return result;
                  } catch (finalError: any) {
                    if (this._isAuthenticationError(finalError)) {
                      SvnAuthDialog.showAuthFailureMessage(repoUrl || cwd, '用户名或密码错误');
                    }
                    throw finalError;
                  }
                } else {
                  throw new Error('用户取消了认证操作');
                }
              }
            }
          }
          throw error; // 不是认证错误或无法处理，直接抛出原错误
        }
      } else {
        // 如果已经提供了用户名密码，直接使用
        return await this._executeCommand(command, cwd, useXml, username, password); // 使用传入的 cwd
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[executeSvnCommandWithAuth] 捕获到异常: ${error.message}`);
      throw error;
    }
  }


  /**
   * 实际执行SVN命令的内部方法
   * @param command SVN命令主体
   * @param cwd 工作目录 (必须是目录)
   * @param useXml 是否使用XML输出
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 命令执行结果
   */
  private async _executeCommand(
    command: string,
    cwd: string, // 明确 cwd 是目录
    useXml: boolean = false,
    username?: string,
    password?: string
  ): Promise<string> {
    // 获取增强的环境变量配置
    const env = this.getEnhancedEnvironment();

    this.outputChannel.appendLine(`[_executeCommand] 设置编码环境变量: LANG=${env.LANG}, LC_ALL=${env.LC_ALL}`);

    // 根据 useXml 参数决定是否添加 --xml 标志
    let xmlFlag = '';
    if (useXml) {
      xmlFlag = '--xml';
      this.outputChannel.appendLine(`[_executeCommand] 添加XML输出标志: ${xmlFlag}`);
    }

    // 对于diff命令，添加特殊处理以支持各种编码
    if (command.startsWith('diff')) { // 检查命令是否以 'diff' 开头
      if (!command.includes('--force')) {
        command = `${command} --force`;
      }
      // 添加编码相关参数
      if (!command.includes('--internal-diff')) {
        command = `${command} --internal-diff`;
      }
      this.outputChannel.appendLine(`[_executeCommand] 为diff命令添加编码支持参数`);
    }

    // 构建完整命令，包含认证信息
    let finalCommand = `svn ${command} ${xmlFlag}`.trim();
    if (username && password) {
      finalCommand += ` --username "${username}" --password "${password}" --non-interactive --trust-server-cert`;
      this.outputChannel.appendLine(`[_executeCommand] 使用认证信息，用户名: ${username}`);
    }

    this.outputChannel.appendLine(`[_executeCommand] 最终命令: ${finalCommand.replace(/ --password "[^"]*"/, ' --password "***"')}`);

    // 执行命令
    this.outputChannel.appendLine(`[_executeCommand] 开始执行命令 (cwd: ${cwd})...`); // 明确 cwd
    return new Promise<string>((resolve, reject) => {
      const svnProcess = cp.exec(
        finalCommand,
        {
          cwd: cwd, // 使用传入的目录路径
          env,
          maxBuffer: 50 * 1024 * 1024, // 增加缓冲区大小到50MB
          encoding: 'utf8' as BufferEncoding  // 显式指定编码
        },
        (error, stdout, stderr) => {
          if (error) {
            this.outputChannel.appendLine(`[_executeCommand] 命令执行失败，错误码: ${error.code}`);
             // 检查是否是 ENOTDIR 错误
            if (error.message.includes('ENOTDIR')) {
                const specificError = new Error(`SVN命令执行失败: 工作目录(cwd)无效或不是目录: ${cwd}. 错误详情: ${error.message}`);
                this.outputChannel.appendLine(`[_executeCommand] 错误输出: ${specificError.message}`);
                reject(specificError);
                return; // 结束回调
            }
            if (stderr) {
              // 尝试编码转换
              const convertedStderr = this.processCommandOutput(stderr);
              this.outputChannel.appendLine(`[_executeCommand] 错误输出: ${convertedStderr}`);
              reject(new Error(`SVN错误: ${convertedStderr}`));
            } else {
              this.outputChannel.appendLine(`[_executeCommand] 错误信息: ${error.message}`);
              reject(error);
            }
          } else {
            // 处理输出编码
            const processedOutput = this.processCommandOutput(stdout);

            this.outputChannel.appendLine(`[_executeCommand] 命令执行成功，输出长度: ${processedOutput.length} 字节`);
            if (processedOutput.length < 1000) {
              this.outputChannel.appendLine(`[_executeCommand] 输出内容: ${processedOutput.replace(/\n/g, '\\n')}`);
            } else {
              this.outputChannel.appendLine(`[_executeCommand] 输出内容前1000个字符: ${processedOutput.substring(0, 1000).replace(/\n/g, '\\n')}...`);
            }
            resolve(processedOutput);
          }
        }
      );

      // 处理实时输出
      if (svnProcess.stdout) {
        svnProcess.stdout.on('data', (data) => {
          const processedData = this.processCommandOutput(data.toString());
          this.outputChannel.appendLine(`[_executeCommand] 命令输出: ${processedData.replace(/\n/g, '\\n')}`);
        });
      }

      if (svnProcess.stderr) {
        svnProcess.stderr.on('data', (data) => {
          const processedData = this.processCommandOutput(data.toString());
          this.outputChannel.appendLine(`[_executeCommand] 错误输出: ${processedData.replace(/\n/g, '\\n')}`);
        });
      }
    });
  }


  // --- 省略 _isAuthenticationError, processCommandOutput, hasGarbledText, fixEncodingIssues, isSvnInstalled ---
  // 这些方法保持不变
    /**
   * 检查是否是认证失败错误
   */
  private _isAuthenticationError(error: any): boolean {
    const errorMessage = error.message || error.toString();
    return errorMessage.includes('E170001') ||
           errorMessage.includes('Authentication failed') ||
           errorMessage.includes('authentication failed') ||
           errorMessage.includes('认证失败') ||
           errorMessage.includes('用户名或密码') ||
           errorMessage.includes('Authorization failed');
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
      // 使用 _executeCommand 并指定一个有效的目录作为 cwd
       const cwd = os.homedir(); // 使用用户主目录作为安全的 cwd
      await this._executeCommand('--version', cwd); // 不需要路径，但需要cwd
      return true;
    } catch (error) {
         this.outputChannel.appendLine(`[isSvnInstalled] 检查SVN安装失败: ${error}`);
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
        this.outputChannel.appendLine(`[setCustomSvnRoot] 路径不存在: ${svnRootPath}`);
      return false;
    }

    // 检查是否是目录
     try {
         const stats = await lstat(svnRootPath);
         if (!stats.isDirectory()) {
             this.outputChannel.appendLine(`[setCustomSvnRoot] 提供的路径不是一个目录: ${svnRootPath}`);
             return false;
         }
     } catch (statError) {
         this.outputChannel.appendLine(`[setCustomSvnRoot] 无法访问路径: ${svnRootPath}, 错误: ${statError}`);
         return false;
     }

    // 检查是否包含.svn目录 (或者通过svn info验证)
    // const svnDirPath = path.join(svnRootPath, '.svn');
    // if (!await fsExists(svnDirPath)) {
    //   return false;
    // }
     try {
         await this._executeCommand('info', svnRootPath); // 在 svnRootPath 下执行 info
         this.outputChannel.appendLine(`[setCustomSvnRoot] 路径 ${svnRootPath} 是有效的SVN工作副本`);
     } catch (error) {
         this.outputChannel.appendLine(`[setCustomSvnRoot] 路径 ${svnRootPath} 不是有效的SVN工作副本`);
         return false;
     }

    // 设置自定义SVN工作副本路径
    this.customSvnRoot = svnRootPath;

    // 保存到配置中，以便在会话之间保持
    try {
        await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', svnRootPath, vscode.ConfigurationTarget.Workspace);
        this.outputChannel.appendLine(`[setCustomSvnRoot] 已将自定义SVN根目录保存到工作区设置: ${svnRootPath}`);
         // 更新自动检测缓存（如果适用）
         const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(svnRootPath));
         if (workspaceFolder && workspaceFolder.uri.fsPath === svnRootPath) {
             this.detectedSvnRoots.set(svnRootPath, svnRootPath); // 自定义根也是有效的SVN根
         }
    } catch (configError) {
        this.outputChannel.appendLine(`[setCustomSvnRoot] 保存配置失败: ${configError}`);
        // 即使保存失败，内存中的设置仍然生效
    }

    return true;
  }

  // --- 省略 getCustomSvnRoot, clearCustomSvnRoot ---
  // 保持不变
    /**
   * 获取自定义SVN工作副本路径
   * @returns SVN工作副本根目录路径
   */
  public getCustomSvnRoot(): string | undefined {
    if (!this.customSvnRoot) {
      // 从配置中读取
      this.customSvnRoot = vscode.workspace.getConfiguration('vscode-svn').get<string>('customSvnRoot') || undefined;
       if (this.customSvnRoot) {
           this.outputChannel.appendLine(`[getCustomSvnRoot] 从配置中加载自定义根目录: ${this.customSvnRoot}`);
       }
    }
    return this.customSvnRoot;
  }

  /**
   * 清除自定义SVN工作副本路径
   */
  public async clearCustomSvnRoot(): Promise<void> {
    this.customSvnRoot = undefined;
    try {
        await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', undefined, vscode.ConfigurationTarget.Workspace);
        this.outputChannel.appendLine(`[clearCustomSvnRoot] 已清除工作区设置中的自定义SVN根目录`);
    } catch (configError) {
         this.outputChannel.appendLine(`[clearCustomSvnRoot] 清除配置失败: ${configError}`);
    }
  }


  /**
   * 检查路径是否在有效的SVN工作副本中
   * @param fsPath 文件系统路径
   * @returns 是否在SVN工作副本中
   */
  public async isInWorkingCopy(fsPath: string): Promise<boolean> {
    try {
      this.outputChannel.appendLine(`[isInWorkingCopy] 检查路径: ${fsPath}`);
      // 使用 getEffectiveSvnRoot 来找到对应的 SVN 根目录
      const effectiveRoot = await this.getEffectiveSvnRoot(fsPath);

      // 再次执行 svn info 来确认 fsPath 确实在 SVN 控制下
      // 需要构建正确的命令，可能需要相对路径
        let commandTarget = fsPath;
        if (fsPath.startsWith(effectiveRoot)) {
            commandTarget = path.relative(effectiveRoot, fsPath) || '.'; // 如果就是根目录，用 '.'
        }

        // 转义 @ 符号
        if (commandTarget.includes('@')) {
             try {
               const stats = await lstat(fsPath);
               if (!stats.isDirectory()) {
                    commandTarget = `${commandTarget}@`;
               }
           } catch {
                // 如果无法获取状态，保守地添加@
                 commandTarget = `${commandTarget}@`;
           }
        }


      this.outputChannel.appendLine(`[isInWorkingCopy] 使用有效根目录 ${effectiveRoot} 检查目标: ${commandTarget}`);
      await this._executeCommand(`info "${commandTarget}"`, effectiveRoot); // 在有效根目录下执行 info
      this.outputChannel.appendLine(`[isInWorkingCopy] 路径 ${fsPath} 在SVN工作副本中`);
      return true;
    } catch (error) {
      this.outputChannel.appendLine(`[isInWorkingCopy] 路径 ${fsPath} 不在SVN工作副本中或检查出错: ${error}`);
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
        this.outputChannel.appendLine(`\n[getFileStatus] 获取文件状态: ${filePath}`);
        const effectiveSvnRoot = await this.getEffectiveSvnRoot(filePath);
        this.outputChannel.appendLine(`[getFileStatus] 有效SVN根目录: ${effectiveSvnRoot}`);

        let commandTarget = filePath;
        // 如果文件路径在有效根目录下，计算相对路径
        if (filePath.startsWith(effectiveSvnRoot)) {
            commandTarget = path.relative(effectiveSvnRoot, filePath);
            // 如果是根目录本身，使用 '.'
            if (commandTarget === '') {
                commandTarget = '.';
            }
        }
         this.outputChannel.appendLine(`[getFileStatus] 计算出的命令目标: ${commandTarget}`);

         // 对 commandTarget 进行 @ 符号转义（仅对文件）
         let escapedCommandTarget = commandTarget;
          if (commandTarget.includes('@')) {
             try {
                 const stats = await lstat(filePath); // 检查原始路径是文件还是目录
                 if (!stats.isDirectory()) {
                      escapedCommandTarget = `${commandTarget}@`;
                      this.outputChannel.appendLine(`[getFileStatus] 对文件目标进行@转义: ${escapedCommandTarget}`);
                 }
             } catch (e) {
                 // 如果无法获取状态，可能文件已删除，保守地添加@
                 escapedCommandTarget = `${commandTarget}@`;
                  this.outputChannel.appendLine(`[getFileStatus] 无法获取路径状态，对目标进行@转义: ${escapedCommandTarget}`);
             }
         }


        this.outputChannel.appendLine(`[getFileStatus] 将在目录 ${effectiveSvnRoot} 中执行 status "${escapedCommandTarget}"`);
        // 在有效根目录下执行 status 命令，目标是相对路径或绝对路径（取决于上面的计算）
        // 添加 --xml 参数获取更可靠的输出
        const result = await this._executeCommand(`status --xml "${escapedCommandTarget}"`, effectiveSvnRoot, true);
        this.outputChannel.appendLine(`[getFileStatus] 状态结果 (XML): ${result.substring(0, 200).replace(/\n/g, '\\n')}...`);
        return this.parseStatusXml(result, filePath); // 使用XML解析
    } catch (error: any) {
        // 如果 XML status 失败（可能是 SVN 版本不支持 XML 输出或路径问题），尝试普通 status
        this.outputChannel.appendLine(`[getFileStatus] XML status 失败: ${error.message}，尝试普通 status`);
         try {
             const effectiveSvnRoot = await this.getEffectiveSvnRoot(filePath);
             let commandTarget = filePath;
              if (filePath.startsWith(effectiveSvnRoot)) {
                  commandTarget = path.relative(effectiveSvnRoot, filePath) || '.';
              }
               let escapedCommandTarget = commandTarget;
                if (commandTarget.includes('@')) {
                   try {
                       const stats = await lstat(filePath);
                       if (!stats.isDirectory()) {
                            escapedCommandTarget = `${commandTarget}@`;
                       }
                   } catch { escapedCommandTarget = `${commandTarget}@`;}
               }

              const plainResult = await this._executeCommand(`status "${escapedCommandTarget}"`, effectiveSvnRoot);
               this.outputChannel.appendLine(`[getFileStatus] 普通状态结果: ${plainResult.substring(0, 100).replace(/\n/g, '\\n')}`);
               return this.parseStatusCode(plainResult); // 使用旧的解析方法
         } catch (fallbackError: any) {
              this.outputChannel.appendLine(`[getFileStatus] 普通 status 也失败: ${fallbackError.message}`);
              return '未知状态';
         }
    }
  }

  /**
   * 解析SVN status --xml的输出
   * @param statusXml XML输出字符串
   * @param originalFilePath 原始请求的文件路径（用于匹配）
   * @returns 状态描述
   */
  private parseStatusXml(statusXml: string, originalFilePath: string): string {
    this.outputChannel.appendLine(`[parseStatusXml] 开始解析XML状态...`);
    try {
      // 查找与原始文件路径最匹配的 <entry>
      const entryRegex = /<entry\s+path="([^"]+)">[\s\S]*?<wc-status\s+item="([^"]+)"/g;
      let match;
      let bestMatchStatus: string | null = null;
      let longestMatchLength = -1;

      while ((match = entryRegex.exec(statusXml)) !== null) {
        const entryPath = match[1];
        const itemStatus = match[2];

        // 检查 entryPath 是否与 originalFilePath 匹配或为其父目录
        if (originalFilePath.endsWith(entryPath) || originalFilePath === entryPath) {
             // 找到更精确或同样精确的匹配
            if (entryPath.length >= longestMatchLength) {
                bestMatchStatus = itemStatus;
                longestMatchLength = entryPath.length;
                 this.outputChannel.appendLine(`[parseStatusXml] 找到匹配 entry: path="${entryPath}", status="${itemStatus}"`);
            }
        }
      }

      if (bestMatchStatus) {
        this.outputChannel.appendLine(`[parseStatusXml] 最匹配的状态码: ${bestMatchStatus}`);
        switch (bestMatchStatus) {
          case 'modified': return '已修改';
          case 'added': return '已添加';
          case 'deleted': return '已删除';
          case 'replaced': return '已替换';
          case 'conflicted': return '冲突';
          case 'unversioned': return '未版本控制';
          case 'missing': return '丢失';
          case 'ignored': return '已忽略';
          case 'obstructed': return '类型变更';
          case 'normal': return '无修改'; // 添加 normal 状态
          default: return `未知状态(${bestMatchStatus})`;
        }
      } else {
         this.outputChannel.appendLine(`[parseStatusXml] 未在XML中找到与 ${originalFilePath} 匹配的 entry`);
          // 如果XML中没有找到对应的 entry，可能是文件本身没有状态变化（normal）或完全不在版本控制下
          // 尝试查找 <target> 下的 <entry> 的 wc-status （针对目录本身的状态）
          const targetEntryRegex = /<target[^>]*>[\s\S]*?<entry[^>]*>[\s\S]*?<wc-status\s+item="([^"]+)"/;
          const targetMatch = statusXml.match(targetEntryRegex);
           if (targetMatch && targetMatch[1] === 'normal') {
               this.outputChannel.appendLine(`[parseStatusXml] 目标路径状态为 normal`);
               return '无修改';
           }
            // 如果连 target 状态都没有或不是 normal，很可能是未版本控制
            // 但 status --xml 对 unversioned 文件不会生成 entry，需要 fallback
             this.outputChannel.appendLine(`[parseStatusXml] XML解析未找到状态，可能为 normal 或 unversioned，需要进一步确认或 fallback`);
            // 这里可以返回一个特殊值或触发 fallback 到普通 status
             return '无修改'; // 默认为无修改，让后续逻辑决定
      }
    } catch (error) {
      this.outputChannel.appendLine(`[parseStatusXml] 解析XML失败: ${error}`);
      return '未知状态'; // 解析失败返回未知
    }
  }


  // --- 省略 parseStatusCode, addFile, removeFile, showOutputChannel, commit, update, revertFile, revertFolder, getLog, commitFiles, isOutOfDateError, handleOutOfDateError, testConnection, getRepositoryFileCount, checkout ---
  // 这些方法需要检查并确保它们调用 executeSvnCommand 时传递正确的 targetPath 和 useXml 参数
  // 并且处理 executeSvnCommand 可能因 cwd 问题而抛出的错误。
  // 注意：大部分命令已经在使用 executeSvnCommand，并且逻辑中包含了基于 customSvnRoot 的 cwd 处理，
  // 新的 getEffectiveSvnRoot 应该能替换掉这些分散的逻辑，使代码更清晰。
  // 需要仔细审查每个方法的 cwd 逻辑，并统一使用 getEffectiveSvnRoot。

    /**
   * 解析SVN状态码 (旧方法，用于 fallback)
   * @param statusResult SVN状态命令结果
   * @returns 状态描述
   */
    private parseStatusCode(statusResult: string): string {
      this.outputChannel.appendLine(`[parseStatusCode] 解析普通状态码: ${statusResult.substring(0, 100).replace(/\n/g, '\\n')}`);

      if (statusResult.trim() === '') {
        return '无修改';
      }
       // 改进：检查是否有任何状态行
        const statusLines = statusResult.trim().split('\n').filter(line => line.length > 0 && /^[ACDIMR?!~X]/.test(line[0]));

        if (statusLines.length === 0) {
             this.outputChannel.appendLine(`[parseStatusCode] 没有找到状态行，假定为 '无修改'`);
            return '无修改';
        }

       // 取第一行的状态码（或最相关的状态码，但这比较复杂）
       const firstLine = statusLines[0].trim();
      const statusCode = firstLine.charAt(0);
      this.outputChannel.appendLine(`[parseStatusCode] 使用第一个状态行的首字符作为状态码: ${statusCode}`);

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

        this.outputChannel.appendLine(`\n[addFile] 添加文件: ${filePath}`);
        const effectiveSvnRoot = await this.getEffectiveSvnRoot(filePath);
        let commandTarget = path.relative(effectiveSvnRoot, filePath);
         if (commandTarget === '') commandTarget = '.'; // 如果是根目录本身

        // 转义@
        let escapedCommandTarget = commandTarget;
        if (commandTarget.includes('@')) {
            escapedCommandTarget = `${commandTarget}@`;
        }

        this.outputChannel.appendLine(`[addFile] 有效根目录: ${effectiveSvnRoot}, 目标: ${escapedCommandTarget}`);
        await this.executeSvnCommand(`add "${escapedCommandTarget}"`, filePath); // targetPath 仍为原始路径，用于确定根
    }

    /**
     * 删除文件 (标记为删除)
     * @param filePath 文件路径
     */
    public async removeFile(filePath: string): Promise<void> {
        this.outputChannel.appendLine(`\n[removeFile] 删除文件: ${filePath}`);
        const effectiveSvnRoot = await this.getEffectiveSvnRoot(filePath);
        let commandTarget = path.relative(effectiveSvnRoot, filePath);
        if (commandTarget === '') commandTarget = '.';

        // 转义@
        let escapedCommandTarget = commandTarget;
        if (commandTarget.includes('@')) {
            escapedCommandTarget = `${commandTarget}@`;
        }

        this.outputChannel.appendLine(`[removeFile] 有效根目录: ${effectiveSvnRoot}, 目标: ${escapedCommandTarget}`);
        await this.executeSvnCommand(`remove "${escapedCommandTarget}"`, filePath); // targetPath 仍为原始路径
    }

    /**
     * 确保输出面板可见并为新操作做准备
     * @param title 操作标题
     * @private
     */
    private showOutputChannel(title: string): void {
        // this.outputChannel.clear(); // 暂时不清空，方便看连续操作日志
        this.outputChannel.show(true); // true参数表示聚焦到输出面板
        this.outputChannel.appendLine(`\n========== ${title} 开始 ==========`);
        this.outputChannel.appendLine(`时间: ${new Date().toLocaleString()}`);
        this.outputChannel.appendLine('--------------------------------------');
    }

    /**
     * 提交文件或文件夹
     * @param fsPath 文件系统路径
     * @param message 提交信息
     */
    public async commit(fsPath: string, message: string): Promise<void> {
        this.showOutputChannel('SVN提交操作');
        this.outputChannel.appendLine(`提交路径: ${fsPath}`);
        this.outputChannel.appendLine(`提交信息: ${message}`);

        // 检查文件/文件夹是否应该被排除
        const isDirectory = (await lstat(fsPath)).isDirectory();
        if ((isDirectory && this.filterService.shouldExcludeFolder(fsPath)) ||
            (!isDirectory && this.filterService.shouldExcludeFile(fsPath))) {
            this.outputChannel.appendLine(`路径 ${fsPath} 被过滤器排除，跳过提交操作`);
            this.outputChannel.appendLine('========== SVN提交操作 跳过 ==========');
            vscode.window.showWarningMessage(`${isDirectory ? '文件夹' : '文件'} ${path.basename(fsPath)} 在排除列表中，已跳过提交`);
            return;
        }

        try {
            const effectiveSvnRoot = await this.getEffectiveSvnRoot(fsPath);
            let commandTarget = path.relative(effectiveSvnRoot, fsPath);
             if (commandTarget === '') commandTarget = '.';

            // 转义@ (仅文件)
            let escapedCommandTarget = commandTarget;
            if (commandTarget.includes('@') && !isDirectory) {
                 escapedCommandTarget = `${commandTarget}@`;
            }


            this.outputChannel.appendLine(`有效根目录: ${effectiveSvnRoot}, 目标: ${escapedCommandTarget}`);
            this.outputChannel.appendLine('正在提交...');
            const result = await this.executeSvnCommand(`commit "${escapedCommandTarget}" -m "${message}"`, fsPath); // targetPath 仍为原始路径
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN提交操作 完成 ==========');
        } catch (error: any) {
            this.outputChannel.appendLine(`错误: ${error.message}`);
            this.outputChannel.appendLine('========== SVN提交操作 失败 ==========');

            if (this.isOutOfDateError(error.message)) {
                await this.handleOutOfDateError(fsPath, message);
                return;
            }
            throw error;
        }
    }

     /**
     * 更新工作副本
     * @param fsPath 文件或目录路径
     */
    public async update(fsPath: string): Promise<void> {
        this.showOutputChannel('SVN更新操作');
        this.outputChannel.appendLine(`更新路径: ${fsPath}`);

        const isDirectory = (await lstat(fsPath)).isDirectory();
        if ((isDirectory && this.filterService.shouldExcludeFolder(fsPath)) ||
            (!isDirectory && this.filterService.shouldExcludeFile(fsPath))) {
            this.outputChannel.appendLine(`路径 ${fsPath} 被过滤器排除，跳过更新操作`);
            this.outputChannel.appendLine('========== SVN更新操作 跳过 ==========');
            vscode.window.showWarningMessage(`${isDirectory ? '文件夹' : '文件'} ${path.basename(fsPath)} 在排除列表中，已跳过更新`);
            return;
        }

        try {
            const effectiveSvnRoot = await this.getEffectiveSvnRoot(fsPath);
            let commandTarget = path.relative(effectiveSvnRoot, fsPath);
             if (commandTarget === '') commandTarget = '.';

             // 转义@ (仅文件)
             let escapedCommandTarget = commandTarget;
              if (commandTarget.includes('@') && !isDirectory) {
                   escapedCommandTarget = `${commandTarget}@`;
              }


            this.outputChannel.appendLine(`有效根目录: ${effectiveSvnRoot}, 目标: ${escapedCommandTarget}`);
            this.outputChannel.appendLine('正在更新...');
            const result = await this.executeSvnCommand(`update "${escapedCommandTarget}"`, fsPath); // targetPath 仍为原始路径
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN更新操作 完成 ==========');
        } catch (error: any) {
            this.outputChannel.appendLine(`错误: ${error.message}`);
            this.outputChannel.appendLine('========== SVN更新操作 失败 ==========');
            throw error;
        }
    }

     /**
     * 恢复文件到版本库状态
     * @param filePath 文件路径
     */
    public async revertFile(filePath: string): Promise<void> {
        this.showOutputChannel('SVN恢复操作');
        this.outputChannel.appendLine(`恢复文件: ${filePath}`);

        try {
             const effectiveSvnRoot = await this.getEffectiveSvnRoot(filePath);
             let commandTarget = path.relative(effectiveSvnRoot, filePath);
              if (commandTarget === '') commandTarget = '.';

              // 转义@
              let escapedCommandTarget = commandTarget;
               if (commandTarget.includes('@')) {
                   escapedCommandTarget = `${commandTarget}@`;
               }

            this.outputChannel.appendLine(`有效根目录: ${effectiveSvnRoot}, 目标: ${escapedCommandTarget}`);
            this.outputChannel.appendLine('正在恢复文件...');
            const result = await this.executeSvnCommand(`revert "${escapedCommandTarget}"`, filePath); // targetPath 仍为原始路径
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN恢复操作 完成 ==========');
        } catch (error: any) {
            this.outputChannel.appendLine(`错误: ${error.message}`);
            this.outputChannel.appendLine('========== SVN恢复操作 失败 ==========');
            throw new Error(`恢复文件失败: ${error.message}`);
        }
    }

    /**
     * 恢复文件夹到版本库状态（递归恢复）
     * @param folderPath 文件夹路径
     */
    public async revertFolder(folderPath: string): Promise<void> {
        this.showOutputChannel('SVN文件夹恢复操作');
        this.outputChannel.appendLine(`恢复文件夹: ${folderPath}`);

        if (this.filterService.shouldExcludeFolder(folderPath)) {
            this.outputChannel.appendLine(`文件夹 ${folderPath} 被过滤器排除，跳过恢复操作`);
            this.outputChannel.appendLine('========== SVN文件夹恢复操作 跳过 ==========');
            vscode.window.showWarningMessage(`文件夹 ${path.basename(folderPath)} 在排除列表中，已跳过恢复`);
            return;
        }

        try {
            const effectiveSvnRoot = await this.getEffectiveSvnRoot(folderPath);
            let commandTarget = path.relative(effectiveSvnRoot, folderPath);
             if (commandTarget === '') commandTarget = '.';

            // 目录路径一般不需要 @ 转义
            let escapedCommandTarget = commandTarget;

            this.outputChannel.appendLine(`有效根目录: ${effectiveSvnRoot}, 目标: ${escapedCommandTarget}`);
            this.outputChannel.appendLine('正在递归恢复文件夹...');
            const result = await this.executeSvnCommand(`revert -R "${escapedCommandTarget}"`, folderPath); // targetPath 仍为原始路径
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN文件夹恢复操作 完成 ==========');
        } catch (error: any) {
            this.outputChannel.appendLine(`错误: ${error.message}`);
            this.outputChannel.appendLine('========== SVN文件夹恢复操作 失败 ==========');
            throw new Error(`恢复文件夹失败: ${error.message}`);
        }
    }

     /**
     * 获取文件或目录日志
     * @param fsPath 文件或目录路径
     * @param limit 限制条数
     * @returns 日志信息 (原始字符串)
     */
    public async getLog(fsPath: string, limit: number = 10): Promise<string> {
        this.showOutputChannel('SVN日志查询');
        this.outputChannel.appendLine(`查询路径: ${fsPath}`);
        this.outputChannel.appendLine(`限制条数: ${limit}`);

        try {
            const effectiveSvnRoot = await this.getEffectiveSvnRoot(fsPath);
            let commandTarget = path.relative(effectiveSvnRoot, fsPath);
             if (commandTarget === '') commandTarget = '.';

            // 转义@ (仅文件)
             let escapedCommandTarget = commandTarget;
             const isDirectory = (await lstat(fsPath)).isDirectory();
              if (commandTarget.includes('@') && !isDirectory) {
                   escapedCommandTarget = `${commandTarget}@`;
              }

            this.outputChannel.appendLine(`有效根目录: ${effectiveSvnRoot}, 目标: ${escapedCommandTarget}`);
            this.outputChannel.appendLine('正在获取日志...');
            // 注意：这里不使用 useXml=true，因为 getLog 通常用于简单显示，避免XML解析开销
            const result = await this.executeSvnCommand(`log "${escapedCommandTarget}" -l ${limit}`, fsPath); // targetPath 仍为原始路径
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN日志查询 完成 ==========');
            return result;
        } catch (error: any) {
            this.outputChannel.appendLine(`错误: ${error.message}`);
            this.outputChannel.appendLine('========== SVN日志查询 失败 ==========');
            throw error;
        }
    }

    /**
     * 一次性提交多个文件
     * @param files 文件路径数组 (绝对路径)
     * @param message 提交信息
     * @param basePath 基础路径 (通常是触发批量提交的目录的绝对路径)
     */
    public async commitFiles(files: string[], message: string, basePath: string): Promise<void> {
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
                this.outputChannel.appendLine(`  ${index + 1}. ${path.relative(basePath, file)} (已排除)`);
            });
        }

        if (filteredFiles.length === 0) {
            this.outputChannel.appendLine('没有可提交的文件 (所有文件都被过滤器排除)');
            this.outputChannel.appendLine('========== SVN批量提交操作 跳过 ==========');
            vscode.window.showInformationMessage('没有可提交的文件（可能已被过滤器排除）');
            return;
        }

        this.outputChannel.appendLine('要提交的文件列表 (相对路径):');
        const fileArgsList: string[] = [];
        const effectiveSvnRoot = await this.getEffectiveSvnRoot(basePath); // 使用 basePath 确定根目录
        this.outputChannel.appendLine(`有效根目录: ${effectiveSvnRoot}`);

        for (const file of filteredFiles) {
             let commandTarget = path.relative(effectiveSvnRoot, file);
              if (commandTarget === '') commandTarget = '.';

              // 转义@ (仅文件)
              let escapedCommandTarget = commandTarget;
               try {
                   const stats = await lstat(file);
                   if (!stats.isDirectory() && commandTarget.includes('@')) {
                       escapedCommandTarget = `${commandTarget}@`;
                   }
               } catch { /* 忽略错误 */ }


            this.outputChannel.appendLine(`  ${escapedCommandTarget}`);
            fileArgsList.push(`"${escapedCommandTarget}"`);
        }

        const fileArgs = fileArgsList.join(' ');

        try {
            this.outputChannel.appendLine(`工作目录: ${effectiveSvnRoot}`);
            this.outputChannel.appendLine('正在提交文件...');
            const result = await this.executeSvnCommand(`commit ${fileArgs} -m "${message}"`, basePath); // targetPath 为 basePath
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN批量提交操作 完成 ==========');
        } catch (error: any) {
            this.outputChannel.appendLine(`错误: ${error.message}`);
            this.outputChannel.appendLine('========== SVN批量提交操作 失败 ==========');

            if (this.isOutOfDateError(error.message)) {
                await this.handleOutOfDateError(basePath, message, filteredFiles);
                return;
            }
            throw error;
        }
    }

      // --- 省略 isOutOfDateError, handleOutOfDateError, testConnection, getRepositoryFileCount, checkout ---
      // 保持不变
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

  /**
   * 测试SVN连接
   * @param svnUrl SVN地址
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 连接测试结果
   */
  public async testConnection(svnUrl: string, username?: string, password?: string): Promise<{ success: boolean; message: string }> {
    this.outputChannel.appendLine(`\n[testConnection] 测试SVN连接: ${svnUrl}`);

    try {
      // 记录认证信息
      if (username && password) {
        this.outputChannel.appendLine(`[testConnection] 使用自定义认证信息，用户名: ${username}`);
      } else {
        this.outputChannel.appendLine(`[testConnection] 使用默认认证信息`);
      }

      // 构建参数数组
      const args = ['info', svnUrl];
      if (username && password) {
        args.push('--username', username, '--password', password);
      }
      args.push('--non-interactive', '--trust-server-cert');

      this.outputChannel.appendLine(`[testConnection] 执行参数: ${JSON.stringify(args)}`);

      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();

      const result = await new Promise<string>((resolve, reject) => {
        // 注意：spawn 的 cwd 应该是有效的，这里可以省略或用一个安全的值
        const svnProcess = cp.spawn('svn', args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        svnProcess.stdout?.on('data', (data) => {
          stdout += data.toString();
        });

        svnProcess.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        svnProcess.on('close', (code) => {
          if (code === 0) {
            const processedOutput = this.processCommandOutput(stdout);
            this.outputChannel.appendLine(`[testConnection] 连接测试成功`);
            resolve(processedOutput);
          } else {
            const convertedStderr = this.processCommandOutput(stderr);
            this.outputChannel.appendLine(`[testConnection] 命令执行失败，代码: ${code}`);
            this.outputChannel.appendLine(`[testConnection] 错误输出: ${convertedStderr}`);
            reject(new Error(convertedStderr));
          }
        });

        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[testConnection] 进程错误: ${error.message}`);
          reject(error);
        });

        // 30秒超时
        setTimeout(() => {
          svnProcess.kill();
          reject(new Error('连接超时'));
        }, 30000);
      });

      // 解析结果，提取有用信息
      const lines = result.split('\n');
      let repoInfo = '';

      for (const line of lines) {
        if (line.includes('Repository Root:') || line.includes('仓库根:')) {
          repoInfo += line.trim() + '\n';
        } else if (line.includes('Revision:') || line.includes('修订版本:')) {
          repoInfo += line.trim() + '\n';
        } else if (line.includes('Last Changed Date:') || line.includes('最后修改日期:')) {
          repoInfo += line.trim() + '\n';
        }
      }

      return {
        success: true,
        message: repoInfo || '连接成功，仓库可访问'
      };
    } catch (error: any) {
      this.outputChannel.appendLine(`[testConnection] 连接测试失败: ${error.message}`);

      // 分析错误类型并提供友好的错误信息
      let friendlyMessage = error.message;

      if (error.message.includes('E170001') || error.message.includes('Authentication failed')) {
        friendlyMessage = '认证失败：用户名或密码错误';
      } else if (error.message.includes('E170013') || error.message.includes('Unable to connect')) {
        friendlyMessage = '无法连接到SVN服务器：请检查网络连接和服务器地址';
      } else if (error.message.includes('E200014') || error.message.includes('Not found')) {
        friendlyMessage = 'SVN地址不存在：请检查仓库地址是否正确';
      } else if (error.message.includes('timeout')) {
        friendlyMessage = '连接超时：服务器响应时间过长，请检查网络连接';
      } else if (error.message.includes('certificate')) {
        friendlyMessage = 'SSL证书错误：服务器证书验证失败';
      }

      return {
        success: false,
        message: friendlyMessage
      };
    }
  }

   /**
   * 获取SVN仓库中的文件总数 (此方法可能非常耗时，谨慎使用)
   * @param svnUrl SVN仓库地址
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 文件总数，失败时返回-1
   */
  public async getRepositoryFileCount(
    svnUrl: string,
    username?: string,
    password?: string
  ): Promise<number> {
    try {
      this.outputChannel.appendLine(`\n[getFileCount] 正在获取仓库文件总数: ${svnUrl}`);
      const env = this.getEnhancedEnvironment();
      const args = ['list', '-R', svnUrl];
      if (username && password) {
        args.push('--username', username, '--password', password);
      }
      args.push('--non-interactive', '--trust-server-cert');

      this.outputChannel.appendLine(`[getFileCount] 执行命令参数: ${JSON.stringify(args)}`);

      return await new Promise<number>((resolve) => {
        const svnProcess = cp.spawn('svn', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let outputBuffer = '';
        let errorBuffer = '';

        svnProcess.stdout?.on('data', (data) => outputBuffer += this.processCommandOutput(data.toString()));
        svnProcess.stderr?.on('data', (data) => errorBuffer += this.processCommandOutput(data.toString()));

        svnProcess.on('close', (code) => {
          if (code === 0) {
            const lines = outputBuffer.split('\n').filter(line => line.trim() !== '');
            const fileCount = lines.filter(line => !line.endsWith('/')).length;
            this.outputChannel.appendLine(`[getFileCount] 成功获取文件总数: ${fileCount}`);
            resolve(fileCount);
          } else {
            this.outputChannel.appendLine(`[getFileCount] 获取文件总数失败: ${errorBuffer}`);
            resolve(-1);
          }
        });
        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[getFileCount] 进程错误: ${error.message}`);
          resolve(-1);
        });
        setTimeout(() => { svnProcess.kill(); this.outputChannel.appendLine('[getFileCount] 获取文件总数超时'); resolve(-1); }, 2 * 60 * 1000);
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[getFileCount] 获取文件总数异常: ${error.message}`);
      return -1;
    }
  }

  /**
   * 执行SVN检出操作
   * @param svnUrl SVN地址
   * @param targetDirectory 目标目录 (绝对路径)
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @param progressCallback 进度回调函数
   * @returns 检出操作结果
   */
  public async checkout(
    svnUrl: string,
    targetDirectory: string,
    username?: string,
    password?: string,
    progressCallback?: (message: string, progress?: number) => void
  ): Promise<{ success: boolean; message: string }> {
    this.showOutputChannel('SVN检出操作');
    this.outputChannel.appendLine(`SVN地址: ${svnUrl}`);
    this.outputChannel.appendLine(`目标目录: ${targetDirectory}`);

    try {
        // 确保目标目录存在
        if (!await fsExists(targetDirectory)) {
            await fs.promises.mkdir(targetDirectory, { recursive: true });
            this.outputChannel.appendLine(`创建目标目录: ${targetDirectory}`);
        } else {
             // 检查目标目录是否为空（允许只包含 .svn）
             const files = await fs.promises.readdir(targetDirectory);
             const nonSvnFiles = files.filter(file => file !== '.svn');
             if (nonSvnFiles.length > 0) {
                 this.outputChannel.appendLine(`警告: 目标目录 ${targetDirectory} 不为空`);
                 // SVN checkout 默认行为通常是允许在非空目录中执行，除非有冲突
             }
        }


      let totalFileCount = -1;
      if (progressCallback) {
        progressCallback('正在连接SVN服务器...', 5);
        progressCallback('正在获取仓库文件信息...', 10);
        totalFileCount = await this.getRepositoryFileCount(svnUrl, username, password);
        if (totalFileCount > 0) {
          this.outputChannel.appendLine(`仓库包含 ${totalFileCount} 个文件`);
          progressCallback(`发现 ${totalFileCount} 个文件，准备开始检出...`, 15);
        } else {
          this.outputChannel.appendLine(`无法获取文件总数，将使用传统进度计算方式`);
          progressCallback('准备开始检出...', 15);
        }
      }

      const env = this.getEnhancedEnvironment();
      return await new Promise<{ success: boolean; message: string }>((resolve, reject) => {
        const args = ['checkout', svnUrl, targetDirectory]; // targetDirectory 应该是绝对路径
        if (username && password) {
          args.push('--username', username, '--password', password);
        }
        args.push('--non-interactive', '--trust-server-cert');

        this.outputChannel.appendLine(`[checkout] 实际执行参数: ${JSON.stringify(args)}`);
        // checkout 的 cwd 应该是 targetDirectory 的父目录，或者一个安全的不相关的目录
        const checkoutCwd = path.dirname(targetDirectory); // 在父目录执行 checkout <url> <target>
         this.outputChannel.appendLine(`[checkout] 将在目录 ${checkoutCwd} 中执行检出`);

        const svnProcess = cp.spawn('svn', args, { cwd: checkoutCwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let outputBuffer = '';
        let errorBuffer = '';
        let currentProgress = 15;
        let checkedOutFileCount = 0;

        svnProcess.stdout?.on('data', (data) => {
            const output = this.processCommandOutput(data.toString());
            outputBuffer += output;
            this.outputChannel.appendLine(`[checkout] 输出: ${output.replace(/\n/g, '\\n')}`);
            if (progressCallback) {
                if (output.includes('A ') || output.includes('添加')) checkedOutFileCount++;
                if (totalFileCount > 0) {
                    const fileProgress = Math.min((checkedOutFileCount / totalFileCount) * 80, 80);
                    currentProgress = 15 + fileProgress;
                } else {
                    currentProgress = Math.min(currentProgress + 1, 90);
                }
                const match = output.match(/A\s+(.+)/);
                 let progressMsg = '正在检出文件...';
                 if (match) {
                     const fileName = path.basename(match[1]);
                      progressMsg = `正在检出: ${fileName}`;
                 }
                 if (totalFileCount > 0) progressMsg += ` (${checkedOutFileCount}/${totalFileCount})`;
                progressCallback(progressMsg, Math.round(currentProgress));
                 if (output.includes('Checked out') || output.includes('检出完成')) {
                    progressCallback('检出完成', 100);
                 }
            }
        });
        svnProcess.stderr?.on('data', (data) => {
            const error = this.processCommandOutput(data.toString());
            errorBuffer += error;
            this.outputChannel.appendLine(`[checkout] 错误: ${error.replace(/\n/g, '\\n')}`);
             // 处理 stderr 中的进度信息
              if (progressCallback && (error.includes('A ') || error.includes('添加'))) {
                 checkedOutFileCount++;
                 if (totalFileCount > 0) {
                      const fileProgress = Math.min((checkedOutFileCount / totalFileCount) * 80, 80);
                      currentProgress = 15 + fileProgress;
                 } else {
                      currentProgress = Math.min(currentProgress + 1, 90);
                 }
                  const match = error.match(/A\s+(.+)/);
                   let progressMsg = '正在检出文件...';
                    if (match) {
                        const fileName = path.basename(match[1]);
                         progressMsg = `正在检出: ${fileName}`;
                    }
                     if (totalFileCount > 0) progressMsg += ` (${checkedOutFileCount}/${totalFileCount})`;
                  progressCallback(progressMsg, Math.round(currentProgress));
              }
        });

        svnProcess.on('close', (code) => {
          this.outputChannel.appendLine(`[checkout] 进程退出，代码: ${code}`);
          if (code === 0) {
            const successMessage = `SVN检出成功完成\n目标目录: ${targetDirectory}`;
            this.outputChannel.appendLine(successMessage);
            this.outputChannel.appendLine('========== SVN检出操作 完成 ==========');
            if (progressCallback) progressCallback('检出完成', 100);
            resolve({ success: true, message: successMessage });
          } else {
            let errorMessage = errorBuffer || '检出操作失败';
            if (errorBuffer.includes('E170001') || errorBuffer.includes('Authentication failed')) errorMessage = '认证失败：用户名或密码错误';
            else if (errorBuffer.includes('E170013') || errorBuffer.includes('Unable to connect')) errorMessage = '无法连接到SVN服务器：请检查网络连接和服务器地址';
            else if (errorBuffer.includes('E200014') || errorBuffer.includes('Not found')) errorMessage = 'SVN地址不存在：请检查仓库地址是否正确';
            else if (errorBuffer.includes('E155000') || errorBuffer.includes('already a working copy')) errorMessage = '目标目录已经是一个SVN工作副本';
             else if (errorBuffer.includes('E155010') || errorBuffer.includes('folder exists')) errorMessage = `目标目录 ${targetDirectory} 已存在且不为空，无法检出。请选择一个空目录或已存在的同名工作副本目录。`;


            this.outputChannel.appendLine(`错误: ${errorMessage}`);
            this.outputChannel.appendLine('========== SVN检出操作 失败 ==========');
            if (progressCallback) progressCallback('检出失败', 0);
            resolve({ success: false, message: errorMessage });
          }
        });

        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[checkout] 进程错误: ${error.message}`);
          this.outputChannel.appendLine('========== SVN检出操作 失败 ==========');
          if (progressCallback) progressCallback('检出失败', 0);
          resolve({ success: false, message: `检出进程启动失败: ${error.message}` });
        });
        setTimeout(() => { svnProcess.kill(); this.outputChannel.appendLine('[checkout] 检出操作超时'); this.outputChannel.appendLine('========== SVN检出操作 超时 =========='); if (progressCallback) progressCallback('检出超时', 0); resolve({ success: false, message: '检出操作超时（30分钟），可能是文件过多或网络问题' }); }, 30 * 60 * 1000);
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[checkout] 检出操作异常: ${error.message}`);
      this.outputChannel.appendLine('========== SVN检出操作 失败 ==========');
      if (progressCallback) progressCallback('检出失败', 0);
      return { success: false, message: `检出操作失败: ${error.message}` };
    }
  }


}
