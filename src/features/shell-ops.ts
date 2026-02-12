import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';

const execAsync = promisify(exec);

export interface ShellCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  shell?: boolean;
}

export interface CommandResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  command: string;
}

export interface ProcessInfo {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startTime: Date;
}

export class ShellOperations {
  private runningProcesses: Map<number, ProcessInfo> = new Map();

  /**
   * 执行shell命令
   */
  async executeCommand(command: string | ShellCommand): Promise<CommandResult> {
    const startTime = Date.now();
    
    try {
      let cmdString: string;
      let options: any = {};
      
      if (typeof command === 'string') {
        cmdString = command;
      } else {
        cmdString = command.command;
        if (command.args) {
          cmdString += ' ' + command.args.join(' ');
        }
        options = {
          cwd: command.cwd,
          env: { ...process.env, ...command.env },
          timeout: command.timeout,
          shell: command.shell ?? true
        };
      }
      
      logger.info(`执行命令: ${cmdString}`);
      if (options.cwd) {
        logger.debug(`工作目录: ${options.cwd}`);
      }
      
      const { stdout, stderr } = await execAsync(cmdString, options);
      const duration = Date.now() - startTime;
      
      const result: CommandResult = {
        success: true,
        exitCode: 0,
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
        duration,
        command: cmdString
      };
      
      this.displayCommandResult(result);
      return result;
      
    } catch (error: any) {
      const duration = Date.now() - startTime;
      
      const result: CommandResult = {
        success: false,
        exitCode: error.code || 1,
        stdout: error.stdout?.trim() || '',
        stderr: error.stderr?.trim() || error.message,
        duration,
        command: typeof command === 'string' ? command : command.command
      };
      
      this.displayCommandResult(result);
      return result;
    }
  }

  /**
   * 执行多个命令
   */
  async executeCommands(commands: (string | ShellCommand)[]): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    
    for (const command of commands) {
      const result = await this.executeCommand(command);
      results.push(result);
      
      // 如果命令失败，停止执行后续命令
      if (!result.success) {
        break;
      }
    }
    
