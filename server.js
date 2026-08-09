const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Tail } = require('tail');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURATION ---
const LOG_DIR = '/jnos/logs/';
const HEARD_FILE_PATH = '/jnos/AxHeardFile';
const MAIL_LOG_PATH = '/jnos/spool/mail.log';
const TRACE_LOG_PATH = '/jnos/trace.log';
const MAX_LOG_HISTORY = 200; // lines kept in memory to backfill new clients

// --- STATE (used to backfill clients that connect late) ---
let lastHeardList = [];
let lastUptimeSeconds = 0;
let mailHistory = [];
let logHistory = [];
let traceHistory = [];

// --- 1. MHEARD FILE WATCHER ---
// Converts a whole-second elapsed duration into DD:HH:MM:SS
function formatElapsed(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
    const pad = (n) => String(n).padStart(2, '0');
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${pad(days)}:${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function processHeardFile() {
    if (!fs.existsSync(HEARD_FILE_PATH)) return;

    fs.readFile(HEARD_FILE_PATH, 'utf8', (err, data) => {
        if (err) return;

        const lines = data.trim().split('\n');
        if (lines.length < 1) return;

        // Line 1 is a header: "<unix epoch now> <JNOS uptime counter in seconds>"
        // NOT a heard entry - the uptime counter is what "last heard" ticks
        // on each data line are measured against.
        const headerParts = lines[0].trim().split(/\s+/);
        const currentUptime = parseInt(headerParts[1], 10);
        if (isNaN(currentUptime)) return;

        const heardList = [];

        for (let i = 1; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            // Real column order: interface, callsign, last-heard-tick, bytes, (unused)
            if (parts.length < 4) continue;

            const lastHeardTick = parseInt(parts[2], 10);
            if (isNaN(lastHeardTick)) continue;

            heardList.push({
                callsign: parts[1] || '',
                interface: parts[0] || '',
                time: formatElapsed(currentUptime - lastHeardTick),
                packets: parts[3] || ''
            });
        }

        lastHeardList = heardList;
        lastUptimeSeconds = currentUptime;
        io.emit('mheard_update', heardList);
        io.emit('uptime_update', currentUptime);
    });
}

// FIX: comparing Date objects with !== is always true (different instances
// each stat call), so this used to fire on every 2s poll regardless of
// whether the file actually changed. Compare epoch ms instead.
fs.watchFile(HEARD_FILE_PATH, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) processHeardFile();
});
processHeardFile(); // Initial load

// --- 2. LOG FILE TAILER (Daily Rotation) ---
function getDailyLogFilename() {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[now.getMonth()];
    const year = String(now.getFullYear()).slice(-2);
    return `${day}${monthStr}${year}`;
}

function classifyLogLine(line) {
    if (line.match(/bbs:?|mailbox:?|mbox:?|fbb:?/i)) return 'bbs';
    if (line.match(/AX25:|Node:|digipeat/i)) return 'ax25';
    if (line.includes('TCP:')) return 'tcp';
    return 'system';
}

// Tracks who's currently logged into MBOX, driven by lines like:
//   "20:16:44 44.68.180.11:53162 - MBOX (k1ymi) login"
//   "20:17:00 44.68.180.11:53162 - MBOX (k1ymi) exit"
// A Set (rather than a raw +1/-1 counter) means a duplicate login for
// someone already in doesn't double-count them, and a stray exit with
// no matching login (e.g. one that happened before this server started)
// can't push the count negative.
let mboxUsers = new Set();

function checkMboxSession(line) {
    const m = line.match(/MBOX \(([^)]+)\)\s+(login|exit)/i);
    if (!m) return;

    const callsign = m[1];
    const action = m[2].toLowerCase();

    if (action === 'login') mboxUsers.add(callsign);
    else mboxUsers.delete(callsign);

    io.emit('mbox_users_update', mboxUsers.size);
}

// Reads the last `count` non-empty lines of a file synchronously.
// Used only at startup to seed history - fine to block briefly since
// this runs once before the server starts accepting connections.
function readLastLines(filePath, count) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.length > 0);
        return lines.slice(-count);
    } catch (err) {
        console.error(`Failed to read ${filePath}:`, err);
        return [];
    }
}

