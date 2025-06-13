import * as vscode from 'vscode';
import * as https from 'https';

/**
 * AI服务类，用于生成SVN提交日志
 */

export class AiService {
  private static readonly OPENAI_API_ENDPOINT = 'https://lumos-test.diandian.info/winky/openai/v1/chat/completions';
  private static readonly QWEN_API_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';
  
  // AI模型价格表 (每1000 tokens的价格，单位：美元)
  private static readonly MODEL_PRICING: { [key: string]: { input: number; output: number } } = {
    // OpenAI 模型价格
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-4.1': { input: 0.01, output: 0.03 },
    'gpt-4o': { input: 0.005, output: 0.015 },
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-3.5-turbo': { input: 0.0015, output: 0.002 },
    'gpt-3.5-turbo-16k': { input: 0.003, output: 0.004 },
    
    // 通义千问模型价格 (转换为美元，1美元≈7.2人民币)
    'qwen-max': { input: 0.0024 / 7.2 * 1000, output: 0.0096 / 7.2 * 1000 }, // 0.024元/千token -> $0.33/1k tokens
    'qwen-plus': { input: 0.0008 / 7.2 * 1000, output: 0.002 / 7.2 * 1000 },  // 0.0008元/千token -> $0.11/1k tokens
    'qwen-turbo': { input: 0.0003 / 7.2 * 1000, output: 0.0006 / 7.2 * 1000 }, // 0.0003元/千token -> $0.042/1k tokens
    'qwen-turbo-latest': { input: 0.0003 / 7.2 * 1000, output: 0.0006 / 7.2 * 1000 },
    
    // Claude 模型价格
    'claude-3-opus': { input: 0.015, output: 0.075 },
    'claude-3-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-haiku': { input: 0.00025, output: 0.00125 },
    
    // Gemini 模型价格
    'gemini-pro': { input: 0.0005, output: 0.0015 },
    'gemini-pro-vision': { input: 0.0005, output: 0.0015 },
    
    // 默认价格（未知模型）
    'default': { input: 0.001, output: 0.002 }
  };

  // 汇率常量 (用于显示多种货币)
  private static readonly EXCHANGE_RATES = {
    USD_TO_CNY: 7.2,  // 美元到人民币
    USD_TO_EUR: 0.85, // 美元到欧元
    USD_TO_JPY: 110   // 美元到日元
  };

  // 设置不同模型的最大差异长度限制
  private static readonly MAX_DIFF_LENGTH = {
    openai: 384000,  // 适配128k token模型，约等于384,000字符（1 token ≈ 3字符）
    qwen: 240000    // 通义千问支持更长的文本
  };

  // 默认的API密钥
  private static readonly DEFAULT_QWEN_API_KEY = 'sk-57e28e26cdb247bda6ce970af6d06c7b'; // 替换为您的默认API密钥
  private static readonly DEFAULT_OPENAI_API_KEY = 'sk-yyyyy'; // 替换为您的默认OpenAI API密钥

  private aiModel: string;
  private openaiModel: string;
  private openaiApiKey: string | undefined;
  private qwenApiKey: string | undefined;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    // 从设置中获取配置
    const config = vscode.workspace.getConfiguration('vscode-svn');
    this.aiModel = config.get<string>('aiModel') || 'qwen'; // 默认使用通义千问
    this.openaiModel = config.get<string>('openaiModel') || 'gpt-4.1'; // 新增OpenAI模型名配置
    
    // 优先使用配置的API密钥，如果没有则使用默认值
    const configOpenaiKey = config.get<string>('aiApiKey');
    const configQwenKey = config.get<string>('qwenApiKey');
    
    this.openaiApiKey = configOpenaiKey || AiService.DEFAULT_OPENAI_API_KEY;
    this.qwenApiKey = configQwenKey || AiService.DEFAULT_QWEN_API_KEY;
    
