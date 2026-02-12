# wx-cli

> A simple&pure AI CLI tool with OpenAI API support, Todo Planning, and MCP integration

一个简单纯净的 AI 命令行工具，支持 OpenAI API、智能任务规划、MCP（Model Context Protocol）集成和自动化执行。

## 核心特性

- 🤖 **AI 驱动**: 基于 OpenAI GPT 模型的智能交互
- 📋 **智能任务规划**: 自动分解用户目标为可执行的子任务序列
- 🔌 **MCP 集成**: 支持通过 MCP 协议访问浏览器操作等工具
- ⚡ **自适应执行**: 子任务失败时自动重新规划后续策略
- 🔄 **累积经验**: 记录历史失败及建议，避免重复错误
- 🎯 **结果验证**: LLM 自动验证子任务执行结果
- 🎨 **友好界面**: 彩色交互式命令行界面
- 📊 **任务追踪**: 实时显示任务进度和执行状态

## 目录

- [安装](#安装)
- [配置](#配置)
- [快速开始](#快速开始)
- [核心架构](#核心架构)
- [使用示例](#使用示例)
- [开发](#开发)
- [许可证](#许可证)

## 安装

### 前置要求

- Node.js >= 20.19.0

### 全局安装

```bash
npm install -g wx-cli
```

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/wooship/wx_cli.git
cd wx_cli

# 安装依赖
npm install

# 构建项目
npm run build

# 运行
npm start
```

## 配置

配置文件位于 `~/.wx-cli/config.json`，首次运行时会自动创建。

### OpenAI API 配置

```json
{
  "models": {
    "default": "gpt-4",
    "available": {
      "gpt-4": {
        "apiKey": "your-api-key-here",
        "baseUrl": "https://api.openai.com/v1",
        "modelName": "gpt-4"
      }
    }
  }
}
```

支持环境变量：
- `OPENAI_API_KEY`: OpenAI API 密钥
- `OPENAI_BASE_URL`: 自定义 API 端点

### MCP 服务器配置

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-chrome-devtools"]
    }
  }
}
```

## 快速开始

### 基础使用

```bash
# 启动交互模式
wx-cli

# 输入自然语言指令
> 查询今日金价

# 项目自动化
> 创建一个名为 my-project 的 TypeScript 项目并初始化 git

# 系统操作
> 列出当前目录下的所有 .ts 文件
```

### 命令行参数

```bash
wx-cli [command] [options]

# 查看帮助
wx-cli --help

# 配置管理
wx-cli config reset    # 重置配置
wx-cli config show      # 显示配置路径
```

## 核心架构

### 任务执行流程

```
用户输入
   ↓
[1] 任务分解 (TaskDecomposer)
   - LLM 分析用户目标
   - 生成初始子任务序列
   
   ↓
[2] 执行循环
   ├─ 取出子任务
   ├─ 执行命令 (CommandExecutor)
   │   ├─ Shell 命令
   │   ├─ 文件操作  
   │   └─ MCP 工具调用
   │
   ├─ LLM 结果验证
   │   - 检查是否达到预期
   │   - 生成补救建议
   │
   ├─ 数据写入 Context
   │   ├─ MCP 调用结果
   │   ├─ Shell 输出
   │   └─ 累积建议
   │
   └─ 失败处理
       ├─ 保留执行数据
       ├─ 累积历史建议
       └─ 重新规划后续任务
       
   ↓
[3] 目标验证
   - 检查总体目标是否完成
   - 生成最终总结
```

### 模块结构

```
src/
├── cli/                 # 命令行界面
│   └── interactive.ts  # 交互模式
├── core/                # 核心模块
│   ├── config.ts       # 配置管理
│   └── model.ts       # AI 模型接口
├── features/            # 功能模块
│   ├── command-executor.ts      # 命令执行器
│   ├── command-translator.ts    # 命令转换
│   ├── file-ops.ts             # 文件操作
│   ├── shell-ops.ts            # Shell 操作
│   ├── task-decomposer.ts       # 任务分解器
│   ├── smart-interaction.ts     # 智能交互
│   ├── types.ts                 # 类型定义
│   └── mcp/                     # MCP 集成
│       └── client.ts           # MCP 客户端
└── utils/               # 工具模块
    └── logger.ts        # 日志系统
```

## 使用示例

### 示例 1: 查询金价信息

```bash
$ wx-cli
> 查询今日金价

📋 任务计划:
目标: 查询今日金价
待执行任务 (3 个):

  1. 打开百度首页
  2. 在搜索框输入"今日金价"
  3. 点击搜索按钮

▶[1] 打开百度首页
  验证: 页面加载成功

▶[2] 在搜索框输入"今日金价"  
  验证: 搜索框填充成功

▶[3] 点击搜索按钮
  验证: 搜索结果页面加载成功

✓ 已为您获取今日金价信息，包含周大福、老凤祥等品牌金价（550-580元/克）及国际金价走势图。

=== 任务执行汇总 ===
最终状态: COMPLETED
总耗时: 35000ms
成功: 3 | 失败: 0
====================
```

### 示例 2: 任务失败并自动重新规划

```bash
> 访问 https://example.com 并获取标题

📋 任务计划:
目标: 访问 https://example.com 并获取标题
待执行任务 (2 个):

  1. 使用浏览器访问 https://example.com
  2. 提取页面标题

▶[1] 使用浏览器访问 https://example.com
✗ 子任务失败: 页面加载超时
  建议: 检查网络连接或增加超时时间

🔄 重新规划后续任务，共 3 个:

  1. 检查网络连接
  2. 使用 ping 测试目标站点
  3. 使用浏览器访问 https://example.com
  ...
```

### 示例 3: 多步骤自动化

```bash
> 创建一个 TypeScript 项目，初始化 git，添加 README

✓ [1] 创建项目目录 project-demo
✓ [2] 初始化 npm 项目
✓ [3] 安装 TypeScript 依赖
✓ [4] 创建 tsconfig.json
✓ [5] 初始化 git 仓库
✓ [6] 创建 README.md 文件

✓ 项目及仓库初始化完成
```

### 示例 4: MCP 浏览器自动化

```bash
# 使用 MCP Chrome DevTools 进行浏览器操作
> 打开百度首页，搜索"AI 工具"，截图保存

[INFO] 调用 MCP 工具: chrome-devtools/navigate_to_url
[INFO] 页面导航成功

[INFO] 调用 MCP 工具: chrome-devtools/click
[INFO] 点击操作成功

✓ 浏览器操作完成，截图已保存
```

### 示例 5: Shell 命令组合

```bash
> 找出所有 .log 文件，提取错误信息，生成报告

✓ [1] 查找所有 .log 文件
✓ [2] 提取错误级别为 ERROR 的日志
✓ [3] 按错误类型分组统计
✓ [4] 生成错误报告

=== 任务执行汇总 ===
最终状态: COMPLETED
总耗时: 5000ms
成功: 4 | 失败: 0
====================
```

## 开发

### 项目结构

```
wx_cli/
├── src/                 # 源代码
│   ├── cli/            # CLI 界面
│   ├── core/           # 核心功能
│   ├── features/       # 功能模块
│   └── utils/          # 工具函数
├── dist/               # 编译输出
├── bin/                # 可执行文件
├── package.json
├── tsconfig.json
└── README.md
```

### 开发命令

```bash
# 开发模式（支持热重载）
npm run dev

# 构建
npm run build

# 运行测试
npm test

# 代码检查
npm run lint
```

### 核心 API

#### SmartInteraction

主要交互类，处理用户输入和任务执行：

```typescript
import { SmartInteraction } from './features/smart-interaction.js';

const interaction = new SmartInteraction(
  taskDecomposer,
  commandTranslator,
  commandExecutor,
  modelManager,
  mcpClient
);

const result = await interaction.processInput("你的目标", {
  autoExecute: true,
  confirmRiskyOperations: true
});

console.log(result.success); // 布尔值
console.log(result.execution); // 执行结果详情
```

#### TaskDecomposer

任务分解器，使用 LLM 将用户目标分解为子任务：

```typescript
const initialPlan = await taskDecomposer.createInitialPlan("查询今日金价");
console.log(initialPlan.subTasks); // [SubTask, SubTask, ...]

// 失败后重新规划
const newPlan = await taskDecomposer.replanWithFeedback(
  subTaskResult,
  context,
  errorReason,
  suggestion
);
```

#### MCPClient

MCP 协议客户端：

```typescript
import { MultiServerMCPClient } from './features/mcp/client.js';

const mcpClient = new MultiServerMCPClient({
  'chrome-devtools': {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-chrome-devtools']
  }
});

await mcpClient.connect();
const result = await mcpClient.callTool('chrome-devtools', 'navigate_to_url', {
  url: 'https://example.com'
});
```

### 扩展开发

#### 添加新的任务类型

1. 在 `src/features/types.ts` 中扩展 `SubTask` 类型
2. 在 `src/features/command-translator.ts` 中添加翻译逻辑
3. 在 `src/features/command-executor.ts` 中添加执行器

#### 添加 MCP 服务器

在 `~/.wx-cli/config.json` 中配置：

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"]
    }
  }
}
```

## 技术细节

### 任务执行机制

1. **任务分解**: LLM 分析用户目标，生成原子任务序列
2. **串行执行**: 任务按顺序执行，每个任务完成后才继续下一个
3. **数据传递**: 每个任务的输出（MCP 结果、Shell 输出）写入 `context.accumulatedData`
4. **结果验证**: LLM 根据任务的 `successCriteria` 验证执行结果
5. **智能重规划**: 失败时，基于历史数据和建议重新规划后续任务

### Context 数据流

```typescript
interface TaskContext {
  originalGoal: string;           // 用户原始目标
  pendingTasks: SubTask[];        // 待执行任务队列
  completedTasks: SubTaskResult[]; // 已完成任务历史
  accumulatedData: Record<string, any>;  // 累积的输出数据
  lastOutput?: OutputData;        // 上一个任务的输出
  lastError?: ErrorInfo;          // 最近错误信息
  accumulatedSuggestions: Array<SuggestionRecord>;  // 历史建议
  // ...
}
```

### 失败处理策略

当子任务失败时：
1. **保留数据**: MCP 调用结果、Shell 输出等写入 `accumulatedData`
2. **记录建议**: LLM 建议写入 `accumulatedSuggestions`
3. **重新规划**: 调用 `replanWithFeedback()` 生成新的任务序列
4. **继续执行**: 从新的任务列表继续执行

## 常见问题

### Q: 如何配置多个 AI 模型？

A: 编辑 `~/.wx-cli/config.json`，在 `models.available` 中添加多个模型配置：

```json
{
  "models": {
    "available": {
      "gpt-4": {
        "apiKey": "...",
        "modelName": "gpt-4"
      },
      "gpt-3.5-turbo": {
        "apiKey": "...",
        "modelName": "gpt-3.5-turbo"
      }
    }
  }
}
```

### Q: MCP 连接失败怎么办？

A: 检查以下几点：
1. MCP 服务器配置是否正确
2. 网络连接是否正常
3. MCP 服务器是否已启动

查看日志了解详细错误信息。

### Q: 如何查看详细日志？

A: wx-cli 使用 Winston 日志系统。日志级别可通过环境变量或配置文件控制。

## 贡献

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 作者

wx-cli Team

## 致谢

- [OpenAI](https://openai.com/) - 提供 GPT 模型 API
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 协议
- [TypeScript](https://www.typescriptlang.org/) - 项目构建语言

---

⭐ 如果这个项目对你有帮助，请给它一个星标!
