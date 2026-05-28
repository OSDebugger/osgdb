"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GDBDebugSession = void 0;
const path = __importStar(require("path"));
const markerScanner_1 = require("./markerScanner");
const debugadapter_1 = require("@vscode/debugadapter");
const mi2_1 = require("./backend/mi2");
const mi_parse_1 = require("./backend/mi_parse");
const breakpointGroups_1 = require("./breakpointGroups");
const OSStateMachine_1 = require("./OSStateMachine");
const addrSpace_1 = require("./addrSpace");
// ---------------------------------------------------------------------------
// GDBDebugSession
// ---------------------------------------------------------------------------
class GDBDebugSession extends debugadapter_1.DebugSession {
    constructor(opts) {
        super();
        // Inferior state
        this.inferiorStarted = false;
        this.gdbReady = false; // GDB process has connected and is ready to accept commands
        this.isAttachMode = false; // true when using attach (QEMU) mode
        this.program = '';
        this.programArgs = [];
        this.cwd = '';
        // Breakpoint state
        this.fileBreakpoints = new Map();
        this.gdbBkptToDap = new Map();
        this.nextDapBreakpointId = 1;
        this.functionBreakpointNumbers = [];
        // Maps "filePath:line" → DAP breakpoint id for breakpoints that are pending
        // (not set in GDB yet because they belong to an inactive breakpoint group).
        // Used by onBreakpointsRestored to send BreakpointEvent with the original id.
        this.pendingDapIds = new Map();
        // Set by try_get_next_breakpoint_group_name's async body to signal whether the
        // current stop matched a hook. If true, .finally() auto-continues instead of
        // sending StoppedEvent — hook breakpoints should be transparent to the user.
        // Variable / scope state
        this.nextVarRef = 1;
        this.varRefMap = new Map();
        this.createdVarObjects = [];
        // OS debug state
        this.osDebugReady = false;
        this.functionBorderNames = [];
        this.osState = new OSStateMachine_1.OSState(OSStateMachine_1.OSStateMachine.initial);
        this.recentStopThreadId = 1;
        this.kernelMemoryRanges = [];
        this.userMemoryRanges = [];
        this.programCounterId = 32; // RISC-V PC register id
    }
    // -----------------------------------------------------------------------
    // DAP: initialize
    // -----------------------------------------------------------------------
    initializeRequest(response, args) {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = false;
        response.body.supportsFunctionBreakpoints = true;
        response.body.supportsVariableType = true;
        this.sendResponse(response);
        this.sendEvent(new debugadapter_1.InitializedEvent());
    }
    // -----------------------------------------------------------------------
    // DAP: launch
    // -----------------------------------------------------------------------
    launchRequest(response, args) {
        const config = args;
        this.program = config.program || '';
        this.programArgs = config.args || [];
        this.cwd = config.cwd || process.cwd();
        if (!this.program) {
            this.sendErrorResponse(response, 1, 'No program specified in launch configuration');
            return;
        }
        this.launchGDB();
        this.inferiorStarted = false;
        this.gdbReady = false;
        this.isAttachMode = false;
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: attach
    // -----------------------------------------------------------------------
    attachRequest(response, args) {
        const config = args;
        this.cwd = config.cwd || process.cwd();
        if (!config.remote && (!config.qemuPath || !config.qemuArgs?.length)) {
            this.sendErrorResponse(response, 103, '`qemuPath` and `qemuArgs` must be set in launch.json');
            return;
        }
        // Initialize OS debug state from launch.json config
        this.programCounterId = config.program_counter_id ?? 32;
        this.kernelMemoryRanges = config.kernel_memory_ranges ?? [];
        this.userMemoryRanges = config.user_memory_ranges ?? [];
        this.osState = new OSStateMachine_1.OSState(OSStateMachine_1.OSStateMachine.initial);
        this.osDebugReady = false;
        // Build IBreakpointGroupsSession adapter
        const firstGroup = config.first_breakpoint_group ?? 'kernel';
        const secondGroup = config.second_breakpoint_group ?? 'user';
        const filePathToGroupNames = config.filePathToBreakpointGroupNames
            ? (0, breakpointGroups_1.toFunctionString)({ body: config.filePathToBreakpointGroupNames.functionBody, args: [config.filePathToBreakpointGroupNames.functionArguments] })
            : '(function(filepath) { return ["kernel"]; })';
        const groupNameToFilePaths = config.breakpointGroupNameToDebugFilePaths
            ? (0, breakpointGroups_1.toFunctionString)({ body: config.breakpointGroupNameToDebugFilePaths.functionBody, args: [config.breakpointGroupNameToDebugFilePaths.functionArguments] })
            : '(function(groupName) { return []; })';
        // Compile once — setBreakPointsRequest is called on every user breakpoint action
        // and re-evaling the function string each time is unnecessary overhead.
        this.cachedFilePathToGroupNames = eval(filePathToGroupNames);
        const self = this;
        const bpgSession = {
            get miDebugger() {
                return self.miDebugger;
            },
            filePathToBreakpointGroupNames: filePathToGroupNames,
            breakpointGroupNameToDebugFilePaths: groupNameToFilePaths,
            showInformationMessage(msg) {
                self.sendEvent({ event: 'showInformationMessage', type: 'event', body: msg, seq: 0 });
            },
            onBreakpointsRestored(results) {
                // After a breakpoint group switch, GDB has re-inserted the new group's
                // breakpoints under new GDB numbers.  We need to:
                //   1. Register each new GDB number in gdbBkptToDap
                //   2. Send BreakpointEvent('changed', verified=true) with the ORIGINAL DAP id
                //      that VS Code assigned when the breakpoint was first set (stored in
                //      pendingDapIds). Using the original id is what makes VS Code turn the
                //      dot from grey/unverified to green.
                for (const [ok, brk] of results) {
                    if (!ok || !brk)
                        continue;
                    const gdbNumber = brk.id ?? 0;
                    const line = brk.line ?? 0;
                    const file = brk.file ?? '';
                    // Look up the original DAP id assigned when this breakpoint was pending.
                    const pendingKey = `${file}:${line}`;
                    const existingDapId = self.pendingDapIds.get(pendingKey);
                    const dapId = existingDapId ?? self.nextDapBreakpointId++;
                    if (existingDapId !== undefined) {
                        self.pendingDapIds.delete(pendingKey);
                    }
                    self.gdbBkptToDap.set(gdbNumber, { id: dapId, line, verified: true });
                    const dbp = new debugadapter_1.Breakpoint(true, line);
                    dbp.setId(dapId);
                    if (file) {
                        dbp.source = new debugadapter_1.Source(path.basename(file), file);
                    }
                    self.sendEvent(new debugadapter_1.BreakpointEvent('changed', dbp));
                }
            },
        };
        this.breakpointGroups = new breakpointGroups_1.BreakpointGroups(firstGroup, bpgSession, secondGroup);
        // Register initial borders from launch.json
        if (config.border_breakpoints) {
            for (const b of config.border_breakpoints) {
                const direction = b.direction ?? 'kernel_to_user';
                if ('marker' in b) {
                    const found = (0, markerScanner_1.scanMarker)(this.cwd, b.marker);
                    if (found.length === 0) {
                        this.sendEvent(new debugadapter_1.OutputEvent(`[ardb] Warning: marker "${b.marker}" not found in ${this.cwd}\n`, 'stderr'));
                    }
                    for (const loc of found) {
                        this.breakpointGroups.updateBorder(new breakpointGroups_1.Border(loc.filepath, loc.line, undefined, direction));
                    }
                }
                else if ('function' in b) {
                    this.breakpointGroups.updateBorder(new breakpointGroups_1.Border(undefined, undefined, b.function, direction));
                    this.functionBorderNames.push(b.function);
                }
                else {
                    this.breakpointGroups.updateBorder(new breakpointGroups_1.Border(b.filepath, b.line, undefined, direction));
                }
            }
        }
        // Register initial hook breakpoints from launch.json
        // launch.json uses { functionArguments, functionBody } but HookBreakpointJSONFriendly
        // uses ObjectAsFunction { body, args[] } — convert here.
        if (config.hook_breakpoints) {
            for (const h of config.hook_breakpoints) {
                const behavior = {
                    body: h.behavior?.functionBody ?? h.behavior?.body ?? '',
                    args: h.behavior?.functionArguments !== undefined
                        ? [h.behavior.functionArguments]
                        : (h.behavior?.args ?? []),
                    isAsync: h.behavior?.isAsync ?? false,
                };
                if ('marker' in h) {
                    const found = (0, markerScanner_1.scanMarker)(this.cwd, h.marker);
                    if (found.length === 0) {
                        this.sendEvent(new debugadapter_1.OutputEvent(`[ardb] Warning: marker "${h.marker}" not found in ${this.cwd}\n`, 'stderr'));
                    }
                    for (const loc of found) {
                        const normalized = {
                            breakpoint: { file: loc.filepath, line: loc.line, condition: '' },
                            behavior,
                        };
                        this.breakpointGroups.updateHookBreakpoint(normalized);
                    }
                }
                else {
                    const normalized = {
                        breakpoint: { condition: '', ...h.breakpoint },
                        behavior,
                    };
                    this.breakpointGroups.updateHookBreakpoint(normalized);
                }
            }
        }
        if (config.remote) {
            this.launchGDB(config);
        }
        else {
            // Launch QEMU in the integrated terminal, then start GDB after a short delay
            // to give QEMU time to open the GDB stub on :1234.
            const qemuCmd = [config.qemuPath, ...config.qemuArgs];
            this.runInTerminalRequest({ kind: 'integrated', title: 'QEMU', cwd: this.cwd, args: qemuCmd }, 15000, (termResponse) => {
                if (termResponse.success === false) {
                    console.error('[ardb] Failed to launch QEMU in terminal');
                    this.sendEvent(new debugadapter_1.TerminatedEvent());
                    return;
                }
                // Give QEMU ~1s to open the GDB stub before GDB tries to connect
                setTimeout(() => {
                    this.launchGDB(config);
                }, 1000);
            });
        }
        this.inferiorStarted = false;
        this.gdbReady = false;
        this.isAttachMode = true;
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: configurationDone
    // -----------------------------------------------------------------------
    configurationDoneRequest(response, args) {
        this.sendResponse(response);
        // In attach mode, GDB hasn't connected yet — the real stop will come from GDB
        // after connecting to QEMU (via stopAtConnect). Don't send a fake StoppedEvent.
        // In launch mode, send an entry stop so the UI shows "paused" while the user configures.
        if (!this.isAttachMode) {
            const event = new debugadapter_1.StoppedEvent('entry', 1);
            event.body.description = 'Program loaded. Configure ARD, then press Continue to run.';
            event.body.allThreadsStopped = true;
            this.sendEvent(event);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: setBreakpoints
    // -----------------------------------------------------------------------
    async setBreakPointsRequest(response, args) {
        const source = args.source;
        const filePath = source.path || '';
        const requestedLines = args.breakpoints || [];
        if (!filePath) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }
        // In OS debug mode: cache breakpoints into the appropriate breakpoint group.
        // Only actually set them in GDB if this file belongs to the current active group.
        if (this.breakpointGroups) {
            // Determine which group(s) this file belongs to
            let groupNames = [];
            try {
                groupNames = this.cachedFilePathToGroupNames(filePath);
            }
            catch {
                groupNames = [this.breakpointGroups.getCurrentBreakpointGroupName()];
            }
            // Save into each matching group (for future group switches)
            for (const groupName of groupNames) {
                this.breakpointGroups.saveBreakpointsToBreakpointGroup(args, groupName);
            }
            const currentGroup = this.breakpointGroups.getCurrentBreakpointGroupName();
            const belongsToCurrent = groupNames.includes(currentGroup);
            // If this file doesn't belong to the current group, return pending placeholders.
            // The breakpoints will be set for real when the group switches.
            if (!belongsToCurrent) {
                // Purge stale entries for this file before inserting new ones.
                // VS Code always sends the full current list for a file, so any key we
                // had from a previous request is now obsolete and must be removed to
                // prevent pendingDapIds from growing unboundedly across group switches.
                for (const key of this.pendingDapIds.keys()) {
                    if (key.startsWith(`${filePath}:`)) {
                        this.pendingDapIds.delete(key);
                    }
                }
                const dapBreakpoints = requestedLines.map(bp => {
                    const dapId = this.nextDapBreakpointId++;
                    // Remember this id so onBreakpointsRestored can use it to send
                    // BreakpointEvent('changed') with the same id, making VS Code turn it green.
                    this.pendingDapIds.set(`${filePath}:${bp.line}`, dapId);
                    const dbp = new debugadapter_1.Breakpoint(false, bp.line);
                    dbp.setId(dapId);
                    dbp.source = new debugadapter_1.Source(source.name || '', filePath);
                    dbp.message = 'Pending: will be set when this breakpoint group becomes active';
                    return dbp;
                });
                response.body = { breakpoints: dapBreakpoints };
                this.sendResponse(response);
                return;
            }
            // else: belongs to current group — fall through to set in GDB immediately
        }
        if (!this.miDebugger) {
            // GDB not ready yet — return pending placeholders, they'll be set after connect
            const dapBreakpoints = requestedLines.map(bp => {
                const dbp = new debugadapter_1.Breakpoint(false, bp.line);
                dbp.setId(this.nextDapBreakpointId++);
                dbp.source = new debugadapter_1.Source(source.name || '', filePath);
                dbp.message = 'Pending: GDB not connected yet';
                return dbp;
            });
            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
            return;
        }
        try {
            // Delete old breakpoints for this file
            const oldNumbers = this.fileBreakpoints.get(filePath) || [];
            for (const num of oldNumbers) {
                await this.miDebugger.sendCommand(`break-delete ${num}`).catch(() => { });
                this.gdbBkptToDap.delete(num);
            }
            this.fileBreakpoints.delete(filePath);
            const newNumbers = [];
            const dapBreakpoints = [];
            for (const bp of requestedLines) {
                const location = `"${(0, mi2_1.escape)(filePath)}:${bp.line}"`;
                try {
                    const record = await this.miDebugger.sendCommand(`break-insert -f ${location}`);
                    const bkpt = mi_parse_1.MINode.valueOf(record.resultRecords?.results, "bkpt");
                    const gdbNumber = parseInt(mi_parse_1.MINode.valueOf(bkpt, "number") || '0');
                    const actualLine = parseInt(mi_parse_1.MINode.valueOf(bkpt, "line") || `${bp.line}`);
                    const verified = mi_parse_1.MINode.valueOf(bkpt, "pending") === undefined;
                    if (bp.condition && gdbNumber > 0) {
                        await this.miDebugger.sendCommand(`break-condition ${gdbNumber} ${bp.condition}`).catch(() => { });
                    }
                    const dapId = this.nextDapBreakpointId++;
                    newNumbers.push(gdbNumber);
                    this.gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });
                    const dbp = new debugadapter_1.Breakpoint(verified, actualLine);
                    dbp.setId(dapId);
                    dbp.source = new debugadapter_1.Source(source.name || '', filePath);
                    dapBreakpoints.push(dbp);
                }
                catch (err) {
                    const dapId = this.nextDapBreakpointId++;
                    const dbp = new debugadapter_1.Breakpoint(false, bp.line);
                    dbp.setId(dapId);
                    dbp.message = err.message || 'Failed to set breakpoint';
                    dbp.source = new debugadapter_1.Source(source.name || '', filePath);
                    dapBreakpoints.push(dbp);
                }
            }
            this.fileBreakpoints.set(filePath, newNumbers);
            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 2, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: setFunctionBreakpoints
    // -----------------------------------------------------------------------
    async setFunctionBreakPointsRequest(response, args) {
        if (!this.miDebugger) {
            response.body = { breakpoints: [] };
            this.sendResponse(response);
            return;
        }
        const requestedFunctions = args.breakpoints || [];
        try {
            for (const num of this.functionBreakpointNumbers) {
                await this.miDebugger.sendCommand(`break-delete ${num}`).catch(() => { });
                this.gdbBkptToDap.delete(num);
            }
            this.functionBreakpointNumbers = [];
            const dapBreakpoints = [];
            for (const fbp of requestedFunctions) {
                try {
                    const record = await this.miDebugger.sendCommand(`break-insert -f ${fbp.name}`);
                    const bkpt = mi_parse_1.MINode.valueOf(record.resultRecords?.results, "bkpt");
                    const gdbNumber = parseInt(mi_parse_1.MINode.valueOf(bkpt, "number") || '0');
                    const actualLine = parseInt(mi_parse_1.MINode.valueOf(bkpt, "line") || '0');
                    const verified = mi_parse_1.MINode.valueOf(bkpt, "pending") === undefined;
                    if (fbp.condition && gdbNumber > 0) {
                        await this.miDebugger.sendCommand(`break-condition ${gdbNumber} ${fbp.condition}`).catch(() => { });
                    }
                    const dapId = this.nextDapBreakpointId++;
                    this.functionBreakpointNumbers.push(gdbNumber);
                    this.gdbBkptToDap.set(gdbNumber, { id: dapId, line: actualLine, verified });
                    const dbp = new debugadapter_1.Breakpoint(verified, actualLine);
                    dbp.setId(dapId);
                    const fullname = mi_parse_1.MINode.valueOf(bkpt, "fullname");
                    if (fullname) {
                        dbp.source = new debugadapter_1.Source(mi_parse_1.MINode.valueOf(bkpt, "file") || '', fullname);
                    }
                    dapBreakpoints.push(dbp);
                }
                catch (err) {
                    const dapId = this.nextDapBreakpointId++;
                    const dbp = new debugadapter_1.Breakpoint(false);
                    dbp.setId(dapId);
                    dbp.message = err.message || 'Failed to set function breakpoint';
                    dapBreakpoints.push(dbp);
                }
            }
            response.body = { breakpoints: dapBreakpoints };
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 3, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: continue
    // -----------------------------------------------------------------------
    async continueRequest(response, args) {
        if (!this.miDebugger || !this.gdbReady) {
            this.sendErrorResponse(response, 4, 'GDB is not ready yet. Please wait for the debugger to connect.');
            return;
        }
        try {
            await this.cleanupVariables();
            if (!this.inferiorStarted && !this.isAttachMode) {
                // Launch mode: first Continue starts the program
                this.inferiorStarted = true;
                await this.miDebugger.sendCommand('exec-run');
            }
            else {
                await this.miDebugger.continue();
            }
            response.body = { allThreadsContinued: true };
            this.sendResponse(response);
        }
        catch (err) {
            console.log(`[Adapter] continue failed: ${err.message}`);
            this.sendErrorResponse(response, 4, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: next / stepIn / stepOut / pause
    // -----------------------------------------------------------------------
    async nextRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 5, 'Program has not started yet. Press Continue first.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 5, 'No debug session');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.miDebugger.next();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 5, err.message);
        }
    }
    async stepInRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 6, 'Program has not started yet. Press Continue first.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 6, 'No debug session');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.miDebugger.step();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 6, err.message);
        }
    }
    async stepOutRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 7, 'Program has not started yet. Press Continue first.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 7, 'No debug session');
            return;
        }
        try {
            await this.cleanupVariables();
            await this.miDebugger.stepOut();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 7, err.message);
        }
    }
    async pauseRequest(response, args) {
        if (!this.inferiorStarted) {
            this.sendErrorResponse(response, 8, 'Program has not started yet.');
            return;
        }
        if (!this.miDebugger) {
            this.sendErrorResponse(response, 8, 'No debug session');
            return;
        }
        try {
            await this.miDebugger.interrupt();
            this.sendResponse(response);
        }
        catch (err) {
            this.sendErrorResponse(response, 8, err.message);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: threads
    // -----------------------------------------------------------------------
    async threadsRequest(response) {
        if (!this.inferiorStarted || !this.miDebugger) {
            response.body = { threads: [new debugadapter_1.Thread(1, 'main (not started)')] };
            this.sendResponse(response);
            return;
        }
        try {
            const threads = await this.miDebugger.getThreads();
            response.body = {
                threads: threads.map(t => new debugadapter_1.Thread(t.id, t.name || t.targetId || `Thread ${t.id}`))
            };
            if (response.body.threads.length === 0) {
                response.body.threads.push(new debugadapter_1.Thread(1, 'main'));
            }
            this.sendResponse(response);
        }
        catch {
            response.body = { threads: [new debugadapter_1.Thread(1, 'main')] };
            this.sendResponse(response);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: stackTrace
    // -----------------------------------------------------------------------
    async stackTraceRequest(response, args) {
        const threadId = args.threadId || 1;
        if (!this.inferiorStarted || !this.miDebugger) {
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
            return;
        }
        try {
            await this.miDebugger.sendCommand(`thread-select ${threadId}`);
            await this.fallbackPhysicalStackTrace(response, threadId);
        }
        catch (err) {
            console.log(`[Adapter] stackTrace failed: ${err.message}`);
            response.body = { stackFrames: [], totalFrames: 0 };
            this.sendResponse(response);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: scopes
    // -----------------------------------------------------------------------
    scopesRequest(response, args) {
        const frameId = args.frameId ?? 0;
        const threadId = Math.floor(frameId / 10000);
        const frameLevel = frameId % 10000;
        const argsRef = this.nextVarRef++;
        const localsRef = this.nextVarRef++;
        this.varRefMap.set(argsRef, { type: 'scope', scopeKind: 'args', threadId, frameLevel });
        this.varRefMap.set(localsRef, { type: 'scope', scopeKind: 'locals', threadId, frameLevel });
        response.body = {
            scopes: [
                new debugadapter_1.Scope('Arguments', argsRef, false),
                new debugadapter_1.Scope('Locals', localsRef, false),
            ],
        };
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: variables
    // -----------------------------------------------------------------------
    async variablesRequest(response, args) {
        const ref = args.variablesReference ?? 0;
        const entry = this.varRefMap.get(ref);
        if (!entry) {
            response.body = { variables: [] };
            this.sendResponse(response);
            return;
        }
        try {
            if (entry.type === 'scope') {
                await this.handleScopeVariables(response, entry.threadId, entry.frameLevel, entry.scopeKind);
            }
            else {
                await this.handleVarChildren(response, entry.varName);
            }
        }
        catch (err) {
            console.log(`[Adapter] variables failed: ${err.message}`);
            response.body = { variables: [] };
            this.sendResponse(response);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: evaluate
    // -----------------------------------------------------------------------
    async evaluateRequest(response, args) {
        if (!this.miDebugger || !args.expression) {
            response.body = { result: '', variablesReference: 0 };
            this.sendResponse(response);
            return;
        }
        const expr = args.expression;
        const context = args.context || 'repl';
        try {
            const record = await this.miDebugger.sendCliCommand(expr);
            const result = this.getConsoleOutput(record);
            if (context === 'repl' && result) {
                this.sendEvent(new debugadapter_1.OutputEvent(result.endsWith('\n') ? result : result + '\n', 'console'));
            }
            response.body = { result: result || 'OK', variablesReference: 0 };
            this.sendResponse(response);
        }
        catch (err) {
            const msg = err.message || 'Command failed';
            if (context === 'repl') {
                this.sendEvent(new debugadapter_1.OutputEvent(msg.endsWith('\n') ? msg : msg + '\n', 'stderr'));
            }
            response.body = { result: msg, variablesReference: 0 };
            this.sendResponse(response);
        }
    }
    // -----------------------------------------------------------------------
    // DAP: disconnect
    // -----------------------------------------------------------------------
    disconnectRequest(response, args) {
        if (this.miDebugger) {
            this.miDebugger.stop();
            this.miDebugger = undefined;
        }
        this.inferiorStarted = false;
        this.fileBreakpoints.clear();
        this.gdbBkptToDap.clear();
        this.functionBreakpointNumbers = [];
        this.varRefMap.clear();
        this.createdVarObjects = [];
        this.sendResponse(response);
    }
    // -----------------------------------------------------------------------
    // DAP: customRequest — dispatch ardb-* commands
    // -----------------------------------------------------------------------
    customRequest(command, response, args) {
        switch (command) {
            // OS debug commands
            case 'setBorder':
                if (this.breakpointGroups && args) {
                    this.breakpointGroups.updateBorder(new breakpointGroups_1.Border(args.filepath, args.line));
                }
                this.sendResponse(response);
                break;
            case 'disableBorder':
                if (this.breakpointGroups && args) {
                    this.breakpointGroups.disableBorder(new breakpointGroups_1.Border(args.filepath, args.line));
                }
                this.sendResponse(response);
                break;
            case 'setHookBreakpoint':
                if (this.breakpointGroups && args) {
                    const normalized = {
                        breakpoint: args.breakpoint,
                        behavior: {
                            body: args.behavior?.functionBody ?? args.behavior?.body ?? '',
                            args: args.behavior?.functionArguments !== undefined
                                ? [args.behavior.functionArguments]
                                : (args.behavior?.args ?? []),
                            isAsync: args.behavior?.isAsync ?? false,
                        },
                    };
                    this.breakpointGroups.updateHookBreakpoint(normalized);
                    const f = args.breakpoint?.file ? path.basename(args.breakpoint.file) : '?';
                    const l = args.breakpoint?.line ?? '?';
                    this.showInfo(`hook breakpoint set: ${f}:${l}`);
                }
                this.sendResponse(response);
                break;
            case 'disableHookBreakpoint':
                if (this.breakpointGroups && args) {
                    const normalized = {
                        breakpoint: args.breakpoint,
                        behavior: {
                            body: args.behavior?.functionBody ?? args.behavior?.body ?? '',
                            args: args.behavior?.functionArguments !== undefined
                                ? [args.behavior.functionArguments]
                                : (args.behavior?.args ?? []),
                            isAsync: args.behavior?.isAsync ?? false,
                        },
                    };
                    this.breakpointGroups.disableHookBreakpoint(normalized);
                }
                this.sendResponse(response);
                break;
            case 'removeAllCliBreakpoints':
                if (this.breakpointGroups) {
                    this.breakpointGroups.disableCurrentBreakpointGroupBreakpoints();
                    this.breakpointGroups.removeAllBreakpoints();
                }
                if (this.miDebugger) {
                    // Delete only tracked breakpoints individually — break-delete without args
                    // would also wipe border/hook breakpoints inserted via sendCommand (which
                    // bypass fileBreakpoints), permanently breaking border detection.
                    const toDelete = [...this.functionBreakpointNumbers];
                    for (const nums of this.fileBreakpoints.values()) {
                        toDelete.push(...nums);
                    }
                    for (const num of toDelete) {
                        this.miDebugger.sendCommand(`break-delete ${num}`).catch(() => { });
                    }
                }
                this.fileBreakpoints.clear();
                this.gdbBkptToDap.clear();
                this.functionBreakpointNumbers = [];
                this.sendResponse(response);
                break;
            case 'disableCurrentBreakpointGroupBreakpoints':
                if (this.breakpointGroups) {
                    this.breakpointGroups.disableCurrentBreakpointGroupBreakpoints();
                }
                this.sendResponse(response);
                break;
            default:
                super.customRequest(command, response, args);
                break;
        }
    }
    // -----------------------------------------------------------------------
    // GDB subprocess management (via MI2)
    // -----------------------------------------------------------------------
    launchGDB(attachConfig) {
        const gdbPath = attachConfig?.gdbpath || 'gdb';
        const gdbArgs = [
            '--interpreter=mi2',
            '-ex', 'set pagination off',
        ];
        const env = { ...process.env };
        this.miDebugger = new mi2_1.MI2(gdbPath, gdbArgs, attachConfig?.debugger_args || [], env);
        // Wire up events
        this.miDebugger.on('msg', (type, msg) => {
            if (type === 'console' || type === 'stdout') {
                this.sendEvent(new debugadapter_1.OutputEvent(msg, 'console'));
            }
            else if (type === 'stderr') {
                this.sendEvent(new debugadapter_1.OutputEvent(msg, 'stderr'));
            }
        });
        this.miDebugger.on('quit', () => {
            this.sendEvent(new debugadapter_1.TerminatedEvent());
        });
        this.miDebugger.on('launcherror', (err) => {
            console.error('[Adapter] GDB launch error:', err);
            this.sendEvent(new debugadapter_1.TerminatedEvent());
        });
        this.miDebugger.on('debug-ready', () => {
            this.gdbReady = true;
            if (attachConfig) {
                this.osDebugReady = true;
                this.inferiorStarted = true;
                for (const funcName of this.functionBorderNames) {
                    this.miDebugger.addBreakPoint({ raw: funcName, condition: '' }).then(([ok, brk]) => {
                        if (!ok || !brk?.id)
                            return;
                        // Store the GDB number back into the Border object so
                        // updateCurrentBreakpointGroup can delete it on group switch.
                        const group = this.breakpointGroups?.getCurrentBreakpointGroup();
                        const border = group?.borders?.find(b => b.func === funcName);
                        if (border)
                            border.gdbNumber = brk.id;
                    });
                }
            }
            this.sendEvent(new debugadapter_1.InitializedEvent());
        });
        this.miDebugger.on('breakpoint', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.pendingBreakpointNode = node;
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                this.handleBreakpointHit(node);
            }
        });
        this.miDebugger.on('step-end', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const event = new debugadapter_1.StoppedEvent('step', threadId);
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('step-other', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const event = new debugadapter_1.StoppedEvent('pause', threadId);
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('signal-stop', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const sigName = node.record('signal-name') || 'unknown';
                const event = new debugadapter_1.StoppedEvent('exception', threadId);
                event.body.description = `Signal: ${sigName}`;
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('stopped', (node) => {
            const threadId = this.getThreadId(node);
            this.recentStopThreadId = threadId;
            if (this.osDebugReady) {
                this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
            }
            else {
                const event = new debugadapter_1.StoppedEvent('pause', threadId);
                event.body.allThreadsStopped = true;
                this.sendEvent(event);
            }
        });
        this.miDebugger.on('running', (node) => {
            const threadId = this.getThreadId(node);
            this.sendEvent(new debugadapter_1.ContinuedEvent(threadId, true));
        });
        this.miDebugger.on('exited-normally', (_node) => {
            this.sendEvent(new debugadapter_1.TerminatedEvent());
        });
        // Wire breakpoint-modified notify
        this.miDebugger.on('exec-async-output', (node) => {
            if (node.outOfBandRecord) {
                for (const record of node.outOfBandRecord) {
                    if (!record.isStream && record.type === 'notify' && record.asyncClass === 'breakpoint-modified') {
                        this.handleBreakpointModified(node);
                    }
                }
            }
        });
        // Start GDB: attach mode connects to remote gdbserver, launch mode loads the program
        if (attachConfig) {
            this.miDebugger.connect(this.cwd, attachConfig.executable || '', attachConfig.target, attachConfig.autorun || []).catch(err => {
                console.error('[Adapter] MI2 connect error:', err);
            });
        }
        else {
            const fullProgram = this.program;
            const procArgsStr = this.programArgs.join(' ');
            this.miDebugger.load(this.cwd, fullProgram, procArgsStr).catch(err => {
                console.error('[Adapter] MI2 load error:', err);
            });
        }
    }
    // -----------------------------------------------------------------------
    // OS debug: state machine + doAction
    // -----------------------------------------------------------------------
    osStateTransition(event) {
        let actions;
        [this.osState, actions] = (0, OSStateMachine_1.stateTransition)(OSStateMachine_1.OSStateMachine, this.osState, event);
        actions.forEach(action => { this.doAction(action); });
    }
    /** Send an information notification visible in VS Code's notification area. */
    showInfo(msg) {
        this.sendEvent({ event: 'showInformationMessage', type: 'event', body: msg, seq: 0 });
    }
    /**
     * Read a C-string variable from GDB. Used by hook breakpoint behaviors
     * (which capture `this` via arrow functions) to fetch e.g. the `path`
     * argument of `sys_exec` and decide which user breakpoint group to switch to.
     */
    async getStringVariable(name) {
        if (!this.miDebugger)
            return '';
        try {
            const lenRes = await this.miDebugger.sendCommand(`data-evaluate-expression ${name}.vec.len`);
            const len = parseInt((lenRes.result('value') || '').trim(), 10);
            if (!Number.isFinite(len) || len <= 0 || len > 4096) {
                this.showInfo(`getStringVariable('${name}'): bad len`);
                return '';
            }
            const ptrRes = await this.miDebugger.sendCommand(`data-evaluate-expression ${name}.vec.buf.ptr.pointer.pointer`);
            const ptrStr = ptrRes.result('value') || '';
            const m = /0x[0-9a-fA-F]+/.exec(ptrStr);
            if (!m) {
                this.showInfo(`getStringVariable('${name}'): no addr`);
                return '';
            }
            const addr = m[0];
            const memRes = await this.miDebugger.sendCommand(`data-read-memory-bytes ${addr} ${len}`);
            const contents = memRes.result('memory[0].contents') || '';
            if (!contents) {
                this.showInfo(`getStringVariable('${name}'): empty memory`);
                return '';
            }
            let out = '';
            for (let i = 0; i + 1 < contents.length; i += 2) {
                out += String.fromCharCode(parseInt(contents.substr(i, 2), 16));
            }
            this.showInfo(`getStringVariable got: ${out}`);
            return out;
        }
        catch (e) {
            this.showInfo(`getStringVariable('${name}') failed: ${e?.message ?? e}`);
            return '';
        }
    }
    doAction(action) {
        if (!this.miDebugger)
            return;
        if (action.type === OSStateMachine_1.DebuggerActions.check_if_kernel_yet) {
            this.showInfo('doing action: check_if_kernel_yet');
            this.miDebugger.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) {
                    console.warn('[ardb] check_if_kernel_yet: no register data');
                    return;
                }
                const pc = (0, addrSpace_1.parseAddr)(regs[0]?.value ?? '');
                if (pc !== undefined && (0, addrSpace_1.isKernelAddr)(pc, this.kernelMemoryRanges)) {
                    this.showInfo('arrived at kernel. current addr: ' + pc.toString(16));
                    this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL));
                }
                else {
                    this.miDebugger.stepInstruction();
                }
            });
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.check_if_user_yet) {
            this.showInfo('doing action: check_if_user_yet');
            this.miDebugger.getSomeRegisterValues([this.programCounterId]).then(regs => {
                if (!regs || regs.length === 0 || !regs[0]) {
                    console.warn('[ardb] check_if_user_yet: no register data');
                    return;
                }
                const pc = (0, addrSpace_1.parseAddr)(regs[0]?.value ?? '');
                if (pc !== undefined && (0, addrSpace_1.isUserAddr)(pc, this.userMemoryRanges)) {
                    this.showInfo('arrived at user. current addr: ' + pc.toString(16));
                    this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_USER));
                }
                else {
                    this.miDebugger.stepInstruction();
                }
            });
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.check_if_kernel_to_user_border_yet) {
            this.showInfo('doing action: check_if_kernel_to_user_border_yet');
            const borders = this.breakpointGroups?.getCurrentBreakpointGroup()?.borders;
            this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(v => {
                if (!v || v.length === 0 || !v[0]) {
                    console.warn('[ardb] check_if_kernel_to_user_border_yet: empty stack');
                    return;
                }
                const filepath = v[0].file ?? '';
                const lineNumber = v[0].line ?? -1;
                const funcName = v[0].function;
                if (borders) {
                    for (const border of borders) {
                        if (this.borderMatches(border, filepath, lineNumber, funcName, 'kernel_to_user')) {
                            this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL_TO_USER_BORDER));
                            break;
                        }
                    }
                }
            });
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.check_if_user_to_kernel_border_yet) {
            this.showInfo('doing action: check_if_user_to_kernel_border_yet');
            const borders = this.breakpointGroups?.getCurrentBreakpointGroup()?.borders;
            this.miDebugger.getSomeRegisterValues([this.programCounterId]).then(regs => {
                const reg = regs?.[0];
                if (!reg) {
                    this.sendUserStoppedEvent();
                    return;
                }
                const pc = (0, addrSpace_1.parseAddr)(reg.value ?? '');
                if (pc !== undefined && (0, addrSpace_1.isKernelAddr)(pc, this.kernelMemoryRanges)) {
                    // PC is in kernel
                    this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(v => {
                        if (!v || v.length === 0 || !v[0]) {
                            this.sendUserStoppedEvent();
                            return;
                        }
                        const filepath = v[0].file ?? '';
                        const lineNumber = v[0].line ?? -1;
                        const funcName = v[0].function;
                        // Check if this is a user_to_kernel border
                        if (borders) {
                            for (const border of borders) {
                                if (this.borderMatches(border, filepath, lineNumber, funcName, 'user_to_kernel')) {
                                    // Hit user_to_kernel border, and PC is already in kernel
                                    // This means the border is set at a kernel function (e.g., StarryOS handle_syscall)
                                    // Switch directly to kernel state without single-stepping
                                    this.showInfo('[INFO] user_to_kernel border hit, PC already in kernel — switching to kernel state directly');
                                    this.pendingBreakpointNode = undefined;
                                    this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL));
                                    return;
                                }
                            }
                        }
                        // Not a border — force state back to kernel
                        this.showInfo('[WARN] PC in kernel but state is user (not a border) — forcing back to kernel state');
                        this.osState.status = OSStateMachine_1.OSStates.kernel;
                        this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.STOPPED));
                    });
                }
                else {
                    // PC is still in user space
                    // Check if we hit a user_to_kernel border (rCore case: border at user-space ecall)
                    this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(v => {
                        if (!v || v.length === 0 || !v[0]) {
                            this.sendUserStoppedEvent();
                            return;
                        }
                        const filepath = v[0].file ?? '';
                        const lineNumber = v[0].line ?? -1;
                        const funcName = v[0].function;
                        if (borders) {
                            for (const border of borders) {
                                if (this.borderMatches(border, filepath, lineNumber, funcName, 'user_to_kernel')) {
                                    // Hit user_to_kernel border in user space (rCore case)
                                    // Enter single-step mode to cross the boundary
                                    this.showInfo('[INFO] user_to_kernel border hit in user space — entering single-step mode');
                                    this.pendingBreakpointNode = undefined;
                                    this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_USER_TO_KERNEL_BORDER));
                                    return;
                                }
                            }
                        }
                        // Normal user breakpoint — stop for the user
                        this.sendUserStoppedEvent();
                    });
                }
            });
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.start_consecutive_single_steps) {
            this.showInfo('doing action: start_consecutive_single_steps');
            this.miDebugger.stepInstruction();
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.try_get_next_breakpoint_group_name) {
            this.showInfo('doing action: try_get_next_breakpoint_group_name');
            this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(v => {
                if (!v || v.length === 0 || !v[0]) {
                    console.warn('[ardb] try_get_next_breakpoint_group_name: empty stack');
                    return;
                }
                const filepath = v[0].file;
                const lineNumber = v[0].line;
                const currentGroup = this.breakpointGroups?.getCurrentBreakpointGroup();
                if (!currentGroup)
                    return;
                for (const hook of currentGroup.hooks) {
                    this.currentHook = hook;
                    if (filepath === hook.breakpoint.file && lineNumber === hook.breakpoint.line) {
                        eval(hook.behavior)().then((hookResult) => {
                            this.breakpointGroups.setNextBreakpointGroup(hookResult);
                            this.currentHook = undefined;
                            this.showInfo('finished action: try_get_next_breakpoint_group_name. Next breakpoint group is ' + hookResult);
                        });
                    }
                }
            });
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.high_level_switch_breakpoint_group_to_low_level) {
            const highLevelName = this.breakpointGroups.getCurrentBreakpointGroupName();
            this.breakpointGroups.updateCurrentBreakpointGroup(this.breakpointGroups.getNextBreakpointGroup(), true);
            this.breakpointGroups.setNextBreakpointGroup(highLevelName);
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.low_level_switch_breakpoint_group_to_high_level) {
            const lowLevelName = this.breakpointGroups.getCurrentBreakpointGroupName();
            const highLevelName = this.breakpointGroups.getNextBreakpointGroup();
            this.breakpointGroups.updateCurrentBreakpointGroup(highLevelName, true);
            this.breakpointGroups.setNextBreakpointGroup(lowLevelName);
        }
        else if (action.type === OSStateMachine_1.DebuggerActions.check_stop_in_kernel) {
            this.miDebugger.getStack(0, 1, this.recentStopThreadId).then(async (v) => {
                if (!v || v.length === 0 || !v[0]) {
                    this.sendUserStoppedEvent();
                    return;
                }
                const filepath = v[0].file ?? '';
                const lineNumber = v[0].line ?? -1;
                const funcName = v[0].function;
                const currentGroup = this.breakpointGroups?.getCurrentBreakpointGroup();
                if (!currentGroup) {
                    this.sendUserStoppedEvent();
                    return;
                }
                for (const hook of currentGroup.hooks) {
                    if (filepath === hook.breakpoint.file && lineNumber === hook.breakpoint.line) {
                        try {
                            const hookResult = await eval(hook.behavior)();
                            this.breakpointGroups.setNextBreakpointGroup(hookResult);
                            this.showInfo('hook matched, next group: ' + hookResult);
                        }
                        catch (e) {
                            this.showInfo('hook eval failed: ' + (e?.message ?? e));
                            console.error('[ardb] hook eval failed:', e);
                        }
                        this.pendingBreakpointNode = undefined;
                        this.miDebugger.continue();
                        return;
                    }
                }
                if (currentGroup.borders) {
                    for (const border of currentGroup.borders) {
                        if (this.borderMatches(border, filepath, lineNumber, funcName, 'kernel_to_user')) {
                            this.pendingBreakpointNode = undefined;
                            this.osStateTransition(new OSStateMachine_1.OSEvent(OSStateMachine_1.OSEvents.AT_KERNEL_TO_USER_BORDER));
                            return;
                        }
                    }
                }
                this.sendUserStoppedEvent();
            });
        }
    }
    // -----------------------------------------------------------------------
    // Event helpers
    // -----------------------------------------------------------------------
    borderMatches(border, filepath, lineNumber, funcName, direction) {
        if (direction !== undefined && border.direction !== direction)
            return false;
        if (border.func !== undefined) {
            return funcName !== undefined && funcName === border.func;
        }
        return filepath === border.filepath && lineNumber === border.line;
    }
    getThreadId(node) {
        const tid = node.record('thread-id');
        return tid ? parseInt(tid) : 1;
    }
    handleBreakpointHit(node) {
        const bkptno = parseInt(node.record('bkptno') || '0');
        const threadId = this.getThreadId(node);
        const entry = this.gdbBkptToDap.get(bkptno);
        const dapId = entry?.id;
        const event = new debugadapter_1.StoppedEvent('breakpoint', threadId);
        event.body.hitBreakpointIds = dapId ? [dapId] : [];
        event.body.allThreadsStopped = true;
        this.sendEvent(event);
    }
    sendUserStoppedEvent() {
        if (this.pendingBreakpointNode) {
            this.handleBreakpointHit(this.pendingBreakpointNode);
            this.pendingBreakpointNode = undefined;
        }
        else {
            const event = new debugadapter_1.StoppedEvent('pause', this.recentStopThreadId);
            event.body.allThreadsStopped = true;
            this.sendEvent(event);
        }
    }
    handleBreakpointModified(node) {
        const bkpt = node.record('bkpt');
        if (!bkpt)
            return;
        const gdbNumber = parseInt(mi_parse_1.MINode.valueOf(bkpt, "number") || '0');
        const entry = this.gdbBkptToDap.get(gdbNumber);
        if (!entry)
            return;
        const nowVerified = mi_parse_1.MINode.valueOf(bkpt, "pending") === undefined;
        const actualLine = parseInt(mi_parse_1.MINode.valueOf(bkpt, "line") || `${entry.line}`);
        entry.verified = nowVerified;
        entry.line = actualLine;
        const dbp = new debugadapter_1.Breakpoint(nowVerified, actualLine);
        dbp.setId(entry.id);
        const fullname = mi_parse_1.MINode.valueOf(bkpt, "fullname");
        if (fullname) {
            dbp.source = new debugadapter_1.Source(mi_parse_1.MINode.valueOf(bkpt, "file") || '', fullname);
        }
        this.sendEvent(new debugadapter_1.BreakpointEvent('changed', dbp));
    }
    // -----------------------------------------------------------------------
    // Helper methods
    // -----------------------------------------------------------------------
    /** Extract console stream output accumulated by MI2 sendCliCommand result */
    getConsoleOutput(node) {
        // MI2's sendCliCommand collects console stream lines into resultRecords?.results
        // via the consoleOutput mechanism — but our MI2 port doesn't expose that directly.
        // The 'msg' field is set by the pending.consoleOutput join in handleResultRecord.
        // Actually MINode.result('') won't work here because MINode uses a different structure.
        // We need to get the raw console output that was collected.
        // MI2.sendCommand accumulates consoleOutput and sets record.data.msg — but wait,
        // we ported MI2 which does NOT use MIRecord — it uses MINode from mi_parse.
        // The consoleOutput accumulation in code-debug's MI2 is done in handleResultRecord
        // which we did NOT port (we use onOutput instead).
        //
        // We need to retrieve it differently. The CLI command output goes as console-stream
        // records ('~"..."') which are emitted as 'msg' events with type 'console'.
        // But we need to capture them synchronously per-command.
        //
        // Solution: use sendCommand with interpreter-exec directly and collect the console
        // lines that arrive before the result record. We implement this via a buffered
        // approach in sendCliCommandBuffered below.
        if (!node)
            return '';
        // The consoleOutput is stored in node via our patched sendCommand
        return node._consoleOutput || '';
    }
    async fallbackPhysicalStackTrace(response, threadId) {
        const stack = await this.miDebugger.getStack(0, 200, threadId);
        const stackFrames = stack.map((f, i) => {
            const frameId = threadId * 10000 + parseInt(f.level || i);
            const sf = new debugadapter_1.StackFrame(frameId, f.function || '<unknown>', (f.file) ? new debugadapter_1.Source(f.fileName || '', f.file) : undefined, f.line || 0, 0);
            if (f.address) {
                sf.instructionPointerReference = f.address;
            }
            return sf;
        });
        response.body = { stackFrames, totalFrames: stackFrames.length };
        this.sendResponse(response);
    }
    async handleScopeVariables(response, threadId, frameLevel, scopeKind) {
        await this.miDebugger.sendCommand(`thread-select ${threadId}`);
        await this.miDebugger.sendCommand(`stack-select-frame ${frameLevel}`);
        let miVars;
        if (scopeKind === 'args') {
            const record = await this.miDebugger.sendCommand(`stack-list-arguments --all-values 0 0`);
            const stackArgs = record.result('stack-args');
            if (Array.isArray(stackArgs) && stackArgs.length > 0) {
                const frameEntry = mi_parse_1.MINode.valueOf(stackArgs[0], "@frame") || mi_parse_1.MINode.valueOf(stackArgs[0], "frame") || stackArgs[0];
                miVars = mi_parse_1.MINode.valueOf(frameEntry, "args") || frameEntry?.args;
            }
        }
        else {
            const record = await this.miDebugger.sendCommand('stack-list-locals --all-values');
            miVars = record.result('locals');
        }
        const variables = [];
        if (Array.isArray(miVars)) {
            for (const v of miVars) {
                const name = mi_parse_1.MINode.valueOf(v, "name") || '';
                const value = mi_parse_1.MINode.valueOf(v, "value") || '';
                const type = mi_parse_1.MINode.valueOf(v, "type") || '';
                let variablesReference = 0;
                if (this.looksExpandable(type, value)) {
                    try {
                        const varObj = await this.miDebugger.varCreate(threadId, frameLevel, name);
                        if (varObj.name) {
                            this.createdVarObjects.push(varObj.name);
                            if (varObj.isCompound()) {
                                const childRef = this.nextVarRef++;
                                this.varRefMap.set(childRef, { type: 'var', varName: varObj.name });
                                variablesReference = childRef;
                            }
                        }
                    }
                    catch {
                        // var-create failed
                    }
                }
                const variable = new debugadapter_1.Variable(name, value, variablesReference);
                variable.type = type;
                variables.push(variable);
            }
        }
        response.body = { variables };
        this.sendResponse(response);
    }
    async handleVarChildren(response, parentVarName) {
        const children = await this.miDebugger.varListChildren(parentVarName);
        const variables = children.map(child => {
            let variablesReference = 0;
            if (child.isCompound()) {
                const childRef = this.nextVarRef++;
                this.varRefMap.set(childRef, { type: 'var', varName: child.name });
                variablesReference = childRef;
            }
            const v = new debugadapter_1.Variable(child.exp || child.name, child.value ?? '', variablesReference);
            v.type = child.type;
            return v;
        });
        response.body = { variables };
        this.sendResponse(response);
    }
    looksExpandable(type, value) {
        if (value.startsWith('{'))
            return true;
        if (type.startsWith('[') || type.startsWith('&['))
            return true;
        if (type.startsWith('(') && type.includes(','))
            return true;
        if (/^(alloc::|std::)/.test(type))
            return true;
        if (type.includes('::') && !type.includes('*'))
            return true;
        return false;
    }
    async cleanupVariables() {
        for (const name of this.createdVarObjects) {
            await this.miDebugger.sendCommand(`var-delete ${name}`).catch(() => { });
        }
        this.createdVarObjects.length = 0;
        this.varRefMap.clear();
        this.nextVarRef = 1;
    }
}
exports.GDBDebugSession = GDBDebugSession;
//# sourceMappingURL=gdbDebugSession.js.map