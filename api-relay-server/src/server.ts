#!/usr/bin/env node
console.log("SERVER.TS: Top of file reached - src/server.ts is being executed.");
/*
 * Chat Relay: Relay for AI Chat Interfaces
 * Copyright (C) 2025 Jamison Moore
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see https://www.gnu.org/licenses/.
 */
import bodyParser from 'body-parser';
import { execSync } from 'child_process'; // Import for executing commands
import cors from 'cors';
import express, { NextFunction, Request, Response, Router } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import os from 'os';

// Load .env file variables into process.env
const envPath = path.resolve(__dirname, '../relay.settings');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const [key, ...vals] = line.split('=');
    if (key && vals.length) process.env[key.trim()] = vals.join('=').trim();
  }
  console.log(`SERVER.TS: relay.settings loaded from ${envPath}`);
} else {
  console.warn(`SERVER.TS: relay.settings file not found at ${envPath}`);
}

const ENV_FILE_PATH = envPath;
const TS_VALID_STRATEGIES = ["queue", "drop"];

// --- Initialize settings from .env or use defaults ---
let newRequestBehavior: 'queue' | 'drop' = process.env.MESSAGE_SEND_STRATEGY && TS_VALID_STRATEGIES.includes(process.env.MESSAGE_SEND_STRATEGY as any)
  ? process.env.MESSAGE_SEND_STRATEGY as 'queue' | 'drop'
  : 'queue';

let currentRequestTimeoutMs: number = process.env.REQUEST_TIMEOUT_MS && !isNaN(parseInt(process.env.REQUEST_TIMEOUT_MS, 10)) && parseInt(process.env.REQUEST_TIMEOUT_MS, 10) > 0
  ? parseInt(process.env.REQUEST_TIMEOUT_MS, 10)
  : 120000;

let serverPortForListen: number = process.env.PORT && !isNaN(parseInt(process.env.PORT, 10)) && parseInt(process.env.PORT, 10) > 0
  ? parseInt(process.env.PORT, 10)
  : 3003;

let autoKillPort: boolean = process.env.AUTO_KILL_PORT === 'true' || false;

// Simple log collection system
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

const logHistory: LogEntry[] = [];
const MAX_LOGS = 100;

// Override console methods to capture logs
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

function addLogEntry(level: 'info' | 'warn' | 'error', message: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };
  logHistory.push(entry);
  if (logHistory.length > MAX_LOGS) {
    logHistory.shift(); // Remove oldest entry
  }
}

console.log = (...args: any[]) => {
  const message = args.join(' ');
  addLogEntry('info', message);
  originalConsoleLog(...args);
};

console.warn = (...args: any[]) => {
  const message = args.join(' ');
  addLogEntry('warn', message);
  originalConsoleWarn(...args);
};

console.error = (...args: any[]) => {
  const message = args.join(' ');
  addLogEntry('error', message);
  originalConsoleError(...args);
};

console.log(`SERVER.TS: Initial effective settings - Strategy: ${newRequestBehavior}, Timeout: ${currentRequestTimeoutMs}ms, Port: ${serverPortForListen}, AutoKillPort: ${autoKillPort}`);

// Interfaces
interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  accumulatedResponse?: string;
}
interface WebSocketMessage {
  type: string;
  requestId?: number;
  message?: string;
  response?: string;
  chunk?: string;
  isFinal?: boolean;
  error?: string;
  settings?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    new_chat?: boolean;
  };
}

interface QueuedRequest {
  requestId: number;
  req: Request;
  res: Response;
  userMessage: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  new_chat?: boolean;
}
let requestQueue: QueuedRequest[] = [];

// Global variables
let activeConnections: WebSocket[] = [];
const pendingRequests = new Map<number, PendingRequest>();
let requestCounter = 0;
let activeExtensionProcessingId: number | null = null;
let activeExtensionSocketId: string | null = null; // Stores the socketId of the extension processing the current request

