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
// AI Chat Relay - Background Script

// Default settings
const DEFAULT_SETTINGS = {
  serverHost: '127.0.0.1',
  serverPort: 3003,
  serverProtocol: 'ws'
};

let relaySocket = null;
let reconnectInterval = 5000;
let reconnectTimer = null;
let activeTabId = null;
let serverUrl = '';
let lastRequestId = null; 
let processingRequest = false; 
let pendingRequests = []; 
let lastSuccessfullyProcessedMessageText = null; 
const pendingRequestDetails = new Map(); 

// Supported domains for chat interfaces
const supportedDomains = ['gemini.google.com', 'aistudio.google.com', 'chatgpt.com', 'claude.ai'];

// ===== DEBUGGER RELATED GLOBALS =====
const BG_LOG_PREFIX = '[BG DEBUGGER]';
let debuggerAttachedTabs = new Map(); 
let heartbeatTimer = null;

// Keep-alive for Manifest V3 service worker
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
        relaySocket.send(JSON.stringify({ type: 'PING' }));
    }
  }
});

/**
 * Sends a log message to the relay server for remote debugging.
 */
function sendRemoteLog(level, message, requestId = null) {
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
        relaySocket.send(JSON.stringify({
            type: 'LOG_MESSAGE',
            level: level,
            message: `[BACKGROUND] ${message}`,
            requestId: requestId
        }));
    }
    if (level === 'error') console.error(message);
    else if (level === 'warn') console.warn(message);
    else console.log(message);
}


// Load settings and connect to the relay server
function loadSettingsAndConnect() {
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    serverUrl = `${items.serverProtocol}://${items.serverHost}:${items.serverPort}`;
    console.log("BACKGROUND: Connecting to relay server:", serverUrl);
    connectToRelayServer();
  });
}

// Connect to the relay server via WebSocket
function connectToRelayServer() {
  if (relaySocket) {
    relaySocket.close();
  }

  try {
    relaySocket = new WebSocket(serverUrl);

    relaySocket.onopen = () => {
      console.log("BACKGROUND: Relay WS: Connection established.");
      reconnectInterval = 5000; 
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;

      if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
        const readyMessage = { type: 'EXTENSION_READY' };
        relaySocket.send(JSON.stringify(readyMessage));
        
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
            relaySocket.send(JSON.stringify({ type: 'PING' }));
          }
        }, 30000);
      }
    };

    relaySocket.onmessage = (event) => {
      try {
        const command = JSON.parse(event.data);
        if (command.type === 'SEND_CHAT_MESSAGE') {
          pendingRequestDetails.set(command.requestId, { messageContent: command.message });
          pendingRequests.push(command);
          processNextRequest();
        }
      } catch (error) {
        console.error("BACKGROUND: Relay WS error:", error);
      }
    };

    relaySocket.onclose = (closeEvent) => {
      relaySocket = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectToRelayServer, reconnectInterval);
    };
  } catch (err) {
    reconnectTimer = setTimeout(connectToRelayServer, reconnectInterval);
  }
}

// Forward commands to content script
async function forwardCommandToContentScript(command) {
  try {
    let targetTabIdForCommand = null;
    
    if (activeTabId) {
      try {
        await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(activeTabId, { type: "PING_TAB" }, response => {
                if (chrome.runtime.lastError || !response || !response.success) {
                    activeTabId = null;
                    reject(new Error("Ping failed"));
                } else {
                    targetTabIdForCommand = activeTabId;
                    resolve();
                }
            });
        });
      } catch (error) {
        activeTabId = null;
      }
    }
    
    if (!targetTabIdForCommand) {
        targetTabIdForCommand = await findAndSendToSuitableTab(command, true);
    }

    if (targetTabIdForCommand) {
        const tabInfo = debuggerAttachedTabs.get(targetTabIdForCommand);
        if (tabInfo) {
            tabInfo.lastKnownRequestId = command.requestId;
        }

        const MAX_SEND_RETRIES = 3;
        const SEND_RETRY_DELAY = 500;
        let sendAttempt = 0;

        const sendMessageWithRetry = () => {
          if (sendAttempt >= MAX_SEND_RETRIES) {
            const errorMessage = `Failed to send to tab ${targetTabIdForCommand} after ${MAX_SEND_RETRIES} attempts.`;
            if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
              relaySocket.send(JSON.stringify({ type: "CHAT_RESPONSE_ERROR", requestId: command.requestId, error: errorMessage }));
            }
            processingRequest = false;
            processNextRequest();
            return;
          }

          sendAttempt++;
          chrome.tabs.sendMessage(targetTabIdForCommand, command, async (response) => {
            if (chrome.runtime.lastError) {
              const lastErr = chrome.runtime.lastError.message;
              if (lastErr.includes("Receiving end does not exist") || lastErr.includes("context invalidated")) {
                console.warn(`[BG RELAY] Context invalidated for tab ${targetTabIdForCommand}. Attempting re-injection...`);
                try {
                  const tab = await chrome.tabs.get(targetTabIdForCommand);
                  const providerFile = isUrlSupportedByProvider(tab.url, "ChatGptProvider") ? "providers/chatgpt.js" :
                                      isUrlSupportedByProvider(tab.url, "GeminiProvider") ? "providers/gemini.js" :
                                      isUrlSupportedByProvider(tab.url, "ClaudeProvider") ? "providers/claude.js" : null;

                  if (providerFile) {
                    await chrome.scripting.executeScript({
                      target: { tabId: targetTabIdForCommand },
                      files: ["providers/provider-utils.js", providerFile, "content.js"]
                    });
                    setTimeout(sendMessageWithRetry, 1000);
                    return;
                  }
                } catch (e) {}
              }
              setTimeout(sendMessageWithRetry, SEND_RETRY_DELAY);
            }
          });
        };
        sendMessageWithRetry();
    }
  } catch (error) {
    processingRequest = false;
    processNextRequest();
  }
}

