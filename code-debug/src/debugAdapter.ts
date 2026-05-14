// src/debugAdapter.ts
import * as vscode from 'vscode';
import { GDBDebugSession } from './gdbDebugSession';

export class ARDDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const debugSession = new GDBDebugSession({});
        return new vscode.DebugAdapterInlineImplementation(debugSession);
    }

    dispose() {
        // No resources to clean up — GDBDebugSession lifecycle is managed by VS Code
    }
}
