import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';

/**
 * SVN差异对比提供器
 */
export class SvnDiffProvider {
  private readonly svnService: SvnService;
  private outputChannel: vscode.OutputChannel;

  constructor(svnService: SvnService) {
    this.svnService = svnService;
    this.outputChannel = vscode.window.createOutputChannel('SVN差异诊断');
  }

  /**
   * 获取文件与SVN版本的差异
   * @param filePath 文件路径
   * @returns 差异内容
   */
  public async getDiff(filePath: string): Promise<string> {
    this.outputChannel.appendLine(`\n[getDiff] 开始获取文件差异: ${filePath}`);
    this.outputChannel.show(true);
    
    try {
      const cwd = path.dirname(filePath);
      const fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`[getDiff] 工作目录: ${cwd}`);
      this.outputChannel.appendLine(`[getDiff] 文件名: ${fileName}`);
      
      // 尝试获取文件状态
      try {
        const status = await this.svnService.getFileStatus(filePath);
        this.outputChannel.appendLine(`[getDiff] 文件SVN状态: ${status}`);
      } catch (statusError: any) {
        this.outputChannel.appendLine(`[getDiff] 获取文件状态失败: ${statusError.message}`);
      }
      
      // 使用更多参数来处理编码问题，但不使用XML格式
      this.outputChannel.appendLine(`[getDiff] 执行SVN差异命令...`);
      // 注意：不使用--xml参数，因为diff命令的XML输出不包含实际差异内容
      const diffCommand = `diff "${fileName}" --force -x "--ignore-space-change --ignore-eol-style"`;
      this.outputChannel.appendLine(`[getDiff] 命令: svn ${diffCommand}`);
      
      // 直接执行命令而不通过svnService，以避免自动添加--xml参数
      const cp = require('child_process');
      const { promisify } = require('util');
      const exec = promisify(cp.exec);
      
      try {
        // 获取用户配置的编码设置
        const config = vscode.workspace.getConfiguration('vscode-svn');
        const encoding = config.get<string>('encoding', 'utf8');
        const locale = config.get<string>('svnLocale', 'en_US.UTF-8');
        
        // 设置环境变量以解决编码问题
        const env = Object.assign({}, process.env, {
          LANG: locale,
          LC_ALL: locale,
          LANGUAGE: locale,
          SVN_EDITOR: 'vim'
        });
        
        this.outputChannel.appendLine(`[getDiff] 使用编码设置: ${encoding}, 语言环境: ${locale}`);
        this.outputChannel.appendLine(`[getDiff] 直接执行命令: svn ${diffCommand}`);
        const { stdout } = await exec(`svn ${diffCommand}`, { 
          cwd, 
          env,
          encoding: encoding as BufferEncoding, // 使用用户配置的编码
          maxBuffer: 10 * 1024 * 1024 // 增加缓冲区大小到10MB
        });
        
        this.outputChannel.appendLine(`[getDiff] 差异命令执行成功，结果长度: ${stdout.length} 字节`);
        if (stdout.length > 0) {
          this.outputChannel.appendLine(`[getDiff] 差异内容前100个字符: ${stdout.substring(0, 100).replace(/\n/g, '\\n')}`);
        } else {
          this.outputChannel.appendLine(`[getDiff] 警告: 差异结果为空`);
        }
        
        if (stdout.trim() === '') {
          // 尝试使用另一种方式获取差异
          this.outputChannel.appendLine(`[getDiff] 尝试使用cat命令获取SVN版本内容...`);
          const baseContent = await this.svnService.executeSvnCommand(`cat "${fileName}"`, cwd);
          this.outputChannel.appendLine(`[getDiff] SVN版本内容长度: ${baseContent.length} 字节`);
          
          // 获取文件当前内容
          const currentContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
          const currentText = Buffer.from(currentContent).toString('utf8');
          this.outputChannel.appendLine(`[getDiff] 当前文件内容长度: ${currentText.length} 字节`);
          
          // 比较内容是否相同
          const isDifferent = currentText !== baseContent;
          this.outputChannel.appendLine(`[getDiff] 内容比较结果: ${isDifferent ? '不同' : '相同'}`);
          
          if (isDifferent) {
            this.outputChannel.appendLine(`[getDiff] 检测到文件有变化，但diff命令未返回差异`);
            
            // 尝试使用系统diff命令
            try {
              this.outputChannel.appendLine(`[getDiff] 尝试使用系统diff命令...`);
              
              // 创建临时文件
              const tempDir = require('os').tmpdir();
              const fs = require('fs');
              const baseFilePath = path.join(tempDir, `svn_base_${path.basename(filePath)}`);
              const currentFilePath = path.join(tempDir, `svn_current_${path.basename(filePath)}`);
              
              // 写入内容到临时文件
              fs.writeFileSync(baseFilePath, baseContent);
              fs.writeFileSync(currentFilePath, currentText);
              
              // 使用系统diff命令
              try {
                const { stdout: diffOutput } = await exec(`diff -u "${baseFilePath}" "${currentFilePath}"`, { 
                  maxBuffer: 10 * 1024 * 1024
                });
                
                // 清理临时文件
                fs.unlinkSync(baseFilePath);
                fs.unlinkSync(currentFilePath);
                
                if (diffOutput.trim() !== '') {
                  this.outputChannel.appendLine(`[getDiff] 系统diff命令成功，结果长度: ${diffOutput.length} 字节`);
                  return diffOutput;
                }
              } catch (diffError: any) {
                // diff命令返回非零退出码时也会抛出异常，但可能包含有效的差异输出
                if (diffError.stdout && diffError.stdout.trim() !== '') {
                  this.outputChannel.appendLine(`[getDiff] 系统diff命令返回差异，结果长度: ${diffError.stdout.length} 字节`);
                  
                  // 清理临时文件
                  fs.unlinkSync(baseFilePath);
                  fs.unlinkSync(currentFilePath);
                  
                  return diffError.stdout;
                }
                
                // 清理临时文件
                fs.unlinkSync(baseFilePath);
                fs.unlinkSync(currentFilePath);
                
                this.outputChannel.appendLine(`[getDiff] 系统diff命令失败: ${diffError.message}`);
              }
            } catch (tempFileError: any) {
              this.outputChannel.appendLine(`[getDiff] 临时文件操作失败: ${tempFileError.message}`);
            }
            
            // 如果所有方法都失败，返回基本信息
            return `--- ${fileName}\t(版本库版本)\n+++ ${fileName}\t(工作副本)\n\n` + 
                   `SVN差异比较：\n` +
                   `文件在SVN中的大小: ${baseContent.length} 字节\n` +
                   `当前文件大小: ${currentText.length} 字节\n\n` +
                   `注意：SVN diff命令未返回差异内容，但文件内容确实不同。\n` +
                   `这可能是由于编码问题或SVN配置导致。您仍然可以继续提交。`;
          } else {
            return `文件内容与SVN版本相同，没有检测到差异。`;
          }
        }
        
        return stdout;
      } catch (execError: any) {
        this.outputChannel.appendLine(`[getDiff] 直接执行命令失败: ${execError.message}`);
        if (execError.stderr) {
          this.outputChannel.appendLine(`[getDiff] 错误输出: ${execError.stderr}`);
        }
        
        // 如果直接执行失败，尝试使用svnService
        const diffResult = await this.svnService.executeSvnCommand(diffCommand, cwd);
        
        // 检查是否是XML格式的输出
        if (diffResult.includes('<?xml') && !diffResult.includes('<diff>')) {
          this.outputChannel.appendLine(`[getDiff] 收到XML格式输出，但不包含差异内容`);
          throw new Error('SVN返回了XML格式的输出，但不包含差异内容');
        }
        
        return diffResult;
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[getDiff] 错误: ${error.message}`);
      this.outputChannel.appendLine(`[getDiff] 尝试备用方法...`);
      
      // 如果获取差异失败，尝试使用另一种方法
      try {
        const cwd = path.dirname(filePath);
        const fileName = path.basename(filePath);
        
        // 获取用户配置的编码设置
        const config = vscode.workspace.getConfiguration('vscode-svn');
        const encoding = config.get<string>('encoding', 'utf8');
        
        // 获取文件当前内容
        this.outputChannel.appendLine(`[getDiff] 读取当前文件内容...`);
        const currentContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        const currentText = Buffer.from(currentContent).toString(encoding as BufferEncoding);
        this.outputChannel.appendLine(`[getDiff] 当前文件内容长度: ${currentText.length} 字节，使用编码: ${encoding}`);
        
        // 获取SVN版本内容
        this.outputChannel.appendLine(`[getDiff] 获取SVN版本内容...`);
        const baseContent = await this.svnService.executeSvnCommand(`cat "${fileName}"`, cwd);
        this.outputChannel.appendLine(`[getDiff] SVN版本内容长度: ${baseContent.length} 字节`);
        
        // 比较内容是否相同
        const isDifferent = currentText !== baseContent;
        this.outputChannel.appendLine(`[getDiff] 内容比较结果: ${isDifferent ? '不同' : '相同'}`);
        
        // 手动创建差异信息
        return `--- ${fileName}\t(版本库版本)\n+++ ${fileName}\t(工作副本)\n\n` + 
               `SVN差异比较：\n` +
               `文件在SVN中的大小: ${baseContent.length} 字节\n` +
               `当前文件大小: ${currentText.length} 字节\n\n` +
               `注意：由于编码问题，无法显示详细差异。请使用"提交"功能继续。\n` +
               `原始错误: ${error.message}`;
      } catch (fallbackError: any) {
        this.outputChannel.appendLine(`[getDiff] 备用方法也失败: ${fallbackError.message}`);
        throw new Error(`获取差异失败: ${error.message}\n备用方法失败: ${fallbackError.message}`);
      }
    }
  }

  /**
   * 检查文件是否有修改
   * @param filePath 文件路径
   * @returns 是否有修改
   */
  public async hasChanges(filePath: string): Promise<boolean> {
    this.outputChannel.appendLine(`\n[hasChanges] 检查文件是否有修改: ${filePath}`);
    
    try {
      const status = await this.svnService.getFileStatus(filePath);
      this.outputChannel.appendLine(`[hasChanges] 文件SVN状态: ${status}`);
      const hasChanges = status === '已修改' || status === '已添加' || status === '已删除' || status === '已替换';
      this.outputChannel.appendLine(`[hasChanges] 基于状态判断是否有修改: ${hasChanges}`);
      return hasChanges;
    } catch (error: any) {
      this.outputChannel.appendLine(`[hasChanges] 获取状态失败: ${error.message}`);
      this.outputChannel.appendLine(`[hasChanges] 尝试备用方法...`);
      
      // 如果获取状态失败，尝试使用另一种方法检查
      try {
        // 获取文件当前内容
        this.outputChannel.appendLine(`[hasChanges] 读取当前文件内容...`);
        const currentContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        const currentText = Buffer.from(currentContent).toString('utf8');
        this.outputChannel.appendLine(`[hasChanges] 当前文件内容长度: ${currentText.length} 字节`);
        
        // 获取SVN版本内容
        const cwd = path.dirname(filePath);
        const fileName = path.basename(filePath);
        this.outputChannel.appendLine(`[hasChanges] 获取SVN版本内容...`);
        const baseContent = await this.svnService.executeSvnCommand(`cat "${fileName}"`, cwd);
        this.outputChannel.appendLine(`[hasChanges] SVN版本内容长度: ${baseContent.length} 字节`);
        
        // 比较内容是否相同
        const isDifferent = currentText !== baseContent;
        this.outputChannel.appendLine(`[hasChanges] 内容比较结果: ${isDifferent ? '不同' : '相同'}`);
        return isDifferent;
      } catch (fallbackError: any) {
        this.outputChannel.appendLine(`[hasChanges] 备用方法也失败: ${fallbackError.message}`);
        this.outputChannel.appendLine(`[hasChanges] 假设文件有修改，让用户决定是否提交`);
        // 如果还是失败，假设有修改（让用户决定是否提交）
        return true;
      }
    }
  }

  /**
   * 显示文件差异对比
   * @param filePath 文件路径
   * @returns 是否成功显示差异
   */
  public async showDiff(filePath: string): Promise<boolean> {
    this.outputChannel.appendLine(`\n[showDiff] 开始显示文件差异: ${filePath}`);
    
    try {
      // 检查文件是否有修改
      this.outputChannel.appendLine(`[showDiff] 检查文件是否有修改...`);
      const hasChanges = await this.hasChanges(filePath);
      this.outputChannel.appendLine(`[showDiff] 文件是否有修改: ${hasChanges}`);
      
      if (!hasChanges) {
        this.outputChannel.appendLine(`[showDiff] 文件没有修改，无需提交`);
        vscode.window.showInformationMessage('文件没有修改，无需提交');
        return false;
      }

      try {
        // 获取当前文件的 URI
        const currentUri = vscode.Uri.file(filePath);
        
        // 创建临时文件用于存储 SVN 版本的内容
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `svn_base_${path.basename(filePath)}`);
        
        // 获取 SVN 版本的内容
        this.outputChannel.appendLine(`[showDiff] 获取 SVN 版本内容...`);
        const cwd = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const baseContent = await this.svnService.executeSvnCommand(`cat "${fileName}"`, cwd);
        
        // 写入 SVN 版本内容到临时文件
        this.outputChannel.appendLine(`[showDiff] 写入 SVN 版本内容到临时文件: ${tempFilePath}`);
        fs.writeFileSync(tempFilePath, baseContent);
        
        // 创建临时文件的 URI
        const baseUri = vscode.Uri.file(tempFilePath);
        
        // 使用 VS Code 的差异编辑器显示左右对比
        this.outputChannel.appendLine(`[showDiff] 打开差异编辑器...`);
        await vscode.commands.executeCommand('vscode.diff', 
          baseUri, 
          currentUri, 
          `SVN: ${path.basename(filePath)} (左: 版本库 | 右: 工作副本)`
        );
        
        this.outputChannel.appendLine(`[showDiff] 差异显示成功`);
        return true;
      } catch (error: any) {
        // 如果显示差异失败，显示错误但仍然允许提交
        this.outputChannel.appendLine(`[showDiff] 显示差异失败: ${error.message}`);
        vscode.window.showWarningMessage(`无法显示详细差异: ${error.message}。您仍然可以继续提交。`);
        return true;
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[showDiff] 错误: ${error.message}`);
      vscode.window.showErrorMessage(`显示差异失败: ${error.message}`);
      return false;
    }
  }
} 