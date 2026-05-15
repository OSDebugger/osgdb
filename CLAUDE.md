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

## launch.json 配置示例（被调试项目rCore）

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "ardb",
            "request": "attach",
            "name": "Attach to Qemu",
            "autorun": ["add-symbol-file ${workspaceFolder}/os/target/riscv64gc-unknown-none-elf/release/os"],
            "target": ":1234",
            "remote": true,
            "cwd": "${workspaceFolder}",
            "valuesFormatting": "parseText",
            "gdbpath": "riscv64-unknown-elf-gdb",
            "showDevDebugOutput":true,
            "internalConsoleOptions": "openOnSessionStart",
            "printCalls": true,
            "stopAtConnect": true,
            //"debugServer": 4711,
            "qemuPath": "${workspaceFolder}/qemu-system-riscv64-with-logs.sh",
            "qemuArgs": [
                "-M",
                "128m",
                "-machine",
                "virt",
                "-bios",
                "${workspaceFolder}/bootloader/rustsbi-qemu.bin",
                "-display",
                "none",
                "-device",
                "loader,file=${workspaceFolder}/os/target/riscv64gc-unknown-none-elf/release/os.bin,addr=0x80200000",
                "-drive",
                "file=${workspaceFolder}/user/target/riscv64gc-unknown-none-elf/release/fs.img,if=none,format=raw,id=x0",
                "-device",
                "virtio-blk-device,drive=x0",
                "-device",
                "virtio-gpu-device",
                "-device",
                "virtio-keyboard-device",
                "-device",
                "virtio-mouse-device",
                "-device",
                "virtio-net-device,netdev=net0",
                "-netdev",
                "user,id=net0,hostfwd=udp::6200-:2000,hostfwd=tcp::6201-:80",
                "-serial",
                "stdio",
                "-serial",
                "pty",
                "-s",
                "-S"
            ],
            "program_counter_id": 32,
            "first_breakpoint_group": "kernel",
            "second_breakpoint_group":"${workspaceFolder}/user/src/bin/initproc.rs",
            "kernel_memory_ranges":[["0x80000000","0xffffffffffffffff"]],
            "user_memory_ranges":[["0x0000000000000000","0x80000000"]],
            "border_breakpoints":[
                {
                    "filepath": "${workspaceFolder}/user/src/syscall.rs",
                    "line": 39
                },
                {
                    "filepath": "${workspaceFolder}/os/src/trap/mod.rs",
                    "line": 135
                }
            ],
            "hook_breakpoints":[
                {
                    "breakpoint": {
                        "file": "${workspaceFolder}/os/src/syscall/process.rs",
                        "line": 47
                    },
                    "behavior": {
                        "isAsync": true,
                        "functionArguments": "",
                        "functionBody": "let p=await this.getStringVariable('path'); return '${workspaceFolder}/user/src/bin/'+p+'.rs'"
                    }
                }
            ],
            "filePathToBreakpointGroupNames":{
                "isAsync": false,
                "functionArguments": "filePathStr",
                "functionBody": "     if (filePathStr.includes('os/src')) {        return ['kernel'];    }    else if (filePathStr.includes('user/src/bin')) {        return [filePathStr];    }    else if (!filePathStr.includes('user/src/bin') && filePathStr.includes('user/src')) {        return ['${workspaceFolder}/user/src/bin/adder_atomic.rs', '${workspaceFolder}/user/src/bin/adder_mutex_blocking.rs', '${workspaceFolder}/user/src/bin/adder_mutex_spin.rs', '${workspaceFolder}/user/src/bin/adder_peterson_spin.rs', '${workspaceFolder}/user/src/bin/adder_peterson_yield.rs', '${workspaceFolder}/user/src/bin/adder.rs', '${workspaceFolder}/user/src/bin/adder_simple_spin.rs', '${workspaceFolder}/user/src/bin/adder_simple_yield.rs', '${workspaceFolder}/user/src/bin/barrier_condvar.rs', '${workspaceFolder}/user/src/bin/barrier_fail.rs', '${workspaceFolder}/user/src/bin/cat.rs', '${workspaceFolder}/user/src/bin/cmdline_args.rs', '${workspaceFolder}/user/src/bin/condsync_condvar.rs', '${workspaceFolder}/user/src/bin/condsync_sem.rs', '${workspaceFolder}/user/src/bin/count_lines.rs', '${workspaceFolder}/user/src/bin/eisenberg.rs', '${workspaceFolder}/user/src/bin/exit.rs', '${workspaceFolder}/user/src/bin/fantastic_text.rs', '${workspaceFolder}/user/src/bin/filetest_simple.rs', '${workspaceFolder}/user/src/bin/forktest2.rs', '${workspaceFolder}/user/src/bin/forktest.rs', '${workspaceFolder}/user/src/bin/forktest_simple.rs', '${workspaceFolder}/user/src/bin/forktree.rs', '${workspaceFolder}/user/src/bin/gui_rect.rs', '${workspaceFolder}/user/src/bin/gui_simple.rs', '${workspaceFolder}/user/src/bin/gui_snake.rs', '${workspaceFolder}/user/src/bin/gui_uart.rs', '${workspaceFolder}/user/src/bin/hello_world.rs', '${workspaceFolder}/user/src/bin/huge_write_mt.rs', '${workspaceFolder}/user/src/bin/huge_write.rs', '${workspaceFolder}/user/src/bin/infloop.rs', '${workspaceFolder}/user/src/bin/initproc.rs', '${workspaceFolder}/user/src/bin/inputdev_event.rs', '${workspaceFolder}/user/src/bin/matrix.rs', '${workspaceFolder}/user/src/bin/mpsc_sem.rs', '${workspaceFolder}/user/src/bin/peterson.rs', '${workspaceFolder}/user/src/bin/phil_din_mutex.rs', '${workspaceFolder}/user/src/bin/pipe_large_test.rs', '${workspaceFolder}/user/src/bin/pipetest.rs', '${workspaceFolder}/user/src/bin/priv_csr.rs', '${workspaceFolder}/user/src/bin/priv_inst.rs', '${workspaceFolder}/user/src/bin/race_adder_arg.rs', '${workspaceFolder}/user/src/bin/random_num.rs', '${workspaceFolder}/user/src/bin/run_pipe_test.rs', '${workspaceFolder}/user/src/bin/sleep.rs', '${workspaceFolder}/user/src/bin/sleep_simple.rs', '${workspaceFolder}/user/src/bin/stackful_coroutine.rs', '${workspaceFolder}/user/src/bin/stackless_coroutine.rs', '${workspaceFolder}/user/src/bin/stack_overflow.rs', '${workspaceFolder}/user/src/bin/store_fault.rs', '${workspaceFolder}/user/src/bin/sync_sem.rs', '${workspaceFolder}/user/src/bin/tcp_simplehttp.rs', '${workspaceFolder}/user/src/bin/threads_arg.rs', '${workspaceFolder}/user/src/bin/threads.rs', '${workspaceFolder}/user/src/bin/udp.rs', '${workspaceFolder}/user/src/bin/until_timeout.rs', '${workspaceFolder}/user/src/bin/user_shell.rs', '${workspaceFolder}/user/src/bin/usertests.rs', '${workspaceFolder}/user/src/bin/yield.rs'];    }    else        return ['kernel'];"
            },
            "breakpointGroupNameToDebugFilePaths":{
                "isAsync": false,
                "functionArguments": "groupName",
                "functionBody": "if (groupName === 'kernel') {        return ['${workspaceFolder}/os/target/riscv64gc-unknown-none-elf/release/os'];    }    else {        let pathSplited = groupName.split('/');        let filename = pathSplited[pathSplited.length - 1].split('.');        let filenameWithoutExtension = filename[filename.length - 2];        return ['${workspaceFolder}/user/target/riscv64gc-unknown-none-elf/release/' + filenameWithoutExtension];    }"
            }
        }
    ]
}
```
