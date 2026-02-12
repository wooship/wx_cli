import { readFile, writeFile, mkdir, readdir, stat, copyFile, unlink, rmdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { logger } from '../utils/logger.js';

export interface FileOperation {
  type: 'read' | 'write' | 'copy' | 'move' | 'delete' | 'create-dir';
  path: string;
  content?: string;
  targetPath?: string;
  encoding?: BufferEncoding;
  recursive?: boolean;
}

export interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: Date;
  extension: string | undefined;
}

export class FileOperations {

  /**
   * 读取文件内容
   */
  async readFile(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    try {
      logger.debug(`读取文件: ${path}`);
      const content = await readFile(path, encoding);
      return content;
    } catch (error: any) {
      throw new Error(`读取文件失败: ${error.message}`);
    }
  }

  /**
   * 写入文件内容
   */
  async writeFile(path: string, content: string, encoding: BufferEncoding = 'utf-8'): Promise<void> {
    try {
      logger.debug(`写入文件: ${path}`);
      
      // 确保目录存在
      const dir = dirname(path);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
        logger.debug(`创建目录: ${dir}`);
      }
      
      await writeFile(path, content, encoding);
    } catch (error: any) {
      throw new Error(`写入文件失败: ${error.message}`);
    }
  }

  /**
   * 复制文件或目录
   */
  async copy(source: string, target: string): Promise<void> {
    try {
      const sourceStat = await stat(source);
      
      if (sourceStat.isDirectory()) {
        await this.copyDirectory(source, target);
      } else {
        await this.copyFile(source, target);
      }
    } catch (error: any) {
      throw new Error(`复制失败: ${error.message}`);
    }
  }

  /**
   * 复制文件
   */
  private async copyFile(source: string, target: string): Promise<void> {
    logger.debug(`复制文件: ${source} -> ${target}`);
    
    // 确保目标目录存在
    const targetDir = dirname(target);
    if (!existsSync(targetDir)) {
      await mkdir(targetDir, { recursive: true });
    }
    
    await copyFile(source, target);
  }

  /**
   * 复制目录
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    logger.debug(`复制目录: ${source} -> ${target}`);
    
    // 创建目标目录
    await mkdir(target, { recursive: true });
    
    // 读取源目录内容
    const items = await readdir(source);
    
    for (const item of items) {
      const sourcePath = join(source, item);
      const targetPath = join(target, item);
      
      const itemStat = await stat(sourcePath);
      
      if (itemStat.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        await this.copyFile(sourcePath, targetPath);
      }
    }
  }

  /**
   * 移动文件或目录
   */
  async move(source: string, target: string): Promise<void> {
    try {
      logger.debug(`移动: ${source} -> ${target}`);
      
      // 先复制
      await this.copy(source, target);
      
      // 然后删除源
      await this.delete(source);
    } catch (error: any) {
      throw new Error(`移动失败: ${error.message}`);
    }
  }

  /**
   * 删除文件或目录
   */
  async delete(path: string, recursive: boolean = false): Promise<void> {
    try {
      const pathStat = await stat(path);
      
      if (pathStat.isDirectory()) {
        if (recursive) {
          logger.debug(`删除目录(递归): ${path}`);
          await this.deleteDirectory(path);
        } else {
          logger.debug(`删除目录: ${path}`);
          await rmdir(path);
        }
      } else {
        logger.debug(`删除文件: ${path}`);
        await unlink(path);
      }
    } catch (error: any) {
      throw new Error(`删除失败: ${error.message}`);
    }
  }

  /**
   * 递归删除目录
   */
  private async deleteDirectory(path: string): Promise<void> {
    const items = await readdir(path);
    
    for (const item of items) {
      const itemPath = join(path, item);
      const itemStat = await stat(itemPath);
      
      if (itemStat.isDirectory()) {
        await this.deleteDirectory(itemPath);
      } else {
        await unlink(itemPath);
      }
    }
    
    await rmdir(path);
  }

  /**
   * 创建目录
   */
  async createDirectory(path: string, recursive: boolean = true): Promise<void> {
    try {
      logger.debug(`创建目录: ${path}`);
      await mkdir(path, { recursive });
    } catch (error: any) {
      throw new Error(`创建目录失败: ${error.message}`);
    }
  }

  /**
   * 检查文件或目录是否存在
   */
  exists(path: string): boolean {
    return existsSync(path);
  }

  /**
   * 获取文件信息
   */
  async getFileInfo(path: string): Promise<FileInfo> {
    try {
      const pathStat = await stat(path);
      
      return {
        name: basename(path),
        path: path,
        type: pathStat.isDirectory() ? 'directory' : 'file',
        size: pathStat.size,
        modified: pathStat.mtime,
        extension: pathStat.isDirectory() ? undefined : extname(path)
      };
    } catch (error: any) {
      throw new Error(`获取文件信息失败: ${error.message}`);
    }
  }

  /**
   * 批量执行文件操作
   */
  async executeOperations(operations: FileOperation[]): Promise<void> {
    for (const operation of operations) {
      try {
        await this.executeOperation(operation);
      } catch (error: any) {
        logger.error(`文件操作失败: ${operation.type} ${operation.path}`, error);
        throw error;
      }
    }
  }

  /**
   * 执行单个文件操作
   */
  private async executeOperation(operation: FileOperation): Promise<void> {
    switch (operation.type) {
      case 'read':
        await this.readFile(operation.path, operation.encoding);
        break;
        
      case 'write':
        if (!operation.content) {
          throw new Error('写入操作缺少内容');
        }
        await this.writeFile(operation.path, operation.content, operation.encoding);
        break;
        
      case 'copy':
        if (!operation.targetPath) {
          throw new Error('复制操作缺少目标路径');
        }
        await this.copy(operation.path, operation.targetPath);
        break;
        
      case 'move':
        if (!operation.targetPath) {
          throw new Error('移动操作缺少目标路径');
        }
        await this.move(operation.path, operation.targetPath);
        break;
        
      case 'delete':
        await this.delete(operation.path, operation.recursive);
        break;
        
      case 'create-dir':
        await this.createDirectory(operation.path, operation.recursive);
        break;
        
      default:
        throw new Error(`未知的文件操作类型: ${operation.type}`);
    }
  }

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * 显示文件信息
   */
  displayFileInfo(fileInfo: FileInfo): void {
    const typeSymbol = fileInfo.type === 'directory' ? '📁' : '📄';
    const size = fileInfo.type === 'directory' ? '-' : this.formatFileSize(fileInfo.size);
    const modified = fileInfo.modified.toLocaleString();
    
    logger.raw(
      `${typeSymbol} ${fileInfo.name.padEnd(30)} ${size.padStart(10)} ${modified}`
    );
  }
}