// In-memory store for admin messages
interface ModelSettings {
  model?: string;
  temperature?: number;
  max_tokens?: number;
}
interface ChatRequestData {
  fromClient: string;
  toExtension: WebSocketMessage;
  modelSettings: ModelSettings;
}
interface ChatResponseData {
  fromExtension: string;
  toClient: any;
  status: string;
}
interface ChatErrorData {
  toClientError: any;
  status: string;
}
type AdminLogDataType = ChatRequestData | ChatResponseData | ChatErrorData | any;
interface AdminLogEntry {
  timestamp: string;
  type:
    | 'CHAT_REQUEST_RECEIVED'
    | 'CHAT_RESPONSE_SENT'
    | 'CHAT_ERROR_RESPONSE_SENT'
    | 'CHAT_REQUEST_QUEUED'
    | 'CHAT_REQUEST_DROPPED'
    | 'CHAT_REQUEST_DEQUEUED'
    | 'CHAT_REQUEST_PROCESSING'
    | 'CHAT_REQUEST_ERROR'
    | 'REQUEST_CANCELLED_DISCONNECT'
    | 'REQUEST_CANCELLED_TIMEOUT'
    | 'REQUEST_CANCELLED_REFRESH'
    | 'EXTENSION_READY'
    | 'SETTING_UPDATE'
    | string;
  requestId: string;
  data: AdminLogDataType;
}
const MAX_ADMIN_HISTORY_LENGTH = 1000;
let adminMessageHistory: AdminLogEntry[] = [];
const serverStartTime = Date.now();

// Function to update .env file
function updateEnvFile(settingsToUpdate: Record<string, string | number | boolean>) {
  let envContent = "";
  if (fs.existsSync(ENV_FILE_PATH)) {
    envContent = fs.readFileSync(ENV_FILE_PATH, 'utf8');
  }
  let lines = envContent.split(os.EOL).map(line => line.trim()).filter(line => line);
  const newLinesToAdd: string[] = [];
  for (const key in settingsToUpdate) {
    const value = settingsToUpdate[key];
    const settingLine = `${key}=${value}`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`${key}=`)) {
        lines[i] = settingLine;
        found = true;
        break;
      }
    }
    if (!found) {
      newLinesToAdd.push(settingLine);
    }
  }
  lines = lines.concat(newLinesToAdd);
  const finalContent = lines.join(os.EOL) + (lines.length > 0 ? os.EOL : '');
  try {
    fs.writeFileSync(ENV_FILE_PATH, finalContent, 'utf8');
    console.log(`SERVER.TS: Settings saved to ${ENV_FILE_PATH}. Content: \n${finalContent}`);
  } catch (error) {
    console.error(`SERVER.TS: Error saving settings to ${ENV_FILE_PATH}:`, error);
  }
}

// Ensure .env file exists with current/default settings
const initialEnvSettingsToEnsure: Record<string, string | number> = {};
if (!process.env.MESSAGE_SEND_STRATEGY || !TS_VALID_STRATEGIES.includes(process.env.MESSAGE_SEND_STRATEGY as any)) {
    initialEnvSettingsToEnsure.MESSAGE_SEND_STRATEGY = newRequestBehavior;
}
if (!process.env.REQUEST_TIMEOUT_MS || isNaN(parseInt(process.env.REQUEST_TIMEOUT_MS, 10)) || parseInt(process.env.REQUEST_TIMEOUT_MS, 10) <= 0) {
    initialEnvSettingsToEnsure.REQUEST_TIMEOUT_MS = currentRequestTimeoutMs;
}
if (!process.env.PORT || isNaN(parseInt(process.env.PORT, 10)) || parseInt(process.env.PORT, 10) <= 0) {
    initialEnvSettingsToEnsure.PORT = serverPortForListen;
}
if (process.env.AUTO_KILL_PORT === undefined) {
    initialEnvSettingsToEnsure.AUTO_KILL_PORT = autoKillPort.toString();
}
if (Object.keys(initialEnvSettingsToEnsure).length > 0) {
    console.log("SERVER.TS: Initializing/updating .env file with current/default settings:", initialEnvSettingsToEnsure);
    updateEnvFile(initialEnvSettingsToEnsure);
} else {
    console.log(`SERVER.TS: .env file at ${ENV_FILE_PATH} found and all required settings appear present.`);
}

// Create Express app
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Middleware to log all request paths
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`SERVER.TS: Incoming request: ${req.method} ${req.path}`);
  next();
});

console.log(`SERVER.TS: Loaded - Strategy: ${newRequestBehavior}, Timeout: ${currentRequestTimeoutMs}ms, Port: ${serverPortForListen}`);

// Interface for Admin Settings Payload
interface AdminSettingsPayload {
  messageSendStrategy?: 'queue' | 'drop';
  requestTimeout?: number | string; // Allow string from form, parse to number
  serverPort?: number | string;   // Allow string from form, parse to number
  autoKillPort?: boolean;
}