// Helper to find suitable tab
async function findAndSendToSuitableTab(command, justFinding = false) {
  try {
    const tabs = await chrome.tabs.query({});
    const modelLower = (command.model || "").toLowerCase();
    const providerType = modelLower.includes('gpt') ? 'chatgpt' :
                         modelLower.includes('gemini') ? 'gemini' :
                         modelLower.includes('claude') ? 'claude' : null;

    const matchingTabs = tabs.filter(tab => {
      if (!tab.url) return false;
      if (providerType === 'chatgpt') return tab.url.includes('chatgpt.com') || tab.url.includes('openai.com');
      if (providerType === 'gemini') return tab.url.includes('gemini.google.com') || tab.url.includes('aistudio.google.com');
      if (providerType === 'claude') return tab.url.includes('claude.ai');
      return supportedDomains.some(domain => tab.url.includes(domain));
    });
    
    if (matchingTabs.length > 0) {
      // Sort by active, then by loaded status
      const sorted = matchingTabs.sort((a, b) => {
        if (a.active && !b.active) return -1;
        if (!a.active && b.active) return 1;
        if (a.status === 'complete' && b.status !== 'complete') return -1;
        return 0;
      });
      
      const targetTab = sorted[0];
      console.log(`[BG RELAY] Routed ${command.model} to tab ${targetTab.id} (${targetTab.url})`);
      return targetTab.id; 
    }
    return null;
  } catch (error) {
    return null;
  }
}

function processNextRequest() {
  if (processingRequest && pendingRequests.length > 0) return;
  if (pendingRequests.length > 0) {
    const nextCommand = pendingRequests.shift();
    processingRequest = true;
    lastRequestId = nextCommand.requestId;
    setTimeout(() => {
        forwardCommandToContentScript({
          action: "SEND_CHAT_MESSAGE",
          requestId: nextCommand.requestId,
          messageContent: nextCommand.message,
          settings: nextCommand.settings,
          lastProcessedText: lastSuccessfullyProcessedMessageText
        });
    }, 500);
  }
}

function isUrlSupportedByProvider(url, providerName) {
    if (!url) return false;
    const lowerUrl = url.toLowerCase();
    if (providerName === "AIStudioProvider") return lowerUrl.includes("aistudio.google.com");
    if (providerName === "GeminiProvider") return lowerUrl.includes("gemini.google.com");
    if (providerName === "ChatGptProvider") return lowerUrl.includes("chatgpt.com");
    if (providerName === "ClaudeProvider") return lowerUrl.includes("claude.ai");
    return false;
}

