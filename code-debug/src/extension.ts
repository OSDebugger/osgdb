import * as vscode from 'vscode';
import { ARDDebugAdapterFactory } from './debugAdapter';
import { Border } from './breakpointGroups';

// Substitute common VS Code variables in a string from launch.json.
// VS Code does not substitute variables when you read launch.json via the API.
function variablesSubstitution(str: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspace = workspaceFolders?.length ? workspaceFolders[0] : undefined;
    str = str.replace(/\${workspaceFolder}/g, workspace?.uri.fsPath ?? '');
    str = str.replace(/\${workspaceFolderBasename}/g, workspace?.name ?? '');
    str = str.replace(/\${userHome}/g, process.env.HOME ?? process.env.USERPROFILE ?? '');
    str = str.replace(/\${env:(.*?)}/g, (_, key) => process.env[key] ?? '');
    return str;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('ARD Debug Adapter extension is now active');

    // Create and register debug adapter factory
    const debugAdapterFactory = new ARDDebugAdapterFactory(context);
    const disposable = vscode.debug.registerDebugAdapterDescriptorFactory('osdb', debugAdapterFactory);
    context.subscriptions.push(disposable, debugAdapterFactory);

    // Register DebugAdapterTracker EARLY — before any session starts —
    // so that stopped events from the very first session are captured.
    const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('osdb', {
        createDebugAdapterTracker: (_session: vscode.DebugSession) => {
            return {
                onDidSendMessage: (message: any) => {
                    if (message.type === 'event' && message.event === 'showInformationMessage') {
                        vscode.window.showInformationMessage(message.body);
                    }
                    if (message.type === 'event' && message.event === 'showErrorMessage') {
                        vscode.window.showErrorMessage(message.body);
                    }
                }
            };
        }
    });
    context.subscriptions.push(trackerDisposable);

    // -----------------------------------------------------------------------
    // OS debug commands
    // -----------------------------------------------------------------------

    // Read border_breakpoints from launch.json and set them in the debug session
    const setBorderBreakpointsCmd = vscode.commands.registerCommand(
        'osdb.setBorderBreakpointsFromLaunchJSON',
        () => {
            const config = vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders?.[0].uri);
            const configurations: any[] = config.get('configurations') ?? [];
            const borders: Array<{ filepath?: string; line?: number; function?: string }> = configurations[0]?.border_breakpoints ?? [];
            for (const b of borders) {
                if (b.function) continue; // function-name borders are set directly in GDB, not via VSCode breakpoints
                const border = new Border(variablesSubstitution(b.filepath!), b.line!);
                const bp = new vscode.SourceBreakpoint(
                    new vscode.Location(vscode.Uri.file(border.filepath!), new vscode.Position(border.line! - 1, 0)),
                    true
                );
                vscode.debug.addBreakpoints([bp]);
                vscode.debug.activeDebugSession?.customRequest('setBorder', border);
            }
            vscode.window.showInformationMessage('Border breakpoints from launch.json set.');
        }
    );

    // Read hook_breakpoints from launch.json and set them in the debug session
    const setHookBreakpointsCmd = vscode.commands.registerCommand(
        'osdb.setHookBreakpointsFromLaunchJSON',
        () => {
            const config = vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders?.[0].uri);
            const configurations: any[] = config.get('configurations') ?? [];
            const hooks: any[] = configurations[0]?.hook_breakpoints ?? [];
            for (const h of hooks) {
                const hook = {
                    breakpoint: {
                        file: variablesSubstitution(h.breakpoint.file),
                        line: h.breakpoint.line,
                    },
                    behavior: {
                        functionArguments: variablesSubstitution(h.behavior.functionArguments ?? ''),
                        functionBody: variablesSubstitution(h.behavior.functionBody ?? ''),
                        isAsync: h.behavior.isAsync ?? false,
                    },
                };
                const bp = new vscode.SourceBreakpoint(
                    new vscode.Location(vscode.Uri.file(hook.breakpoint.file), new vscode.Position(hook.breakpoint.line - 1, 0)),
                    true
                );
                vscode.debug.addBreakpoints([bp]);
                vscode.debug.activeDebugSession?.customRequest('setHookBreakpoint', hook);
            }
            vscode.window.showInformationMessage('Hook breakpoints from launch.json set.');
        }
    );

    // Right-click a breakpoint in the editor gutter → set it as a border
    const setBreakpointAsBorderCmd = vscode.commands.registerCommand(
        'osdb.setBreakpointAsBorder',
        (...args: any[]) => {
            const fullpath: string = args[0]?.uri?.fsPath;
            const lineNumber: number = args[0]?.lineNumber;
            if (!fullpath || !lineNumber) return;
            vscode.debug.activeDebugSession?.customRequest('setBorder', new Border(fullpath, lineNumber));
        }
    );

    // Disable a border (breakpoint stays, just no longer acts as a border)
    const disableBorderCmd = vscode.commands.registerCommand(
        'osdb.disableBorderOfThisBreakpointGroup',
        (...args: any[]) => {
            const fullpath: string = args[0]?.uri?.fsPath;
            const lineNumber: number = args[0]?.lineNumber;
            if (!fullpath || !lineNumber) return;
            vscode.debug.activeDebugSession?.customRequest('disableBorder', new Border(fullpath, lineNumber));
        }
    );

    // Remove all breakpoints from both VS Code UI and GDB
    const removeAllBreakpointsCmd = vscode.commands.registerCommand(
        'osdb.removeAllCliBreakpoints',
        () => {
            vscode.commands.executeCommand('workbench.debug.viewlet.action.removeAllBreakpoints');
            vscode.debug.activeDebugSession?.customRequest('removeAllCliBreakpoints');
            vscode.window.showInformationMessage('All breakpoints removed.');
        }
    );

    context.subscriptions.push(
        setBorderBreakpointsCmd,
        setHookBreakpointsCmd,
        setBreakpointAsBorderCmd,
        disableBorderCmd,
        removeAllBreakpointsCmd,
    );
}

export function deactivate() {}
