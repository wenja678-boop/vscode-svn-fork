import * as vscode from 'vscode';
import * as https from 'https';

/**
 * AI服务类，用于生成SVN提交日志
 */
export class AiService {
  private static readonly OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
  private static readonly QWEN_API_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
  private aiModel: string;
  private openaiApiKey: string | undefined;
  private qwenApiKey: string | undefined;

  constructor() {
    // 从设置中获取配置
    const config = vscode.workspace.getConfiguration('vscode-svn');
    this.aiModel = config.get<string>('aiModel') || 'openai';
    this.openaiApiKey = config.get<string>('aiApiKey');
    this.qwenApiKey = config.get<string>('qwenApiKey');
  }

  /**
   * 生成SVN提交日志
   * @param diffContent SVN差异内容
   * @returns 生成的提交日志
   */
  public async generateCommitMessage(diffContent: string): Promise<string> {
    try {
      // 检查是否配置了API密钥
      if (this.aiModel === 'openai' && !this.openaiApiKey) {
        const setApiKey = await vscode.window.showInformationMessage(
          '请先设置OpenAI API密钥才能使用AI生成提交日志功能',
          '设置API密钥',
          '取消'
        );
        
        if (setApiKey === '设置API密钥') {
          const apiKey = await vscode.window.showInputBox({
            prompt: '请输入您的OpenAI API密钥',
            password: true,
            placeHolder: 'sk-...'
          });
          
          if (apiKey) {
            await vscode.workspace.getConfiguration('vscode-svn').update('aiApiKey', apiKey, vscode.ConfigurationTarget.Global);
            this.openaiApiKey = apiKey;
          } else {
            return '';
          }
        } else {
          return '';
        }
      } else if (this.aiModel === 'qwen' && !this.qwenApiKey) {
        const setApiKey = await vscode.window.showInformationMessage(
          '请先设置通义千问API密钥才能使用AI生成提交日志功能',
          '设置密钥',
          '取消'
        );
        
        if (setApiKey === '设置密钥') {
          const apiKey = await vscode.window.showInputBox({
            prompt: '请输入您的通义千问API密钥',
            password: true,
            placeHolder: 'sk-...'
          });
          
          if (apiKey) {
            await vscode.workspace.getConfiguration('vscode-svn').update('qwenApiKey', apiKey, vscode.ConfigurationTarget.Global);
            this.qwenApiKey = apiKey;
          } else {
            return '';
          }
        } else {
          return '';
        }
      }
      
      // 准备发送给AI的提示
      const prompt = this.preparePrompt(diffContent);
      
      // 显示进度提示
      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在生成SVN提交日志...',
        cancellable: false
      }, async (progress) => {
        progress.report({ increment: 30 });
        
        // 根据选择的模型调用不同的API
        const response = this.aiModel === 'openai' 
          ? await this.callOpenAiApi(prompt)
          : await this.callQwenApi(prompt);
        
        progress.report({ increment: 70 });
        
        return response;
      });
    } catch (error: any) {
      vscode.window.showErrorMessage(`生成提交日志失败: ${error.message}`);
      return '';
    }
  }

  /**
   * 准备发送给AI的提示
   * @param diffContent SVN差异内容
   * @returns 格式化的提示
   */
  private preparePrompt(diffContent: string): string {
    // 限制差异内容的长度，避免超出API限制
    const maxDiffLength = 3000;
    let truncatedDiff = diffContent;
    
    if (diffContent.length > maxDiffLength) {
      truncatedDiff = diffContent.substring(0, maxDiffLength) + '...(内容已截断)';
    }
    
    return `你是一个专业的SVN提交日志生成助手。请根据以下SVN差异内容，生成一个详细的提交日志。

要求：
1. 按文件名分段落输出，每个文件的修改内容单独一段
2. 每个文件段落的格式如下：
   - 第一行：文件名
   - 第二行开始：分点说明修改内容，每个要点一行
   - 最后一行：空行

3. 分析要点应包含：
   - 修改了什么功能或内容
   - 修改的目的或原因
   - 可能产生的影响
   - 忽略无用的修改分析 例如只是一些换行, 空格, 等

4. 对于每个文件的修改，要根据实际意义换行显示，使日志更易读
5. 如果涉及多个相关文件的修改，要说明它们之间的关联
6. 使用中文，内容要介于过于简洁和过于复杂之间
7. 不要包含任何多余的格式或标记

SVN差异内容:
${truncatedDiff}

提交日志:
`;
  }

  /**
   * 调用OpenAI API
   * @param prompt 提示内容
   * @returns AI生成的回复
   */
  private callOpenAiApi(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const requestData = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content: '你是一个专业的SVN提交日志生成助手。你的任务是根据SVN差异内容生成详细的提交日志。你应该按文件名分段落输出，每个文件的修改内容单独一段。每个文件段落应包含修改内容、目的和影响。使用中文，保持适中的详细程度。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.7
      });
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`
        }
      };
      
      const req = https.request(AiService.OPENAI_API_ENDPOINT, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const response = JSON.parse(data);
              const message = response.choices[0].message.content.trim();
              resolve(message);
            } else {
              reject(new Error(`API请求失败，状态码: ${res.statusCode}, 响应: ${data}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.write(requestData);
      req.end();
    });
  }

  /**
   * 调用通义千问API
   * @param prompt 提示内容
   * @returns AI生成的回复
   */
  private callQwenApi(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const requestData = JSON.stringify({
        model: 'qwen-max',
        input: {
          prompt: prompt
        },
        parameters: {
          max_tokens: 150,
          temperature: 0.7,
          result_format: 'text'
        }
      });
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.qwenApiKey}`
        }
      };
      
      const req = https.request(AiService.QWEN_API_ENDPOINT, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const response = JSON.parse(data);
              const message = response.output.text.trim();
              resolve(message);
            } else {
              reject(new Error(`API请求失败，状态码: ${res.statusCode}, 响应: ${data}`));
            }
          } catch (error) {
            reject(error);
          }
        });
      });
      
      req.on('error', (error) => {
        reject(error);
      });
      
      req.write(requestData);
      req.end();
    });
  }
} 