// Listen for messages from Content Scripts and Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message.type || message.action;
  
  if (type === "CONTENT_SCRIPT_LOADED") {
    sendResponse({ success: true });
    return true;
  }
  
  if (sender.tab && sender.tab.id) {
    activeTabId = sender.tab.id;
  }

  if (type === "SET_DEBUGGER_TARGETS") {
    if (sender.tab && sender.tab.id) {
      attachDebuggerAndEnableFetch(sender.tab.id, message.providerName, message.patterns)
        .then(() => {
          sendResponse({ status: "Debugger attachment and Fetch.enable successful" });
        })
        .catch(err => {
          sendResponse({ status: "Debugger attachment failed", error: err.message });
        });
    } else {
      sendResponse({ status: "Error: Missing tabId" });
    }
    return true; // Keep message channel open for async response
  }
  
  if (type === "LOG_MESSAGE") {
    sendRemoteLog(message.level, message.message, message.requestId);
    sendResponse({ success: true });
    return true;
  } 
  
  if (type === "CHAT_RELAY_READY") {
    if (sender.tab && sender.tab.id) activeTabId = sender.tab.id;
    sendResponse({ success: true });
    return true;
  } 

  if (type === "RESPONSE_CAPTURED" || type === "CHAT_RESPONSE_FROM_DOM" || type === "CHAT_RESPONSE" || type === "FINAL_RESPONSE_TO_RELAY") {
    const text = message.response || message.text || message.chunk;
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
      relaySocket.send(JSON.stringify({
        type: "CHAT_RESPONSE",
        requestId: message.requestId,
        response: text,
        isFinal: message.isFinal !== undefined ? message.isFinal : true,
        encoded: message.encoded === true
      }));
      sendResponse({ success: true });
      if (lastRequestId === message.requestId && (message.isFinal || message.isFinal === undefined)) {
          const details = pendingRequestDetails.get(message.requestId);
          if (details && typeof details.messageContent === 'string') {
              lastSuccessfullyProcessedMessageText = details.messageContent;
          }
          processingRequest = false;
          processNextRequest();
      }
    } else {
      sendResponse({ success: false, error: "Relay WebSocket not connected" });
    }
    return true; 
  }

  if (type === "CHAT_RESPONSE_FROM_DOM_FAILED") {
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
      relaySocket.send(JSON.stringify({
        type: "CHAT_RESPONSE_ERROR",
        requestId: message.requestId,
        error: `DOM fallback failed: ${message.error}`
      }));
    }
    processingRequest = false;
    processNextRequest();
    sendResponse({ success: true });
    return true;
  }

  if (type === "GET_CONNECTION_STATUS") {
    sendResponse({ connected: relaySocket && relaySocket.readyState === WebSocket.OPEN });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && (changes.serverHost || changes.serverPort || changes.serverProtocol)) {
      if (relaySocket) relaySocket.close();
      else loadSettingsAndConnect();
  }
});

loadSettingsAndConnect();

// ===== DEBUGGER LOGIC =====
async function attachDebuggerAndEnableFetch(tabId, providerName, patterns) {
    console.log(`[BG DEBUGGER] Request to attach to tab ${tabId} for ${providerName} with patterns:`, JSON.stringify(patterns));
    if (!tabId || !patterns || patterns.length === 0) {
        console.error(`[BG DEBUGGER] Missing tabId or patterns. tabId: ${tabId}, patterns:`, patterns);
        return;
    }
    const debuggee = { tabId: tabId };
    
    // Safety check for internal URLs
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("about:") || tab.url.startsWith("chrome-extension://"))) {
            console.log(`[BG DEBUGGER] Skipping attachment for internal URL: ${tab.url}`);
            return;
        }
    } catch (e) {
        console.warn(`[BG DEBUGGER] Could not verify tab ${tabId} URL before attachment:`, e.message);
    }

    try {
        const existingAttachment = debuggerAttachedTabs.get(tabId);
        if (!(existingAttachment && existingAttachment.isAttached)) {
            console.log(`[BG DEBUGGER] Attaching chrome.debugger to tab ${tabId}...`);
            await new Promise((resolve, reject) => {
                chrome.debugger.attach(debuggee, "1.3", () => {
                    if (chrome.runtime.lastError) {
                        console.error(`[BG DEBUGGER] Attach failed for tab ${tabId}:`, chrome.runtime.lastError.message);
                        return reject(chrome.runtime.lastError);
                    }
                    console.log(`[BG DEBUGGER] Successfully attached to tab ${tabId}.`);
                    debuggerAttachedTabs.set(tabId, { providerName, patterns, isFetchEnabled: false, isAttached: true, lastKnownRequestId: null });
                    resolve();
                });
            });
        } else {
            console.log(`[BG DEBUGGER] Already attached to tab ${tabId}.`);
        }
        
        console.log(`[BG DEBUGGER] Enabling Fetch and Network for tab ${tabId} with patterns...`);
        await new Promise((resolve, reject) => {
            chrome.debugger.sendCommand(debuggee, "Network.enable", {}, () => {
                chrome.debugger.sendCommand(debuggee, "Fetch.enable", {
                    patterns: patterns.map(p => ({ urlPattern: p.urlPattern, requestStage: "Response" }))
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.error(`[BG DEBUGGER] Enable failed for tab ${tabId}:`, chrome.runtime.lastError.message);
                        return reject(chrome.runtime.lastError);
                    }
                    console.log(`[BG DEBUGGER] Debugger domains enabled SUCCESS for tab ${tabId}.`);
                    const currentTabData = debuggerAttachedTabs.get(tabId);
                    if (currentTabData) currentTabData.isFetchEnabled = true;
                    resolve();
                });
            });
        });
    } catch (e) {
        console.error(`[BG DEBUGGER] Error in attach sequence for tab ${tabId}:`, e);
    }
}