let currentTail = null;
let currentLogPath = '';
let logTailerStarted = false; // seed last-5-lines history only on the very first successful open

function tailLogFile() {
    const expectedFilename = getDailyLogFilename();
    const expectedPath = path.join(LOG_DIR, expectedFilename);

    if (currentLogPath === expectedPath && currentTail) return; // already tailing today's file

    // FIX: previously this set currentLogPath = expectedPath BEFORE checking
    // fs.existsSync, so if the new day's file wasn't created yet at the exact
    // moment of a midnight check (a real race), the function locked onto a
    // path that didn't exist and every later 60s check short-circuited on
    // "currentLogPath === expectedPath" without ever retrying. Now we only
    // commit currentLogPath once the file is confirmed to exist.
    if (!fs.existsSync(expectedPath)) return;

    if (currentTail) {
        currentTail.unwatch();
        currentTail = null;
    }

    currentLogPath = expectedPath;

    if (!logTailerStarted) {
        logTailerStarted = true;
        readLastLines(currentLogPath, 5).forEach(line => {
            const entry = {
                category: classifyLogLine(line),
                text: line,
                time: new Date().toLocaleTimeString('en-GB')
            };
            logHistory.push(entry);
            checkMboxSession(line);
        });
    }

    try {
        currentTail = new Tail(currentLogPath, { follow: true, fromBeginning: false });
        currentTail.on('line', (line) => {
            const entry = {
                category: classifyLogLine(line),
                text: line,
                time: new Date().toLocaleTimeString('en-GB')
            };

            logHistory.push(entry);
            if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();

            io.emit('jnos_update', entry);
            checkMboxSession(line);
        });
        currentTail.on('error', (err) => {
            console.error(`Tail error on ${currentLogPath}:`, err);
        });
    } catch (err) {
        console.error(`Failed to tail ${currentLogPath}:`, err);
    }
}

tailLogFile();
setInterval(tailLogFile, 60 * 1000); // Check for date change every minute

// --- 3. MAIL LOG TAILER (queue/deliver events -> Sender/Recipient/Subject/Type/Time) ---
// Format seen in /jnos/spool/mail.log:
//   "Wed Aug  5 12:59:43 2026 queue job 158588 To: wng704@wxalrt From: n2mh%...@k1ymi.ampr.org"
// Two deliver formats have been observed - older lines include Msg-Id and
// Subject, newer ones drop both:
//   "Wed Aug  5 12:59:52 2026 deliver Msg-Id: Y1H307R_PWXB@n2mh.bbs To: hold From: n2mh%...@k1ymi.ampr.org Subject: Flash flood warning: WXM60 Southard, NJ"
//   "Sun Aug  9 12:01:18 2026 deliver: To: tcpip From: dl5ocd%db0alg.#nds.deu.eu@k1ymi.ampr.org"
// Msg-Id and Subject are both optional in the regex below so either format
// parses correctly.
// Note: this is event metadata from the log, not the message file itself,
// so there's no file size to report here (unlike JHeard/AxHeardFile).
function parseMailLogLine(line) {
    let m = line.match(/^(.+?) queue job (\S+) To: (\S+) From: (\S+)$/);
    if (m) {
        return {
            type: 'queue',
            timestamp: formatMailTimestamp(m[1]),
            to: m[3],
            from: m[4],
            subject: ''
        };
    }

    m = line.match(/^(.+?) deliver:?\s*(?:Msg-Id:\s*(\S+)\s+)?To:\s*(\S+)\s+From:\s*(\S+)(?:\s+Subject:\s*(.+))?$/);
    if (m) {
        return {
            type: 'deliver',
            timestamp: formatMailTimestamp(m[1]),
            to: m[3],
            from: m[4],
            subject: m[5] || ''
        };
    }

    return null; // unrecognized line format - skip rather than guess
}

function formatMailTimestamp(rawTimestamp) {
    const d = new Date(rawTimestamp);
    if (isNaN(d.getTime())) return rawTimestamp; // fallback: show raw string
    return d.toLocaleTimeString('en-GB'); // 24hr HH:MM:SS, consistent with rest of dashboard
}

let mailTail = null;

