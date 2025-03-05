import * as vscode from 'vscode';
import * as https from 'https';

/**
 * AI服务类，用于生成SVN提交日志
 */
export class AiService {
  private static readonly OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
  private static readonly QWEN_API_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
  // 设置不同模型的最大差异长度限制
  private static readonly MAX_DIFF_LENGTH = {
    openai: 12000,  // GPT-3.5 约 4096 tokens，按平均一个token 3个字符计算
    qwen: 240000    // 通义千问支持更长的文本
  };

  // 默认的API密钥
  private static readonly DEFAULT_QWEN_API_KEY = 'sk-57e28e26cdb247bda6ce970af6d06c7b'; // 替换为您的默认API密钥
  private static readonly DEFAULT_OPENAI_API_KEY = 'sk-yyyyy'; // 替换为您的默认OpenAI API密钥

  private aiModel: string;
  private openaiApiKey: string | undefined;
  private qwenApiKey: string | undefined;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    // 从设置中获取配置
    const config = vscode.workspace.getConfiguration('vscode-svn');
    this.aiModel = config.get<string>('aiModel') || 'qwen'; // 默认使用通义千问
    
    // 优先使用配置的API密钥，如果没有则使用默认值
    const configOpenaiKey = config.get<string>('aiApiKey');
    const configQwenKey = config.get<string>('qwenApiKey');
    
    this.openaiApiKey = configOpenaiKey || AiService.DEFAULT_OPENAI_API_KEY;
    this.qwenApiKey = configQwenKey || AiService.DEFAULT_QWEN_API_KEY;
    
    this.outputChannel = vscode.window.createOutputChannel('SVN AI 生成提交日志');
  }

  /**
   * 生成SVN提交日志
   * @param diffContent SVN差异内容
   * @returns 生成的提交日志
   */
  public async generateCommitMessage(diffContent: string): Promise<string> {
    try {
      // 检查是否需要配置API密钥
      if (this.aiModel === 'openai' && !this.openaiApiKey) {
        const setApiKey = await vscode.window.showInformationMessage(
          '是否要设置自定义的OpenAI API密钥？（当前使用默认密钥）',
          '设置API密钥',
          '使用默认密钥',
          '切换到通义千问',
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
            // 如果用户取消输入，使用默认密钥
            this.openaiApiKey = AiService.DEFAULT_OPENAI_API_KEY;
          }
        } else if (setApiKey === '使用默认密钥') {
          this.openaiApiKey = AiService.DEFAULT_OPENAI_API_KEY;
        } else if (setApiKey === '切换到通义千问') {
          await vscode.workspace.getConfiguration('vscode-svn').update('aiModel', 'qwen', vscode.ConfigurationTarget.Global);
          this.aiModel = 'qwen';
        } else {
          return '';
        }
      } else if (this.aiModel === 'qwen' && !this.qwenApiKey) {
        const setApiKey = await vscode.window.showInformationMessage(
          '是否要设置自定义的通义千问API密钥？（当前使用默认密钥）',
          '设置API密钥',
          '使用默认密钥',
          '取消'
        );

        if (setApiKey === '设置API密钥') {
          const apiKey = await vscode.window.showInputBox({
            prompt: '请输入您的通义千问API密钥',
            password: true,
            placeHolder: 'sk-...'
          });
          
          if (apiKey) {
            await vscode.workspace.getConfiguration('vscode-svn').update('qwenApiKey', apiKey, vscode.ConfigurationTarget.Global);
            this.qwenApiKey = apiKey;
          } else {
            // 如果用户取消输入，使用默认密钥
            this.qwenApiKey = AiService.DEFAULT_QWEN_API_KEY;
          }
        } else if (setApiKey === '使用默认密钥') {
          this.qwenApiKey = AiService.DEFAULT_QWEN_API_KEY;
        } else {
          return '';
        }
      }
      
      // 准备发送给AI的提示
      const prompt = this.preparePrompt(diffContent);
      this.outputChannel.appendLine(`[generateCommitMessage] 提示内容: ${prompt}`);
      this.outputChannel.appendLine(`[generateCommitMessage] 使用的AI模型: ${this.aiModel}`);
      this.outputChannel.appendLine(`[generateCommitMessage] 是否使用默认密钥: ${
        this.aiModel === 'openai' 
          ? this.openaiApiKey === AiService.DEFAULT_OPENAI_API_KEY
          : this.qwenApiKey === AiService.DEFAULT_QWEN_API_KEY
      }`);
      
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
    // 根据当前使用的AI模型获取最大长度限制
    const maxDiffLength = AiService.MAX_DIFF_LENGTH[this.aiModel as keyof typeof AiService.MAX_DIFF_LENGTH] || 12000;
    
    this.outputChannel.appendLine(`[preparePrompt] 当前AI模型: ${this.aiModel}`);
    this.outputChannel.appendLine(`[preparePrompt] 差异内容长度: ${diffContent.length}`);
    this.outputChannel.appendLine(`[preparePrompt] 最大允许长度: ${maxDiffLength}`);
    
    let truncatedDiff = diffContent;
    if (diffContent.length > maxDiffLength) {
      truncatedDiff = diffContent.substring(0, maxDiffLength) + '\n...(内容已截断，完整差异过长)';
      this.outputChannel.appendLine(`[preparePrompt] 差异内容已截断到 ${maxDiffLength} 字符`);
    }
    
    return `你是一个专业的SVN提交日志生成助手。请根据以下SVN差异内容，生成一个详细的提交日志。

要求：
1. 按文件名分段落输出，每个文件的修改内容单独一段
2. 每个文件段落的格式如下：
   - 第一行：文件名
   - 第二行开始：总结重点，分点说明修改内容 简答 易懂，每个要点一行

3. 分析要点应包含：
   - 修改了什么功能或内容
   - 修改的目的或原因
   - 可能产生的影响
   - 忽略无用的修改分析 例如只是一些换行, 空格, 等

4. 对于每个文件的修改，要根据实际意义换行显示，使日志更易读
5. 使用中文，内容简单清晰

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
        model: 'qwen-turbo',
        input: {
          prompt: prompt
        },
        parameters: {
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