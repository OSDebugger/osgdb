import * as fs from "fs";
import * as path from "path";

const SCAN_EXTENSIONS = new Set([".c", ".rs", ".S", ".s", ".h"]);

function scanDir(dir: string, marker: string, results: { filepath: string; line: number }[]) {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "target") continue;
            scanDir(full, marker, results);
        } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
            scanFile(full, marker, results);
        }
    }
}

function scanFile(filepath: string, marker: string, results: { filepath: string; line: number }[]) {
    let content: string;
    try {
        content = fs.readFileSync(filepath, "utf8");
    } catch {
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
export function scanMarker(cwd: string, marker: string): { filepath: string; line: number }[] {
    const results: { filepath: string; line: number }[] = [];
    scanDir(cwd, marker, results);
    return results;
}
