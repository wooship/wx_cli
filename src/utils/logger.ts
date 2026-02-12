import chalk, { ChalkInstance } from 'chalk';

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

export class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private log(level: LogLevel, color: ChalkInstance, prefix: string, message: string, ...args: any[]): void {
    if (this.level >= level) {
      const argsString = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
      const formattedMessage = `${prefix} ${message} ${argsString}`.trim();
      console.log(color(formattedMessage));
    }
  }

  error(message: string, ...args: any[]): void {
    this.log(LogLevel.ERROR, chalk.redBright, '[ERROR]', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log(LogLevel.WARN, chalk.yellow, '[WARN]', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.log(LogLevel.INFO, chalk.cyan, '[INFO]', message, ...args);
  }

  debug(message: string, ...args: any[]): void {
    this.log(LogLevel.DEBUG, chalk.gray, '[DEBUG]', message, ...args);
  }

  success(message: string, ...args: any[]): void {
    this.log(LogLevel.INFO, chalk.green, '[SUCCESS]', message, ...args);
  }

  // 直接输出，不带前缀和颜色
  raw(message: string): void {
    console.log(message);
  }
}

export const logger = new Logger();