    return results;
  }

  /**
   * 执行命令序列（前一个命令的输出作为后一个命令的输入）
   */
  async executeCommandPipeline(commands: (string | ShellCommand)[]): Promise<CommandResult[]> {
    let previousOutput = '';
    const results: CommandResult[] = [];
    
    for (const command of commands) {
      let cmd: ShellCommand;
      
      if (typeof command === 'string') {
        cmd = { command };
      } else {
        cmd = { ...command };
      }
      
      // 如果前一个命令有输出，将其作为输入
      if (previousOutput && cmd.command.includes('$INPUT')) {
        cmd.command = cmd.command.replace('$INPUT', previousOutput);
      }
      
      const result = await this.executeCommand(cmd);
      results.push(result);
      
      if (!result.success) {
        break;
      }
      
      previousOutput = result.stdout;
    }
    
    return results;
  }

  /**
   * 启动长时间运行的进程
   */
  async startProcess(command: string, args: string[] = [], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    detached?: boolean;
  } = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      logger.info(`启动进程: ${command} ${args.join(' ')}`);
      
      const childProcess = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: options.detached ?? false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      const processInfo: ProcessInfo = {
        pid: childProcess.pid!,
        command,
        args,
        cwd: options.cwd || process.cwd(),
        startTime: new Date()
      };
      
      this.runningProcesses.set(childProcess.pid!, processInfo);
      
      // 处理输出
      childProcess.stdout?.on('data', (data: Buffer) => {
        logger.debug(`[${childProcess.pid}] ${data.toString().trim()}`);
      });
      
      childProcess.stderr?.on('data', (data: Buffer) => {
        logger.warn(`[${childProcess.pid}] ${data.toString().trim()}`);
      });
      
      childProcess.on('error', (error: Error) => {
        logger.error(`进程启动失败: ${error.message}`);
        this.runningProcesses.delete(childProcess.pid!);
        reject(error);
      });
      
      childProcess.on('exit', (code: number | null) => {
        logger.info(`进程 ${childProcess.pid} 已退出，代码: ${code}`);
        this.runningProcesses.delete(childProcess.pid!);
      });
      
      resolve(childProcess.pid!);
    });
  }

  /**
   * 停止运行中的进程
   */
  async stopProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
    const processInfo = this.runningProcesses.get(pid);
    if (!processInfo) {
      logger.warn(`进程 ${pid} 未找到`);
      return false;
    }
    
    try {
      logger.info(`停止进程 ${pid}: ${processInfo.command}`);
      process.kill(pid, signal);
      this.runningProcesses.delete(pid);
      return true;
    } catch (error: any) {
      logger.error(`停止进程失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 获取运行中的进程列表
   */
  getRunningProcesses(): ProcessInfo[] {
    return Array.from(this.runningProcesses.values());
  }

  /**
   * 执行系统信息命令
   */
  async getSystemInfo(): Promise<Record<string, string>> {
    const commands = {
      '操作系统': 'uname -a',
      '内存使用': 'free -h || systeminfo | find "物理内存"',
      '磁盘空间': 'df -h',
      'CPU信息': 'lscpu || sysctl -n machdep.cpu.brand_string',
      '网络信息': 'ip addr show || ifconfig'
    };
    
    const systemInfo: Record<string, string> = {};
    
    for (const [key, command] of Object.entries(commands)) {
      try {
        const result = await this.executeCommand(command);
        systemInfo[key] = result.success ? result.stdout : '无法获取';
      } catch (error) {
        systemInfo[key] = '无法获取';
      }
    }
    
    return systemInfo;
  }

  /**
   * 执行文件查找命令
   */
  async findFiles(pattern: string, directory: string = '.'): Promise<string[]> {
    const command = `find "${directory}" -name "${pattern}" -type f`;
    const result = await this.executeCommand(command);
    
    if (result.success) {
      return result.stdout.split('\n').filter(line => line.trim());
    }
    
    return [];
  }

  /**
   * 执行文本搜索命令
   */
  async searchText(pattern: string, directory: string = '.'): Promise<string[]> {
    const command = `grep -r "${pattern}" "${directory}" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" 2>/dev/null || echo "未找到匹配内容"`;
    const result = await this.executeCommand(command);
    
    if (result.success && result.stdout !== '未找到匹配内容') {
      return result.stdout.split('\n').filter(line => line.trim());
    }
    
    return [];
  }

  /**
   * 显示命令执行结果
   */
  private displayCommandResult(result: CommandResult): void {
    const statusColor = result.success ? 'green' : 'red';
    const statusSymbol = result.success ? '✓' : '✗';
    
    if (result.success) {
        logger.success(`${statusSymbol} 命令执行成功 (${result.duration}ms)`);
    } else {
        logger.error(`${statusSymbol} 命令执行失败 (${result.duration}ms)`);
    }
    
    if (result.stdout) {
      logger.info('输出:');
      logger.raw(result.stdout);
    }
    
    if (result.stderr) {
      logger.warn('错误输出:');
      logger.warn(result.stderr);
    }
    
    if (!result.success) {
      logger.error(`退出代码: ${result.exitCode}`);
    }
    
    logger.raw(''); // 空行分隔
  }

  /**
   * 批量执行命令并返回汇总结果
   */
  async batchExecute(commands: (string | ShellCommand)[], options: {
    stopOnError?: boolean;
    parallel?: boolean;
    maxConcurrent?: number;
  } = {}): Promise<{
    results: CommandResult[];
    successCount: number;
    failureCount: number;
    totalDuration: number;
  }> {
    const stopOnError = options.stopOnError ?? true;
    const parallel = options.parallel ?? false;
    const maxConcurrent = options.maxConcurrent ?? 5;
    
    let results: CommandResult[] = [];
    
    if (parallel) {
      // 并行执行
      const commandPromises = commands.map(cmd => this.executeCommand(cmd));
      results = await Promise.all(commandPromises);
    } else {
      // 串行执行
      for (const command of commands) {
        const result = await this.executeCommand(command);
        results.push(result);
        
        if (stopOnError && !result.success) {
          break;
        }
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;
    const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
    
    
    return {
      results,
      successCount,
      failureCount,
      totalDuration
    };
  }

  /**
   * 清理所有运行中的进程
   */
  async cleanup(): Promise<void> {
    const processes = this.getRunningProcesses();
    
    if (processes.length === 0) {
      logger.debug('没有运行中的进程需要清理');
      return;
    }
    
    logger.info(`清理 ${processes.length} 个运行中的进程...`);
    
    for (const process of processes) {
      await this.stopProcess(process.pid);
    }
    
    logger.success('进程清理完成');
  }
}