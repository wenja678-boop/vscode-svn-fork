import * as vscode from 'vscode';

/**
 * SVN认证信息接口
 */
export interface SvnCredential {
  username: string;
  password: string;
  serverUrl: string;
  lastUsed: Date;
  description?: string;
}

/**
 * SVN认证服务类
 * 负责管理多仓库的认证信息存储和检索
 */
export class SvnAuthService {
  private static readonly CREDENTIAL_KEY = 'vscode-svn.credentials';
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * 根据SVN项目URL获取认证信息
   * @param repoUrl SVN项目完整URL（如：http://svn.company.com/projects/projectA/trunk）
   * @returns 认证信息或undefined
   */
  public async getCredential(repoUrl: string): Promise<SvnCredential | undefined> {
    try {
      const credentials = await this.getAllCredentials();
      
      // 精确匹配
      if (credentials[repoUrl]) {
        return credentials[repoUrl];
      }
      
      // 域名匹配（支持子路径）
      for (const [storedUrl, credential] of Object.entries(credentials)) {
        if (this.isUrlMatch(repoUrl, storedUrl)) {
          return credential;
        }
      }
      
      return undefined;
    } catch (error) {
      console.error('获取认证信息失败:', error);
      return undefined;
    }
  }

  /**
   * 保存认证信息
   * @param repoUrl SVN项目完整URL（如：http://svn.company.com/projects/projectA/trunk）
   * @param username 用户名
   * @param password 密码
   * @param description 描述（可选）
   */
  public async saveCredential(
    repoUrl: string,
    username: string,
    password: string,
    description?: string
  ): Promise<void> {
    try {
      const credentials = await this.getAllCredentials();
      
      credentials[repoUrl] = {
        username,
        password,
        serverUrl: repoUrl,
        lastUsed: new Date(),
        description
      };
      
      await this.context.secrets.store(
        SvnAuthService.CREDENTIAL_KEY,
        JSON.stringify(credentials)
      );
      
      console.log(`已保存仓库 ${repoUrl} 的认证信息`);
    } catch (error: any) {
      console.error('保存认证信息失败:', error);
      throw new Error(`保存认证信息失败: ${error.message}`);
    }
  }

  /**
   * 删除特定仓库的认证信息
   * @param repoUrl 仓库根URL
   */
  public async removeCredential(repoUrl: string): Promise<void> {
    try {
      const credentials = await this.getAllCredentials();
      
      if (credentials[repoUrl]) {
        delete credentials[repoUrl];
        await this.context.secrets.store(
          SvnAuthService.CREDENTIAL_KEY,
          JSON.stringify(credentials)
        );
        console.log(`已删除仓库 ${repoUrl} 的认证信息`);
      }
    } catch (error: any) {
      console.error('删除认证信息失败:', error);
      throw new Error(`删除认证信息失败: ${error.message}`);
    }
  }

  /**
   * 清除所有认证信息
   */
  public async clearAllCredentials(): Promise<void> {
    try {
      await this.context.secrets.delete(SvnAuthService.CREDENTIAL_KEY);
      console.log('已清除所有SVN认证信息');
    } catch (error: any) {
      console.error('清除认证信息失败:', error);
      throw new Error(`清除认证信息失败: ${error.message}`);
    }
  }

  /**
   * 获取所有认证信息
   * @returns 所有认证信息的映射
   */
  public async getAllCredentials(): Promise<Record<string, SvnCredential>> {
    try {
      const credentialsJson = await this.context.secrets.get(SvnAuthService.CREDENTIAL_KEY);
      
      if (!credentialsJson) {
        return {};
      }
      
      const credentials = JSON.parse(credentialsJson);
      
      // 恢复Date对象
      for (const credential of Object.values(credentials) as SvnCredential[]) {
        credential.lastUsed = new Date(credential.lastUsed);
      }
      
      return credentials;
    } catch (error) {
      console.error('获取认证信息失败:', error);
      return {};
    }
  }

