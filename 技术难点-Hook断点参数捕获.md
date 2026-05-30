# 技术难点：Hook 断点中动态获取 Rust String 变量

## 问题背景

在 OS 调试器中，我们需要实现 Hook 断点功能：当内核执行 `sys_execve` 系统调用时，自动捕获被执行程序的路径（`path` 参数），并动态切换到对应用户程序的断点组。这要求调试器能够在运行时从 GDB 读取 Rust `String` 类型变量的内容。

## 遇到的困难

### 困难1：Rust String 内部结构依赖 Rust 版本

Rust 的 `alloc::string::String` 类型在不同版本中内部字段路径不同：

**旧版 Rust（rCore 使用）：**
```
String.vec.buf.ptr.pointer.pointer  → 字符串数据指针
String.vec.len                       → 字符串长度
```

**新版 Rust（StarryOS 使用）：**
```
String.vec.buf.inner.ptr.pointer.pointer  → 字符串数据指针（多了 inner 层）
String.vec.len                             → 字符串长度
```

如果硬编码字段路径，调试器只能支持一个 Rust 版本，无法同时调试 rCore 和 StarryOS。

### 困难2：GDB MI 协议中 console 输出与命令的关联问题

最初尝试用 `interpreter-exec console "p path"` 让 GDB 打印变量，然后从输出中解析 `pointer` 和 `len`，这样可以完全绕开字段路径问题。

GDB MI 协议中，console stream（`~"..."`）是 **out-of-band record**，本身不携带 token，与命令的 result record 分离。但 GDB **顺序处理命令**：某条命令产生的所有 console 输出，一定在该命令的 result record 之前全部发出。因此，只要给命令加上 token，就可以用 result record 作为"结束信号"，准确圈定这条命令的 console 输出范围：

```
456-interpreter-exec console "p path"
→ ~"$1 = alloc::string::String {..., pointer: 0xffffffc083bdff00, len: 12}\n"
→ 456^done
```

收集 `456^done` 之前的所有 `~"..."` 即为本次命令的输出。即使期间混入其他 console 行（如断点命中提示），也可以通过正则精确提取目标字段，不影响结果的稳定性。

## 解决方案

我们提供两种方案，均已实现并验证。

---

### 方案一：console 输出捕获方案（推荐）

**核心思路**：利用 GDB 顺序处理命令的保证，通过 result record 的 token 圈定 console 输出范围，让 GDB 自己负责解析 Rust 数据结构，完全绕开字段路径问题。

**MI2 层改动**：在 `mi2.ts` 中新增一个 `captureConsoleOutput` 方法，不改动现有架构：

```typescript
async captureConsoleOutput(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const lines: string[] = [];
        const token = this.nextToken++;

        const handler = (record: any) => {
            if (record.token === token) {
                this.removeListener('msg', handler);
                resolve(lines.join(''));
            } else if (record.type === 'console') {
                lines.push(record.content);
            }
        };

        this.on('msg', handler);
        this.sendRaw(`${token}-interpreter-exec console "${cmd}"`);
    });
}
```

**`getStringVariable` 实现**：

```typescript
public async getStringVariable(name: string): Promise<string> {
    if (!this.miDebugger) return '';
    try {
        const output = await this.miDebugger.captureConsoleOutput(`p ${name}`);
        const ptr = /pointer:\s*(0x[0-9a-fA-F]+)/.exec(output)?.[1];
        const lenStr = /\blen:\s*(\d+)/.exec(output)?.[1];
        if (!ptr || !lenStr) return '';
        const len = parseInt(lenStr, 10);
        if (!Number.isFinite(len) || len <= 0 || len > 4096) return '';

        const memRes = await this.miDebugger.sendCommand(
            `data-read-memory-bytes ${ptr} ${len}`
        );
        const contents: string = memRes.result('memory[0].contents') || '';
        let out = '';
        for (let i = 0; i + 1 < contents.length; i += 2) {
            out += String.fromCharCode(parseInt(contents.substring(i, i + 2), 16));
        }
        return out;
    } catch (e: any) {
        return '';
    }
}
```