function tailMailLog() {
    if (!fs.existsSync(MAIL_LOG_PATH)) {
        console.error(`Mail log not found at ${MAIL_LOG_PATH}`);
        return;
    }

    readLastLines(MAIL_LOG_PATH, 5).forEach(line => {
        const parsed = parseMailLogLine(line);
        if (parsed) mailHistory.push(parsed);
    });

    try {
        mailTail = new Tail(MAIL_LOG_PATH, { follow: true, fromBeginning: false });
        mailTail.on('line', (line) => {
            const parsed = parseMailLogLine(line);
            if (!parsed) return;

            mailHistory.push(parsed);
            if (mailHistory.length > MAX_LOG_HISTORY) mailHistory.shift();

            io.emit('mail_update', parsed);
        });
        mailTail.on('error', (err) => {
            console.error(`Mail log tail error:`, err);
        });
    } catch (err) {
        console.error(`Failed to tail ${MAIL_LOG_PATH}:`, err);
    }
}

tailMailLog();

// --- 4. AX.25 TRACE LOG TAILER ---
// Plain static file, no daily rotation - same simple pattern as mail.log.
// Displayed as raw lines (no field parsing) since the format isn't
// structured metadata the way mail.log's queue/deliver lines are.
//
// Two things ARE parsed out of it: who's connected (callsign + version),
// and disconnect. AX.25 2.2 negotiates extended (mod-128) operation with a
// SABME frame; legacy AX.25 (v1/v2.0) uses plain SABM (mod-8). The callsign
// on the left of "->" is the connecting station. A DISC frame marks a
// disconnect. Lines look like:
//   "AX25: K1YMI->LFALLS SABME(P)"
//   "AX25: K1YMI->LFALLS DISC(P)"
// Shows the most recently detected connection's callsign+version (or
// 'none' once disconnected), same "current state" pattern as MBox Users.
let traceTail = null;
let lastAx25Status = { callsign: null, version: 'none' };

function checkAx25Status(line) {
    const setupMatch = line.match(/AX25: (\S+)->\S+ (SABME?)\(P\)/);
    if (setupMatch) {
        lastAx25Status = {
            callsign: setupMatch[1],
            version: setupMatch[2] === 'SABME' ? 'vr2.2' : 'vr2.0'
        };
        io.emit('ax25_status_update', lastAx25Status);
        return;
    }

    const discMatch = line.match(/AX25: \S+->\S+ DISC(\(P\))?/);
    if (discMatch) {
        lastAx25Status = { callsign: null, version: 'none' };
        io.emit('ax25_status_update', lastAx25Status);
    }
}

function tailTraceLog() {
    if (!fs.existsSync(TRACE_LOG_PATH)) {
        console.error(`Trace log not found at ${TRACE_LOG_PATH}`);
        return;
    }

    readLastLines(TRACE_LOG_PATH, 5).forEach(line => {
        traceHistory.push({ text: line, time: new Date().toLocaleTimeString('en-GB') });
        checkAx25Status(line);
    });

    try {
        traceTail = new Tail(TRACE_LOG_PATH, { follow: true, fromBeginning: false });
        traceTail.on('line', (line) => {
            const entry = { text: line, time: new Date().toLocaleTimeString('en-GB') };

            traceHistory.push(entry);
            if (traceHistory.length > MAX_LOG_HISTORY) traceHistory.shift();

            io.emit('trace_update', entry);
            checkAx25Status(line);
        });
        traceTail.on('error', (err) => {
            console.error(`Trace log tail error:`, err);
        });
    } catch (err) {
        console.error(`Failed to tail ${TRACE_LOG_PATH}:`, err);
    }
}

tailTraceLog();

// --- 4. BACKFILL NEW CLIENTS ---
// FIX: processHeardFile() only runs once at boot, and log lines only flow
// as they happen — a browser tab opened later previously saw nothing until
// the next update. Push current state on connect.
io.on('connection', (socket) => {
    socket.emit('mheard_update', lastHeardList);
    socket.emit('uptime_update', lastUptimeSeconds);
    socket.emit('log_history', logHistory);
    socket.emit('mail_history', mailHistory);
    socket.emit('trace_history', traceHistory);
    socket.emit('mbox_users_update', mboxUsers.size);
    socket.emit('ax25_status_update', lastAx25Status);
});

// --- START SERVER ---
server.listen(3000, () => {
    console.log(`JNOS Web Console running on port 3000`);
});