// --- Admin API Routes (using .env) ---
app.get('/admin/settings', (req: Request, res: Response) => {
  console.log(`SERVER.TS: Handling GET /admin/settings. Current settings: Strategy=${newRequestBehavior}, Timeout=${currentRequestTimeoutMs}, Port=${serverPortForListen}, AutoKillPort=${autoKillPort}`);
  res.status(200).json({
    messageSendStrategy: newRequestBehavior,
    requestTimeout: currentRequestTimeoutMs,
    serverPort: serverPortForListen,
    autoKillPort: autoKillPort
  });
});
console.log("SERVER.TS: DEFINED ROUTE: GET /admin/settings");

app.post('/admin/settings', (req: Request<{}, any, AdminSettingsPayload>, res: Response) => {
  const { messageSendStrategy, requestTimeout, serverPort, autoKillPort: newAutoKillPort } = req.body;
  let changesMade = false;
  let errors: string[] = [];
  const settingsToSaveToEnv: Record<string, string | number> = {};

  if (messageSendStrategy !== undefined) {
    if (TS_VALID_STRATEGIES.includes(messageSendStrategy as any)) {
      newRequestBehavior = messageSendStrategy as 'queue' | 'drop';
      settingsToSaveToEnv.MESSAGE_SEND_STRATEGY = newRequestBehavior;
      console.log(`SERVER.TS: Handling POST /admin/settings - Strategy updated to: ${newRequestBehavior}`);
      changesMade = true;
    } else {
      errors.push(`Invalid messageSendStrategy. Must be one of: ${TS_VALID_STRATEGIES.join(', ')}`);
      console.warn(`SERVER.TS: Handling POST /admin/settings - Invalid strategy: ${messageSendStrategy}`);
    }
  }

  if (requestTimeout !== undefined) {
    const timeoutMs = parseInt(String(requestTimeout), 10);
    if (!isNaN(timeoutMs) && timeoutMs > 0) {
      currentRequestTimeoutMs = timeoutMs;
      settingsToSaveToEnv.REQUEST_TIMEOUT_MS = currentRequestTimeoutMs;
      console.log(`SERVER.TS: Handling POST /admin/settings - Timeout updated to: ${currentRequestTimeoutMs}ms`);
      changesMade = true;
    } else {
      errors.push('Invalid requestTimeout. Must be a positive number.');
      console.warn(`SERVER.TS: Handling POST /admin/settings - Invalid timeout: ${requestTimeout}`);
    }
  }

  if (serverPort !== undefined) {
    const portNum = parseInt(String(serverPort), 10);
    if (!isNaN(portNum) && portNum > 0 && portNum < 65536) {
      serverPortForListen = portNum;
      settingsToSaveToEnv.PORT = serverPortForListen;
      console.log(`SERVER.TS: Handling POST /admin/settings - Port updated to: ${serverPortForListen}`);
      changesMade = true;
    } else {
      errors.push('Invalid serverPort. Must be a number between 1 and 65535.');
      console.warn(`SERVER.TS: Handling POST /admin/settings - Invalid port: ${serverPort}`);
    }
  }

  if (newAutoKillPort !== undefined) {
    if (typeof newAutoKillPort === 'boolean') {
      autoKillPort = newAutoKillPort;
      settingsToSaveToEnv.AUTO_KILL_PORT = autoKillPort.toString();
      console.log(`SERVER.TS: Handling POST /admin/settings - AutoKillPort updated to: ${autoKillPort}`);
      changesMade = true;
    } else {
      errors.push('Invalid autoKillPort. Must be a boolean.');
      console.warn(`SERVER.TS: Handling POST /admin/settings - Invalid autoKillPort: ${newAutoKillPort}`);
    }
  }

  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  if (changesMade && Object.keys(settingsToSaveToEnv).length > 0) {
    updateEnvFile(settingsToSaveToEnv);
    res.status(200).json({
      message: 'Settings updated. .env file modified, server may restart.',
      currentSettings: {
        messageSendStrategy: newRequestBehavior,
        requestTimeout: currentRequestTimeoutMs,
        serverPort: serverPortForListen,
        autoKillPort: autoKillPort
      }
    });
  } else {
    res.status(200).json({
      message: 'No valid settings were changed.',
      currentSettings: {
        messageSendStrategy: newRequestBehavior,
        requestTimeout: currentRequestTimeoutMs,
        serverPort: serverPortForListen,
        autoKillPort: autoKillPort
      }
    });
  }
});
console.log("SERVER.TS: DEFINED ROUTE: POST /admin/settings");

