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
exports.scanMarker = scanMarker;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const SCAN_EXTENSIONS = new Set([".c", ".rs", ".S", ".s", ".h"]);
function scanDir(dir, marker, results) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target")
                continue;
            scanDir(full, marker, results);
        }
        else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
            scanFile(full, marker, results);
        }
    }
}
function scanFile(filepath, marker, results) {
    let content;
    try {
        content = fs.readFileSync(filepath, "utf8");
    }
    catch {
        return;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(marker)) {
            // The breakpoint goes on the next line (the line after the marker comment)
            const targetLine = i + 2; // 1-based, next line
            if (targetLine <= lines.length) {
                results.push({ filepath, line: targetLine });
            }
        }
    }
}
/**
 * Scan all source files under cwd for lines containing marker,
 * and return the file+line of the line immediately following each match.
 */
function scanMarker(cwd, marker) {
    const results = [];
    scanDir(cwd, marker, results);
    return results;
}
//# sourceMappingURL=markerScanner.js.map