  /**
   * 获取当前工作副本的完整SVN URL（用于认证管理）
   * @param workingPath SVN工作副本路径
   * @returns 完整的SVN URL或null
   */
  public async getRepositoryRootUrl(workingPath: string): Promise<string | null> {
    try {
      // 使用svn info命令获取当前工作副本的完整URL
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      const result = await execAsync('svn info --show-item url', {
        cwd: workingPath,
        encoding: 'utf8'
      });
      
      const fullUrl = result.stdout.trim();
      console.log(`[SvnAuthService] 获取到完整SVN URL: ${fullUrl}`);
      return fullUrl || null;
    } catch (error) {
      console.error('获取SVN URL失败:', error);
      
      // 降级方案：尝试获取仓库根URL
      try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        const fallbackResult = await execAsync('svn info --show-item repos-root-url', {
          cwd: workingPath,
          encoding: 'utf8'
        });
        
        const rootUrl = fallbackResult.stdout.trim();
        console.log(`[SvnAuthService] 降级使用仓库根URL: ${rootUrl}`);
        return rootUrl || null;
      } catch (fallbackError) {
        console.error('获取仓库根URL也失败:', fallbackError);
        return null;
      }
    }
  }

  /**
   * URL匹配检查（支持项目级别的精确匹配）
   * @param targetUrl 目标URL
   * @param storedUrl 存储的URL
   * @returns 是否匹配
   */
  private isUrlMatch(targetUrl: string, storedUrl: string): boolean {
    try {
      // 精确匹配优先
      if (targetUrl === storedUrl) {
        return true;
      }
      
      const targetParsed = new URL(targetUrl);
      const storedParsed = new URL(storedUrl);
      
      // 协议和主机必须匹配
      if (targetParsed.protocol !== storedParsed.protocol ||
          targetParsed.host !== storedParsed.host) {
        return false;
      }
      
      // 路径匹配策略：
      // 1. 精确路径匹配
      // 2. 父路径匹配（存储的URL是目标URL的父路径）
      // 3. 子路径匹配（存储的URL是目标URL的子路径）
      const targetPath = targetParsed.pathname.replace(/\/$/, '');
      const storedPath = storedParsed.pathname.replace(/\/$/, '');
      
      // 父路径匹配：目标URL以存储URL开头（用于子项目访问父项目认证）
      if (targetPath.startsWith(storedPath)) {
        console.log(`[SvnAuthService] 父路径匹配: ${storedPath} -> ${targetPath}`);
        return true;
      }
      
      // 子路径匹配：存储URL以目标URL开头（用于父项目认证访问子项目）
      if (storedPath.startsWith(targetPath)) {
        console.log(`[SvnAuthService] 子路径匹配: ${targetPath} -> ${storedPath}`);
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('URL匹配检查失败:', error);
      // URL解析失败，使用简单字符串匹配
      return targetUrl.includes(storedUrl) || storedUrl.includes(targetUrl);
    }
  }

  /**
   * 更新认证信息的最后使用时间
   * @param repoUrl 仓库根URL
   */
  public async updateLastUsed(repoUrl: string): Promise<void> {
    try {
      const credentials = await this.getAllCredentials();
      
      if (credentials[repoUrl]) {
        credentials[repoUrl].lastUsed = new Date();
        await this.context.secrets.store(
          SvnAuthService.CREDENTIAL_KEY,
          JSON.stringify(credentials)
        );
      }
    } catch (error) {
      console.error('更新最后使用时间失败:', error);
    }
  }

  /**
   * 验证认证信息是否有效
   * @param repoUrl 仓库URL
   * @param username 用户名
   * @param password 密码
   * @returns 验证结果
   */
  public async validateCredential(
    repoUrl: string,
    username: string,
    password: string
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      const command = `svn info "${repoUrl}" --username "${username}" --password "${password}" --non-interactive --trust-server-cert`;
      
      await execAsync(command, {
        timeout: 10000, // 10秒超时
        encoding: 'utf8'
      });
      
      return { valid: true };
    } catch (error: any) {
      let errorMessage = '认证验证失败';
      
      if (error.message.includes('E170001') || error.message.includes('Authentication failed')) {
        errorMessage = '用户名或密码错误';
      } else if (error.message.includes('E170013') || error.message.includes('Unable to connect')) {
        errorMessage = '无法连接到SVN服务器';
      } else if (error.message.includes('timeout')) {
        errorMessage = '连接超时';
      }
      
      return { valid: false, error: errorMessage };
    }
  }

  /**
   * 获取配置的自动保存设置
   * @returns 是否自动保存认证信息
   */
  public getAutoSaveCredentials(): boolean {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    return config.get('authenticationConfig.autoSaveCredentials', true);
  }

  /**
   * 获取配置的自动提示设置
   * @returns 认证失败时是否自动提示
   */
  public getDefaultAuthPrompt(): boolean {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    return config.get('authenticationConfig.defaultAuthPrompt', true);
  }
}