    this.outputChannel = vscode.window.createOutputChannel('SVN AI 生成提交日志');
  }

  /**
   * 计算AI调用成本
   * @param modelName 模型名称
   * @param inputTokens 输入token数量
   * @param outputTokens 输出token数量
   * @returns 成本信息对象
   */
  private calculateCost(modelName: string, inputTokens: number, outputTokens: number) {
    // 获取模型价格，如果找不到则使用默认价格
    const pricing = AiService.MODEL_PRICING[modelName] || AiService.MODEL_PRICING['default'];
    
    // 计算成本 (价格是每1000 tokens)
    const inputCost = (inputTokens / 1000) * pricing.input;
    const outputCost = (outputTokens / 1000) * pricing.output;
    const totalCostUSD = inputCost + outputCost;
    
    // 转换为其他货币
    const totalCostCNY = totalCostUSD * AiService.EXCHANGE_RATES.USD_TO_CNY;
    const totalCostEUR = totalCostUSD * AiService.EXCHANGE_RATES.USD_TO_EUR;
    const totalCostJPY = totalCostUSD * AiService.EXCHANGE_RATES.USD_TO_JPY;
    
    return {
      modelName,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costs: {
        usd: totalCostUSD,
        cny: totalCostCNY,
        eur: totalCostEUR,
        jpy: totalCostJPY
      },
      breakdown: {
        inputCostUSD: inputCost,
        outputCostUSD: outputCost
      }
    };
  }

  /**
   * 估算文本的token数量 (粗略估算)
   * @param text 文本内容
   * @returns 估算的token数量
   */
  private estimateTokens(text: string): number {
    // 简单估算：中文1字符≈1token，英文1单词≈1.3tokens，平均1字符≈0.75tokens
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const otherChars = text.length - chineseChars - englishWords;
    
    return Math.ceil(chineseChars * 1 + englishWords * 1.3 + otherChars * 0.75);
  }

  /**
   * 输出成本信息到控制台
   * @param costInfo 成本信息
   */
  private logCostInfo(costInfo: any) {
    const timestamp = new Date().toLocaleString('zh-CN');
    this.outputChannel.appendLine(`\n=== AI调用成本分析 [${timestamp}] ===`);
    this.outputChannel.appendLine(`模型: ${costInfo.modelName}`);
    this.outputChannel.appendLine(`Token使用: 输入${costInfo.inputTokens} + 输出${costInfo.outputTokens} = 总计${costInfo.totalTokens}`);
    this.outputChannel.appendLine(`成本明细:`);
    this.outputChannel.appendLine(`  输入成本: $${costInfo.breakdown.inputCostUSD.toFixed(6)}`);
    this.outputChannel.appendLine(`  输出成本: $${costInfo.breakdown.outputCostUSD.toFixed(6)}`);
    this.outputChannel.appendLine(`总成本:`);
    this.outputChannel.appendLine(`  美元 (USD): $${costInfo.costs.usd.toFixed(6)}`);
    this.outputChannel.appendLine(`  人民币 (CNY): ¥${costInfo.costs.cny.toFixed(4)}`);
    this.outputChannel.appendLine(`  欧元 (EUR): €${costInfo.costs.eur.toFixed(6)}`);
    this.outputChannel.appendLine(`  日元 (JPY): ¥${costInfo.costs.jpy.toFixed(2)}`);
    this.outputChannel.appendLine(`==========================================\n`);
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
      // 读取最新的模型配置，支持运行时切换
      const config = vscode.workspace.getConfiguration('vscode-svn');
      const model = config.get<string>('openaiModel') || this.openaiModel || 'gpt-4.1';
      
      // 估算输入token数量
      const inputTokens = this.estimateTokens(prompt);
      
      const requestData = JSON.stringify({
        model: model, // 使用可配置的模型名
        messages: [
          {
            role: 'system',
            content: '你是一个专业的代码提交信息生成助手。请根据提供的代码差异生成简洁、准确的中文提交信息。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
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
              const content = response.choices[0].message.content.trim();
              
              // 估算输出token数量
              const outputTokens = this.estimateTokens(content);
              
              // 计算并输出成本
              const costInfo = this.calculateCost(model, inputTokens, outputTokens);
              this.logCostInfo(costInfo);
              
              resolve(content);
            } else {
              this.outputChannel.appendLine(`OpenAI API调用失败 - 状态码: ${res.statusCode}`);
              this.outputChannel.appendLine(`请求数据: ${requestData}`);
              this.outputChannel.appendLine(`响应数据: ${data}`);
              reject(new Error(`OpenAI API调用失败: ${res.statusCode} - ${data}`));
            }
          } catch (error: any) {
            this.outputChannel.appendLine(`OpenAI API响应解析失败: ${error.message}`);
            this.outputChannel.appendLine(`请求数据: ${requestData}`);
            this.outputChannel.appendLine(`响应数据: ${data}`);
            reject(new Error(`OpenAI API响应解析失败: ${error.message}`));
          }
        });
      });

      req.on('error', (error: any) => {
        this.outputChannel.appendLine(`OpenAI API网络请求失败: ${error.message}`);
        this.outputChannel.appendLine(`请求数据: ${requestData}`);
        reject(new Error(`OpenAI API网络请求失败: ${error.message}`));
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
      // 估算输入token数量
      const inputTokens = this.estimateTokens(prompt);
      
      const requestData = JSON.stringify({
        model: 'qwen-turbo-latest',
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
              if (response.output && response.output.text) {
                const content = response.output.text.trim();
                
                // 估算输出token数量
                const outputTokens = this.estimateTokens(content);
                
                // 计算并输出成本
                const costInfo = this.calculateCost('qwen-turbo-latest', inputTokens, outputTokens);
                this.logCostInfo(costInfo);
                
                resolve(content);
              } else {
                this.outputChannel.appendLine(`通义千问API响应格式错误`);
                this.outputChannel.appendLine(`请求数据: ${requestData}`);
                this.outputChannel.appendLine(`响应数据: ${data}`);
                reject(new Error('通义千问API响应格式错误'));
              }
            } else {
              this.outputChannel.appendLine(`通义千问API调用失败 - 状态码: ${res.statusCode}`);
              this.outputChannel.appendLine(`请求数据: ${requestData}`);
              this.outputChannel.appendLine(`响应数据: ${data}`);
              reject(new Error(`通义千问API调用失败: ${res.statusCode} - ${data}`));
            }
          } catch (error: any) {
            this.outputChannel.appendLine(`通义千问API响应解析失败: ${error.message}`);
            this.outputChannel.appendLine(`请求数据: ${requestData}`);
            this.outputChannel.appendLine(`响应数据: ${data}`);
            reject(new Error(`通义千问API响应解析失败: ${error.message}`));
          }
        });
      });

      req.on('error', (error: any) => {
        this.outputChannel.appendLine(`通义千问API网络请求失败: ${error.message}`);
        this.outputChannel.appendLine(`请求数据: ${requestData}`);
        reject(new Error(`通义千问API网络请求失败: ${error.message}`));
      });

      req.write(requestData);
      req.end();
    });
  }
} 