**方案优势**：
1. **自动兼容所有 Rust 版本**：GDB 负责解析数据结构，调试器无需关心字段路径
2. **改动量小**：只新增一个方法，不改动现有架构
3. **命令次数少**：只需 1 次 `p` + 1 次内存读取，共 2 条命令
4. **未来免维护**：Rust 内部结构再变也无需修改代码

---

### 方案二：fallback 字段路径方案

**核心思路**：直接用 MI 命令读取 Rust String 的内部字段，对新旧两个版本分别尝试，失败则回退。

```typescript
public async getStringVariable(name: string): Promise<string> {
    if (!this.miDebugger) return '';
    try {
        const lenRes = await this.miDebugger.sendCommand(
            `data-evaluate-expression ${name}.vec.len`
        );
        const len = parseInt((lenRes.result('value') || '').trim(), 10);
        if (!Number.isFinite(len) || len <= 0 || len > 4096) return '';

        let ptrPath = `${name}.vec.buf.inner.ptr.pointer.pointer`;
        let ptrRes: any;
        try {
            ptrRes = await this.miDebugger.sendCommand(
                `data-evaluate-expression ${ptrPath}`
            );
        } catch {
            ptrPath = `${name}.vec.buf.ptr.pointer.pointer`;
            ptrRes = await this.miDebugger.sendCommand(
                `data-evaluate-expression ${ptrPath}`
            );
        }

        const ptrStr = ptrRes.result('value') || '';
        const m = /0x[0-9a-fA-F]+/.exec(ptrStr);
        if (!m) return '';

        const memRes = await this.miDebugger.sendCommand(
            `data-read-memory-bytes ${m[0]} ${len}`
        );
        const contents: string = memRes.result('memory[0].contents') || '';
        let out = '';
        for (let i = 0; i + 1 < contents.length; i += 2) {
            out += String.fromCharCode(parseInt(contents.substring(i, i + 2), 16));
        }
        return out;
    } catch (e: any) {
        return '';
    }
}
```

**方案局限**：
- 需要维护字段路径列表，Rust 内部结构变化时需手动添加新的 fallback 分支
- 命令次数较多（2-3 次字段读取 + 1 次内存读取）

---

### 方案对比

| | 方案一（console 捕获） | 方案二（fallback 字段路径） |
|---|---|---|
| Rust 版本兼容 | 自动兼容，无需维护 | 需维护字段路径列表 |
| 命令次数 | 2 次 | 2-3 次 |
| 改动量 | 新增一个方法 | 无需改动 MI2 层 |
| 未来维护成本 | 低 | 每次 Rust 改结构需更新 |

最终采用**方案一**，方案二作为备用保留。

## 验证结果

在 StarryOS 调试环境中验证：
```
p path
$1 = alloc::string::String {..., pointer: 0xffffffc083bdff00, len: 12}

x/12c 0xffffffc083bdff00
0xffffffc083bdff00: 47 '/' 117 'u' 115 's' 114 'r' 47 '/' 98 'b' 105 'i' 110 'n'
0xffffffc083bdff08: 47 '/' 101 'e' 110 'n' 118 'v'
```

成功捕获到字符串 `/usr/bin/env`，Hook 断点功能正常工作。

## 技术总结

本问题的核心挑战在于：
1. **跨版本兼容性**：不同 Rust 版本的内部数据结构差异
2. **console 输出关联**：GDB MI 协议中 console stream 不携带 token，需利用 GDB 顺序处理命令的保证来关联输出与命令

通过深入分析 GDB MI 协议的顺序性保证，设计了基于 result token 的 console 输出捕获方案，在改动量最小的前提下实现了对所有 Rust 版本的自动兼容。