// Logs endpoint
app.get('/admin/logs', (req: Request, res: Response) => {
  console.log(`SERVER.TS: Handling GET /admin/logs. Returning ${logHistory.length} log entries.`);
  res.status(200).json(logHistory);
});
console.log("SERVER.TS: DEFINED ROUTE: GET /admin/logs");

// --- End Admin API Routes ---

// Admin UI: Serve static files
const adminUIDirectory = path.join(__dirname, '../src/admin-ui');
app.use('/admin', express.static(adminUIDirectory));
app.get('/admin', (req: Request, res: Response) => { // Redirect /admin to /admin/admin.html
    res.redirect('/admin/admin.html');
});

// Create HTTP server & WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// WebSocket server logic
wss.on('connection', (ws: WebSocket) => {
  (ws as any).socketId = Date.now().toString(36) + Math.random().toString(36).substring(2); // Assign unique ID
  console.log(`SERVER.TS: Browser extension connected with socketId: ${(ws as any).socketId}`);
  activeConnections.push(ws);
  ws.on('message', (message: string) => {
    try {
      const data: WebSocketMessage = JSON.parse(message.toString());
      const currentSocketId = (ws as any).socketId;
      let requestIdToProcess: number | undefined = data.requestId;
      let responseDataToUse: string | undefined = undefined;
      let isErrorMessage = false;

      console.log(`SERVER.TS: WebSocket message received from socketId ${currentSocketId}: type=${data.type}, requestId=${data.requestId}`);

      if (data.type === 'EXTENSION_READY') {
        console.log(`SERVER.TS: Extension with socketId ${currentSocketId} reported EXTENSION_READY.`);
        logAdminMessage('EXTENSION_READY', 'N/A', { socketId: currentSocketId }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
        // Future: If the extension had a persistent ID, we could check if it was previously
        // processing a request and mark it as "Cancelled (Extension Refreshed)".
        // For now, the disconnect/reconnect logic based on socketId handles most stale states.
        return;
      } else if (data.type === 'PING') {
        // Heartbeat, no response needed but we acknowledge it in debug logs if needed
        return;
      } else if (data.type === 'LOG_MESSAGE') {
        // Log messages from the extension to the admin log
        logAdminMessage('EXTENSION_LOG', data.requestId || 'N/A', { 
            socketId: currentSocketId, 
            logLevel: (data as any).level || 'info', 
            logMessage: (data as any).message 
        }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
        return;
      } else if (data.type === 'CHAT_RESPONSE') {
        const pendingRequest = pendingRequests.get(data.requestId!);
        if (pendingRequest) {
          // Buffer the response
          pendingRequest.accumulatedResponse = data.response;
          
          if (data.isFinal === true) {
            responseDataToUse = pendingRequest.accumulatedResponse;
            console.log(`SERVER.TS: CHAT_RESPONSE is FINAL for requestId: ${data.requestId}. Data length: ${responseDataToUse?.length}`);
          } else {
            console.log(`SERVER.TS: CHAT_RESPONSE partial for requestId: ${data.requestId}. Buffering...`);
            return; // Don't process yet, wait for final
          }
        } else {
          console.warn(`SERVER.TS: Received CHAT_RESPONSE for unknown requestId: ${data.requestId}`);
          return;
        }
      } else if (data.type === 'CHAT_RESPONSE_CHUNK' && data.isFinal === true) {
        responseDataToUse = data.chunk;
      } else if (data.type === 'CHAT_RESPONSE_ERROR') {
        responseDataToUse = data.error || "Unknown error from extension";
        isErrorMessage = true;
      } else if (data.type === 'CHAT_RESPONSE_STREAM_ENDED') {
        console.log(`SERVER.TS: Received CHAT_RESPONSE_STREAM_ENDED for requestId: ${data.requestId} from socketId ${currentSocketId}. No action as final data comes in CHUNK.`);
        return;
      } else {
        console.log(`SERVER.TS: Unhandled WebSocket message type: ${data.type} for requestId: ${data.requestId} from socketId ${currentSocketId}`);
        return;
      }

      if (requestIdToProcess !== undefined) {
        const pendingRequest = pendingRequests.get(requestIdToProcess);
        if (pendingRequest) {
          if (isErrorMessage) {
            console.error(`SERVER.TS: Rejecting request ${requestIdToProcess} with error: ${responseDataToUse}`);
            pendingRequest.reject(new Error(responseDataToUse || "Error from extension"));
          } else {
            console.log(`SERVER.TS: Resolving request ${requestIdToProcess} with data (first 100 chars): ${(responseDataToUse || "").substring(0,100)}`);
            pendingRequest.resolve(responseDataToUse);
          }
          pendingRequests.delete(requestIdToProcess);
          if (activeExtensionProcessingId === requestIdToProcess) { // Check if this was the active request
            activeExtensionProcessingId = null;
            activeExtensionSocketId = null; // Clear the socket ID
            console.log(`SERVER.TS: Request ${requestIdToProcess} ${isErrorMessage ? 'rejected' : 'resolved'} and removed. Extension and socket ID freed.`);
          } else {
            console.log(`SERVER.TS: Request ${requestIdToProcess} ${isErrorMessage ? 'rejected' : 'resolved'} and removed. It was not the primary active request (${activeExtensionProcessingId}).`);
          }
          processNextInQueue();
        } else {
          console.warn(`SERVER.TS: Received response for unknown/timed-out requestId: ${requestIdToProcess} from socketId ${currentSocketId}.`);
        }
      } else {
        console.warn(`SERVER.TS: WebSocket message received from socketId ${currentSocketId} but no requestId. Type: ${data.type}`);
      }
    } catch (error) {
      const currentSocketIdForError = (ws as any).socketId;
      console.error(`SERVER.TS: Error processing WebSocket message from socketId ${currentSocketIdForError}:`, error, 'Raw message:', message.toString());
    }
  });
  ws.on('close', () => {
    const closedSocketId = (ws as any).socketId;
    console.log(`SERVER.TS: Browser extension with socketId: ${closedSocketId} disconnected`);
    activeConnections = activeConnections.filter(conn => (conn as any).socketId !== closedSocketId);

    if (closedSocketId && closedSocketId === activeExtensionSocketId) {
      console.log(`SERVER.TS: Extension ${closedSocketId} was processing request ${activeExtensionProcessingId}. Attempting to cancel.`);
      if (activeExtensionProcessingId !== null) {
        const pendingRequest = pendingRequests.get(activeExtensionProcessingId);
        if (pendingRequest) {
          const errorMessage = `Request ${activeExtensionProcessingId} cancelled: Extension ${closedSocketId} disconnected.`;
          console.log(`SERVER.TS: ${errorMessage}`);
          pendingRequest.reject(new Error(errorMessage));
          pendingRequests.delete(activeExtensionProcessingId);
        }
        logAdminMessage('REQUEST_CANCELLED_DISCONNECT', activeExtensionProcessingId, {
          reason: 'Extension disconnected',
          socketId: closedSocketId
        }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
        
        activeExtensionProcessingId = null;
        activeExtensionSocketId = null;
        console.log(`SERVER.TS: Freed up extension. activeExtensionProcessingId is now null. Processing next in queue.`);
        processNextInQueue();
      } else {
        console.log(`SERVER.TS: Extension ${closedSocketId} disconnected, but no activeExtensionProcessingId was set for it. No request to cancel.`);
      }
    } else {
        console.log(`SERVER.TS: Extension ${closedSocketId} disconnected, but it was not the active processor (active is ${activeExtensionSocketId}). No request cancellation needed from this event.`);
    }
  });
  ws.on('error', (error) => {
    console.error('SERVER.TS: WebSocket error:', error);
  });
});

async function logAdminMessage(type: AdminLogEntry['type'], requestId: string | number, data: AdminLogDataType): Promise<void> {
  const timestamp = new Date().toISOString();
  const logEntry: AdminLogEntry = { timestamp, type, requestId: String(requestId), data };
  adminMessageHistory.unshift(logEntry);
  if (adminMessageHistory.length > MAX_ADMIN_HISTORY_LENGTH) {
    adminMessageHistory.pop();
  }
}

async function processOrQueueRequest(queuedItem: QueuedRequest): Promise<void> {
  const { requestId, req, res, userMessage, model, temperature, max_tokens, new_chat } = queuedItem;

  logAdminMessage('CHAT_REQUEST_RECEIVED', requestId, { 
    fromClient: userMessage, 
    modelSettings: { model, temperature, max_tokens },
    currentActiveExtensionProcessingId: activeExtensionProcessingId,
    newRequestBehaviorSetting: newRequestBehavior
  }).catch(err => console.error("ADMIN_LOG_ERROR:", err));

  if (activeConnections.length === 0) {
    console.log(`SERVER.TS: Request ${requestId} - No extension. Responding 503.`);
    logAdminMessage('CHAT_REQUEST_ERROR', requestId, { reason: "No extension" }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
    if (!res.headersSent) res.status(503).json({ error: { message: "No browser extension connected." } });
    return;
  }

  if (activeExtensionProcessingId !== null) {
    if (newRequestBehavior === 'drop') {
      console.log(`SERVER.TS: Request ${requestId} dropped (extension busy with ${activeExtensionProcessingId}).`);
      logAdminMessage('CHAT_REQUEST_DROPPED', requestId, { reason: "Extension busy" }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
      if (!res.headersSent) res.status(429).json({ error: { message: "Too Many Requests: Extension busy." } });
      return;
    } else { 
      requestQueue.push(queuedItem);
      console.log(`SERVER.TS: Request ${requestId} queued. Position: ${requestQueue.length}.`);
      logAdminMessage('CHAT_REQUEST_QUEUED', requestId, { queuePosition: requestQueue.length }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
      return;
    }
  }

  activeExtensionProcessingId = requestId;
  const extension = activeConnections[0];
  activeExtensionSocketId = (extension as any).socketId;
  console.log(`SERVER.TS: Processing request ${requestId} directly. ActiveID: ${activeExtensionProcessingId}, Assigned to Extension Socket: ${activeExtensionSocketId}`);
  logAdminMessage('CHAT_REQUEST_PROCESSING', requestId, { status: 'Sending to extension', socketId: activeExtensionSocketId }).catch(err => console.error("ADMIN_LOG_ERROR:", err));

  try {
    const responsePromise = new Promise<string>((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          const timedOutRequest = pendingRequests.get(requestId);
          if (timedOutRequest) {
            console.log(`SERVER.TS: Request ${requestId} timed out after ${currentRequestTimeoutMs}ms.`);
            timedOutRequest.reject(new Error(`Request ${requestId} timed out`));
          }
          pendingRequests.delete(requestId);

          logAdminMessage('REQUEST_CANCELLED_TIMEOUT', requestId, {
            reason: `Timed out after ${currentRequestTimeoutMs}ms`,
            socketId: activeExtensionSocketId
          }).catch(err => console.error("ADMIN_LOG_ERROR:", err));

          if (activeExtensionProcessingId === requestId) {
            console.log(`SERVER.TS: Timed out request ${requestId} was the active one. Clearing active state.`);
            activeExtensionProcessingId = null;
            activeExtensionSocketId = null;
            processNextInQueue();
          }
        }
      }, currentRequestTimeoutMs);
    });

    // const extension = activeConnections[0]; // Moved up to set activeExtensionSocketId
    const messageToExtension: WebSocketMessage = { type: 'SEND_CHAT_MESSAGE', requestId, message: userMessage, settings: { model, temperature, max_tokens, new_chat } };
    extension.send(JSON.stringify(messageToExtension));
    console.log(`SERVER.TS: Request ${requestId} sent to extension.`);

    const responseData = await responsePromise;
    const formattedResponse = {
      id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
      model: model || "relay-model",
      choices: [{ index: 0, message: { role: "assistant", content: responseData }, finish_reason: "stop" }],
      usage: { prompt_tokens: -1, completion_tokens: -1, total_tokens: -1 }
    };
    logAdminMessage('CHAT_RESPONSE_SENT', requestId, { fromExtension: responseData, toClient: formattedResponse, status: "Success" }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
    if (!res.headersSent) res.json(formattedResponse);

  } catch (error: any) {
    console.error(`SERVER.TS: Error processing request ${requestId}:`, error);
    logAdminMessage('CHAT_ERROR_RESPONSE_SENT', requestId, { toClientError: { message: error.message }, status: "Error" }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
    if (!res.headersSent) res.status(500).json({ error: { message: error.message || "Error processing request." } });
  } finally {
    const currentActiveId = activeExtensionProcessingId; // Capture current state before any changes
    
    if (currentActiveId === requestId) {
        // This path is typically hit if the request timed out on the server-side
        // before the extension sent any final message, and no other handler (ws.onmessage, ws.onclose)
        // has cleared the active ID for this specific request yet.
        console.log(`SERVER.TS: Request ${requestId} (which was active) finalizing. Clearing active state in 'finally' block.`);
        activeExtensionProcessingId = null;
        activeExtensionSocketId = null;
    } else if (currentActiveId === null) {
        // This means activeExtensionProcessingId was already cleared, likely by the WebSocket 'onmessage'
        // handler (if extension sent a response/error) or by the 'onclose' handler (if extension disconnected).
        console.log(`SERVER.TS: Request ${requestId} finalizing. Active processing ID was already null (cleared by ws.onmessage or ws.onclose).`);
    } else { // currentActiveId is not null AND not equal to requestId
        console.log(`SERVER.TS: Request ${requestId} finalizing, but a different request (${currentActiveId}) is currently active. No change to active state for ${currentActiveId}.`);
    }
    
    pendingRequests.delete(requestId);
    console.log(`SERVER.TS: Request ${requestId} removed from pendingRequests map. Calling processNextInQueue.`);
    processNextInQueue();
  }
}

function processNextInQueue() {
  if (activeExtensionProcessingId === null && requestQueue.length > 0) {
    const nextRequest = requestQueue.shift();
    if (nextRequest) {
      console.log(`SERVER.TS: Dequeuing request ${nextRequest.requestId}. Queue length: ${requestQueue.length}`);
      logAdminMessage('CHAT_REQUEST_DEQUEUED', nextRequest.requestId, { queueLength: requestQueue.length }).catch(err => console.error("ADMIN_LOG_ERROR:", err));
      processOrQueueRequest(nextRequest).catch(e => console.error("Error from dequeued processOrQueueRequest:", e));
    }
  }
}

const apiRouter: Router = express.Router();

apiRouter.post('/chat/completions', async (req: Request, res: Response): Promise<void> => {
  const requestId = requestCounter++;
  const { messages, model, temperature, max_tokens, stream, new_chat } = req.body;

  // Basic validation
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    console.error(`SERVER.TS: Invalid request to /chat/completions - 'messages' is missing or not a non-empty array. Body:`, req.body);
    res.status(400).json({ error: { message: "Request body must contain a non-empty 'messages' array." } });
    return;
  }
  const userMessage = messages[messages.length - 1].content;
  if (typeof userMessage !== 'string') {
      console.error(`SERVER.TS: Invalid request to /chat/completions - last message 'content' is not a string. Body:`, req.body);
      res.status(400).json({ error: { message: "The 'content' of the last message in the 'messages' array must be a string." } });
      return;
  }

  // Smart Session Management for IDE Agents (Continue, Cursor, etc.)
  // 1. If messages.length is 1, it's the start of a new thread -> Use New Chat.
  // 2. If messages.length > 1, it's a follow-up -> Stay in the current thread.
  // 3. User can still override this manually with the 'new_chat' flag in the body.
  const isNewConversation = messages.length === 1;
  const effectiveNewChat = new_chat !== undefined ? new_chat : isNewConversation;

  // Acknowledge stream, but don't implement it yet to keep the fix simple.
  if (stream) {
    console.log(`SERVER.TS: Request ${requestId} requested streaming. The server will process this as a non-streaming request for now.`);
  }

  const queuedItem: QueuedRequest = { requestId, req, res, userMessage, model, temperature, max_tokens, new_chat: effectiveNewChat };
  processOrQueueRequest(queuedItem).catch(e => {
      console.error(`SERVER.TS: Unhandled error from processOrQueueRequest in /chat/completions for ${requestId}:`, e);
      if (!res.headersSent) {
          res.status(500).json({ error: { message: "Internal server error handling your request." } });
      }
  });
});

apiRouter.get('/models', (req: Request, res: Response) => {
  res.json({
    object: "list",
    data: [
      { id: "gemini-pro", object: "model", created: 1677610602, owned_by: "relay" },
      { id: "claude-3", object: "model", created: 1677610602, owned_by: "relay" }
    ]
  });
});

apiRouter.get('/admin/message-history', (req: Request, res: Response): void => {
  try {
    const historyToReturn = adminMessageHistory.slice(0, 100);
    res.json(historyToReturn);
  } catch (error) {
    console.error('SERVER.TS: Error fetching message history:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to retrieve message history' });
  }
});

apiRouter.get('/admin/server-info', (req: Request, res: Response): void => {
  try {
    const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
    const serverInfo = {
      port: serverPortForListen,
      requestTimeoutMs: currentRequestTimeoutMs,
      newRequestBehavior: newRequestBehavior,
      pingIntervalMs: null, 
      connectedExtensionsCount: activeConnections.length,
      uptimeSeconds: uptimeSeconds,
    };
    res.json(serverInfo);
  } catch (error) {
    console.error('SERVER.TS: Error fetching server info:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to retrieve server info' });
  }
});

apiRouter.post('/admin/restart-server', (req: Request, res: Response): void => {
  console.log('SERVER.TS: Received request to restart server via /v1/admin/restart-server.');
  res.status(200).json({ message: 'Restart should be handled by nodemon if .env file changes.' });
});

app.use('/v1', apiRouter);
app.use('/', apiRouter); // Also support root-level OpenAI paths for better compatibility

app.get('/health', (req: Request, res: Response) => {
  const aliveConnections = activeConnections.filter(conn => conn.readyState === WebSocket.OPEN);
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeBrowserConnections: aliveConnections.length,
    totalTrackedBrowserConnections: activeConnections.length,
    webSocketServerState: wss.options.server?.listening ? 'listening' : 'not_listening'
   });
});