async function detachDebugger(tabId) {
    if (!tabId) return;
    const attachmentDetails = debuggerAttachedTabs.get(tabId);
    if (attachmentDetails && attachmentDetails.isAttached) {
        chrome.debugger.detach({ tabId }, () => {
            debuggerAttachedTabs.delete(tabId);
        });
    }
}

chrome.tabs.onRemoved.addListener(detachDebugger);
chrome.runtime.onSuspend.addListener(() => {
    for (const tabId of debuggerAttachedTabs.keys()) detachDebugger(tabId);
});

chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) debuggerAttachedTabs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((debuggeeId, message, params) => {
    const tabId = debuggeeId.tabId;
    if (!tabId) return;
    const tabInfo = debuggerAttachedTabs.get(tabId);

    // Fallback to global lastRequestId if tab-specific one isn't set yet
    const currentOperationRequestId = (tabInfo && tabInfo.lastKnownRequestId !== null)
        ? tabInfo.lastKnownRequestId
        : lastRequestId;

    if (message === "Fetch.requestPaused") {
        console.log(`[BG DEBUGGER] Request paused in tab ${tabId}: ${params.request.url} (Status: ${params.responseStatusCode || 'N/A'})`);

        if (!tabInfo || !tabInfo.isFetchEnabled || currentOperationRequestId === null) {
            chrome.debugger.sendCommand(debuggeeId, "Fetch.continueRequest", { requestId: params.requestId });
            return;
        }

        const matchesPattern = tabInfo.patterns.some(p => {
            const patternRegex = new RegExp(String(p.urlPattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*?'));
            return patternRegex.test(params.request.url);
        });

        if (!matchesPattern) {
            chrome.debugger.sendCommand(debuggeeId, "Fetch.continueRequest", { requestId: params.requestId });
            return;
        }

        console.log(`[BG DEBUGGER] Matching request found: ${params.request.url}. Continuing immediately to avoid blocking stream.`);
        // Continue immediately so the UI remains responsive and streaming works
        chrome.debugger.sendCommand(debuggeeId, "Fetch.continueRequest", { requestId: params.requestId });

        // We will capture the data via Network.loadingFinished or Network.eventSourceMessageReceived
    }

    if (message === "Network.eventSourceMessageReceived") {
        console.log(`[BG DEBUGGER] SSE Message in tab ${tabId} for request ${params.requestId}`);
        // This gives us real-time chunks for SSE!
        chrome.tabs.sendMessage(tabId, {
            type: "PROVIDER_DEBUGGER_EVENT",
            detail: {
                requestId: currentOperationRequestId,
                networkRequestId: params.requestId,
                data: `data: ${params.data}\n\n`, // Re-wrap in data: prefix for the provider's parser
                isFinal: false
            }
        });
    }

    if (message === "Network.loadingFinished") {
        if (!tabInfo || currentOperationRequestId === null) return;

        // When the request finishes, we can get the clean, full body as a final check
        chrome.debugger.sendCommand(debuggeeId, "Network.getResponseBody", { requestId: params.requestId }, (response) => {
            if (chrome.runtime.lastError) return;

            let processedData = null;
            if (response && response.body) {
                console.log(`[BG DEBUGGER] Final body captured for request ${params.requestId}, length: ${response.body.length}`);
                if (response.base64Encoded) {
                    try {
                        processedData = new TextDecoder('utf-8').decode(Uint8Array.from(atob(response.body), c => c.charCodeAt(0)));
                    } catch (e) {
                        processedData = response.body;
                    }
                } else {
                    processedData = response.body;
                }
            }

            if (processedData) {
                chrome.tabs.sendMessage(tabId, {
                    type: "PROVIDER_DEBUGGER_EVENT",
                    detail: { requestId: currentOperationRequestId, networkRequestId: params.requestId, data: processedData, isFinal: true }
                });
            }
        });
    }
});
