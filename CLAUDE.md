# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

osgdb 是一个 VSCode 调试扩展，专门用于调试运行在 QEMU 上的操作系统（如 rCore、StarryOS）。扩展类型为 `ardb`，通过 GDB remote 协议连接 QEMU 的 GDB stub，实现内核态/用户态断点组自动切换。

工作区结构：
- `code-debug/` — 扩展本体（TypeScript）
- `docker/` — 提供 QEMU + riscv 工具链的容器环境

## 常用命令

所有命令在 `code-debug/` 目录下执行：

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 运行 OS 状态机单元测试
node out/test/testOSStateMachine.js

# 运行 OS 调试流程集成测试
node out/test/testOSDebugFlow.js
```

运行扩展：在 VSCode 中打开 osgdb 根目录，按 F5 启动扩展开发宿主窗口，在新窗口中使用 `"type": "ardb"` 配置调试目标。

## 架构

### 请求入口链路

```
VSCode UI
  → extension.ts         注册 ardb 类型、OS 调试命令
  → debugAdapter.ts      ARDDebugAdapterFactory，inline 方式托管 GDBDebugSession
  → gdbDebugSession.ts   核心会话，处理所有 DAP 请求
  → backend/mi2.ts       MI2 协议层，与 GDB 进程通信
```

### OS 调试核心机制

OS 调试的难点是内核态和用户态使用不同的符号表和断点集合，切换时需要自动替换。实现分三层：

**1. 状态机 (`OSStateMachine.ts`)**

四状态机：`kernel` → `kernel_single_step_to_user` → `user` → `user_single_step_to_kernel` → `kernel`。每次 GDB 停止事件触发 `STOPPED`，状态机决定执行哪些 `DebuggerActions`。关键 action：
- `check_stop_in_kernel`：检查是否命中 hook/border/普通断点，决定是继续执行还是暂停给用户
- `check_if_user_yet` / `check_if_kernel_yet`：单步期间轮询 PC 寄存器判断是否已跨越地址空间边界
- `low/high_level_switch_breakpoint_group_*`：切换断点组并继续执行

**2. 断点组 (`breakpointGroups.ts`)**

`BreakpointGroups` 管理多个具名断点组（通常为 `kernel` 和进程名如 `initproc`）。切换时：清除旧组的 GDB 断点 → 卸载旧符号文件 → 加载新符号文件 → 恢复新组断点。通过 `IBreakpointGroupsSession` 接口与 `GDBDebugSession` 解耦，可独立测试。

**3. 地址空间判断 (`addrSpace.ts`)**

使用 BigInt 解析 64 位地址，避免 `Number` 精度丢失。`kernel_memory_ranges` / `user_memory_ranges` 在 `launch.json` 中配置，格式为 `[start, end)` 半开区间的十六进制字符串对。

### 两类特殊断点

- **Border 断点**：标记内核/用户态切换位置（如 `trap_return`、`ecall`）。命中时不暂停，触发状态机进入单步模式，直到 PC 跨越地址边界。
- **Hook 断点**：命中时执行一段 JS 函数（在 `launch.json` 中以 `functionBody` 字符串定义），返回值作为下一个断点组的名称（即将要切换到的进程名），执行完后自动 continue，对用户透明。

两类断点均需在程序执行到达该位置**之前**注册，推荐写在 `launch.json` 的 `border_breakpoints` / `hook_breakpoints` 字段中，在 `attachRequest` 阶段即完成注册。

### MI2 协议层 (`backend/mi2.ts`)

封装 GDB/MI 协议。关键方法：
- `getSomeRegisterValues(ids)` — 返回 `RegisterValue[]`（含 `value` 字段，十六进制字符串）
- `getStack(start, max, threadId)` — 获取调用栈
- `stepInstruction()` / `continue()` — 单步/继续

### 测试

测试文件直接编译为 Node.js 脚本运行，不依赖 VSCode 运行时：
- `testOSStateMachine.ts` — 纯状态机转换逻辑
- `testOSDebugFlow.ts` — 用 `MockMI2` 模拟 GDB 后端，测试完整的 `doAction` + 状态转换流程
- `testMIParser.ts` — MI2 协议解析

## launch.json 配置示例（被调试项目）

```json
{
  "type": "ardb",
  "request": "attach",
  "name": "OS Debug",
  "cwd": "${workspaceFolder}",
  "target": ":1234",
  "qemuPath": "qemu-system-riscv64",
  "qemuArgs": ["-M", "virt", "-nographic", "-s", "-S"],
  "executable": "${workspaceFolder}/os/target/riscv64gc-unknown-none-elf/release/os",
  "first_breakpoint_group": "kernel",
  "program_counter_id": 32,
  "kernel_memory_ranges": [["0xffffffc000000000", "0xffffffffffffffff"]],
  "user_memory_ranges": [["0x0000000000000000", "0x0000004000000000"]],
  "border_breakpoints": [
    { "filepath": "/path/to/os/src/trap/mod.rs", "line": 42 }
  ],
  "hook_breakpoints": [
    {
      "breakpoint": { "file": "/path/to/os/src/task/mod.rs", "line": 100 },
      "behavior": {
        "functionArguments": "",
        "functionBody": "return Promise.resolve('initproc')",
        "isAsync": false
      }
    }
  ]
}
```