// Function to handle port conflicts by killing processes using the port
async function handlePortConflict(portToFree: number, autoKillEnabled: boolean) {
  if (!autoKillEnabled) {
    console.log(`Auto-kill is disabled. Skipping port conflict check for port ${portToFree}.`);
    return;
  }

  console.log(`Checking if port ${portToFree} is in use...`);
  try {
    const isWindows = os.platform() === 'win32';
    let pid: string | null = null;

    if (isWindows) {
      // Use full path to netstat if possible, or just netstat.exe to be more explicit
      const command = `netstat.exe -ano -p TCP | findstr ":${portToFree}.*LISTENING"`;
      try {
        const output = execSync(command, { encoding: 'utf-8' });
        if (output) {
          const lines = output.trim().split('\n');
          if (lines.length > 0) {
            const parts = lines[0].trim().split(/\s+/);
            pid = parts[parts.length - 1];
          }
        }
      } catch (e: any) {
        if (e.status !== 1) throw e; // 1 means not found
      }
    } else {
      try {
        const output = execSync(`lsof -t -i:${portToFree}`, { encoding: 'utf-8' });
        pid = output.trim().split('\n')[0]; // Get the first PID if multiple
      } catch (e: any) {
        // lsof returns non-zero if no process found
        pid = null;
      }
    }

    if (pid && !isNaN(parseInt(pid))) {
      console.log(`Attempting to kill process with PID: ${pid} using port ${portToFree}`);
      try {
        if (isWindows) {
          execSync(`taskkill /PID ${pid} /F`);
        } else {
          execSync(`kill -9 ${pid}`);
        }
        console.log(`Successfully killed process ${pid} using port ${portToFree}. Waiting 1s for port to release...`);

        // Cross-platform async delay
        await new Promise(resolve => setTimeout(resolve, 1000));

        logAdminMessage('PORT_KILLED', `PORT_${portToFree}`, { port: portToFree, pid: pid, status: 'success' })
          .catch(err => console.error("ADMIN_LOG_ERROR (PORT_KILLED):", err));
      } catch (killError) {
        console.error(`Failed to kill process ${pid} using port ${portToFree}:`, killError);
        logAdminMessage('PORT_KILL_FAILED', `PORT_${portToFree}`, { port: portToFree, pid: pid, status: 'failure', error: (killError as Error).message })
          .catch(err => console.error("ADMIN_LOG_ERROR (PORT_KILL_FAILED):", err));
      }
    } else {
      console.log(`Port ${portToFree} appears to be free.`);
    }
  } catch (error: any) {
    console.error(`Error checking port ${portToFree}:`, error.message);
  }
}

// Start the server
async function startServer() {
  // Handle potential port conflict before starting the server
  await handlePortConflict(serverPortForListen, autoKillPort);

  server.listen(serverPortForListen, () => {
    console.log(`SERVER.TS: OpenAI-compatible relay server started and listening on port ${serverPortForListen}`);
    console.log(`SERVER.TS: WebSocket server for browser extensions running on ws://localhost:${serverPortForListen}`);
    console.log(`SERVER.TS: Admin UI should be available at http://localhost:${serverPortForListen}/admin/admin.html`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export default server;
