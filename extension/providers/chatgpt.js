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
// AI Chat Relay - ChatGPT Provider

class ChatGptProvider {
  constructor() {
    // --- START OF CONFIGURABLE PROPERTIES ---
    this.captureMethod = "debugger"; // Default value
    this.debuggerUrlPattern = "*://chatgpt.com/*"; // Broadened to catch all variations
    this.includeThinkingInMessage = false;
    // --- END OF CONFIGURABLE PROPERTIES ---
    this.name = "ChatGptProvider";
    this.supportedDomains = ["chatgpt.com"];
    this.inputSelector = '#prompt-textarea';
    this.sendButtonSelector = 'button[data-testid="send-button"], [aria-label="Send prompt"], button[class*="bottom-1.5"], button.bg-black, .flex.items-end button';
    this.responseSelector = '[data-message-author-role="assistant"] div.markdown, .markdown.prose, .message-bubble .text-content';
    this.thinkingIndicatorSelector = '.loading-spinner, [data-testid="stop-button"], .typing-indicator';
    this.responseSelectorForDOMFallback = '[data-message-author-role="assistant"] div.markdown';
    this.thinkingIndicatorSelectorForDOM = '.loading-spinner, .blue-circle';
    this.newChatSelector = 'a[data-testid="sidebar-new-chat-button"], button[data-testid="sidebar-new-chat-button"], nav a[href="/"], .new-chat-button, button[aria-label="New chat" i], [aria-label="New chat" i], button[aria-label*="New chat" i], a[aria-label*="New chat" i], [data-testid$="new-chat-button"]';
    this.lastSentMessage = '';
    this.pendingResponseCallbacks = new Map();
    this.requestAccumulators = new Map();
    this.domMonitorTimer = null;
    this.domFallbackTimeout = 15000; // Increased to 15s to allow for slow LLM starts and debugger lag
    this.domFallbackTimer = null;

    this._loadSettings();
    console.log(`[${this.name}] Provider initialized for domains: ${this.supportedDomains.join(', ')}`);
  }

  _loadSettings() {
    chrome.storage.sync.get({ chatGptCaptureMethod: 'debugger' }, (items) => {
      this.captureMethod = items.chatGptCaptureMethod;
      console.log(`[${this.name}] Capture method updated to: ${this.captureMethod}`);
    });
  }

  async sendChatMessage(messageContent, messageOrId) {
    const requestId = typeof messageOrId === 'object' ? messageOrId.requestId : messageOrId;
    console.log(`[${this.name}] sendChatMessage called for requestId ${requestId}`);
    const MAX_RETRIES = 5;
    
    const inputField = document.querySelector(this.inputSelector);
    if (!inputField) {
      console.error(`[${this.name}] Input field not found: ${this.inputSelector}`);
      this._reportSendError(requestId, `Input field not found: ${this.inputSelector}`);
      return false;
    }

    try {
      let textToInput = "";
      if (typeof messageContent === 'string') {
        textToInput = messageContent;
      } else if (Array.isArray(messageContent)) {
        textToInput = messageContent.map(p => p.text || "").join("\n");
      }
      
      this.lastSentMessage = textToInput;

      // Handle New Chat request
      if (typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat) {
          console.log(`[${this.name}] New Chat requested. Current path: ${window.location.pathname}`);

          // Even if we are on / or /chat, we might want to click New Chat to ensure a fresh session
          const newChatButton = document.querySelector(this.newChatSelector);
          if (newChatButton) {
              console.log(`[${this.name}] Found New Chat button, clicking...`);
              const rect = newChatButton.getBoundingClientRect();
              const clientX = rect.left + rect.width / 2;
              const clientY = rect.top + rect.height / 2;

              newChatButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
              newChatButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
              newChatButton.focus();
              newChatButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
              newChatButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));
              newChatButton.click();

              await new Promise(resolve => setTimeout(resolve, 2500));
          } else {
              console.warn(`[${this.name}] New Chat button not found via primary selector. Searching by text...`);
              const allElements = document.querySelectorAll('button, a, div[role="button"], span');
              let foundElement = null;
              for (const el of allElements) {
                  const text = el.textContent.toLowerCase().trim();
                  const aria = (el.getAttribute('aria-label') || "").toLowerCase();
                  if (text === 'new chat' || text === 'chatgpt' || aria.includes('new chat')) {
                      console.log(`[${this.name}] Found potential New Chat element by text/aria:`, el.tagName, text, aria);
                      foundElement = el;
                      break;
                  }
              }

              if (foundElement) {
                  const rect = foundElement.getBoundingClientRect();
                  const clientX = rect.left + rect.width / 2;
                  const clientY = rect.top + rect.height / 2;

                  foundElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
                  foundElement.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
                  foundElement.focus();
                  foundElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
                  foundElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));
                  foundElement.click();

                  await new Promise(resolve => setTimeout(resolve, 2500));
              } else if (window.location.pathname !== "/" && window.location.pathname !== "/chat") {
                  console.log(`[${this.name}] No button found, but not on homepage. Navigating to /...`);
                  window.location.href = "/";
                  await new Promise(resolve => setTimeout(resolve, 4000));
              }
          }
      }

      // Re-find the input field to avoid "Stale Element" references after navigation/New Chat
      const activeInputField = document.querySelector(this.inputSelector);
      if (!activeInputField) {
          throw new Error(`Prompt input field '${this.inputSelector}' not found.`);
      }

      activeInputField.focus();
      
      // Clear field and insert text
      if (activeInputField.tagName === 'TEXTAREA' || activeInputField.tagName === 'INPUT') {
          activeInputField.value = '';
          activeInputField.value = textToInput;
      } else {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          activeInputField.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: textToInput }));
          document.execCommand('insertText', false, textToInput);
          
          if (activeInputField.innerText.trim() === "" && textToInput.trim() !== "") {
            console.log(`[${this.name}] execCommand failed, falling back to innerText`);
            activeInputField.innerText = textToInput;
          }
      }

      // Trigger multiple events to satisfy React/Next.js state
      const events = ['input', 'change', 'keyup', 'keydown'];
      events.forEach(type => {
          activeInputField.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      });
      
      await new Promise(resolve => setTimeout(resolve, 1000)); 

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const sendButton = document.querySelector(this.sendButtonSelector);
        if (sendButton) {
          const isDisabled = sendButton.disabled || 
                             sendButton.getAttribute('aria-disabled') === 'true' ||
                             sendButton.classList.contains('disabled');
          
          if (!isDisabled) {
            console.log(`[${this.name}] Attempting to click send button on attempt ${attempt + 1}`);
            
            // Human-like click sequence
            const rect = sendButton.getBoundingClientRect();
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;
            
            sendButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', clientX, clientY }));
            sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY }));
            sendButton.focus();
            sendButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', clientX, clientY }));
            sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY }));
            sendButton.click();
            
            // Final blur to trigger any pending state updates
            activeInputField.blur();
            
            // Wait to see if it worked (input should clear)
            await new Promise(resolve => setTimeout(resolve, 500));
            let currentContent = (activeInputField.value || activeInputField.innerText || "").trim();
            if (currentContent === "") {
                console.log(`[${this.name}] Message sent successfully (input cleared via button).`);
                return true;
            }

            // If button didn't work quickly, try Enter key right away
            console.log(`[${this.name}] Button click didn't clear input, trying Enter key...`);
            activeInputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            activeInputField.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            
            await new Promise(resolve => setTimeout(resolve, 500));
            currentContent = (activeInputField.value || activeInputField.innerText || "").trim();
            if (currentContent === "") {
                console.log(`[${this.name}] Message sent successfully (input cleared via Enter fallback).`);
                return true;
            }
          }
        }
        
        console.warn(`[${this.name}] Send attempt ${attempt + 1} failed to clear input.`);
        activeInputField.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Final failure
      this._reportSendError(requestId, "All send attempts (button and Enter key) failed to clear input.");
      return false;

    } catch (error) {
      console.error(`[${this.name}] Error in sendChatMessage:`, error);
      this._reportSendError(requestId, error.message);
      return false;
    }
  }

  _reportSendError(requestId, errorMessage) {
      console.error(`[${this.name}] Reporting send error for requestId ${requestId}: ${errorMessage}`);
      const callback = this.pendingResponseCallbacks.get(requestId);
      if (callback) {
          callback(requestId, `[PROVIDER_SEND_ERROR: ${errorMessage}]`, true); 
          this.pendingResponseCallbacks.delete(requestId);
          this.requestAccumulators.delete(requestId); 
      } else {
          console.warn(`[${this.name}] No callback found to report send error for requestId ${requestId}.`);
      }
  }

  async initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}. Capture method: ${this.captureMethod}`);
    this.pendingResponseCallbacks.set(requestId, responseCallback);

    // Reset accumulator for this request
    this.requestAccumulators.set(requestId, { text: "", isDefinitelyFinal: false, currentProcessingStage: undefined });

    if (this.captureMethod === "debugger") {
      console.log(`[${this.name}] Debugger capture initiated. Requesting debugger attachment.`);

      // Use specific patterns instead of the broad one to avoid intercepting all site traffic
      const patterns = this.getStreamingApiPatterns();
      if (patterns.length === 0) {
          patterns.push({ urlPattern: this.debuggerUrlPattern });
      }

      await new Promise(resolve => {
        chrome.runtime.sendMessage({
            type: "SET_DEBUGGER_TARGETS",
            providerName: this.name,
            patterns: patterns
        }, response => {
            console.log(`[${this.name}] SET_DEBUGGER_TARGETS response:`, response);
            resolve();
        });
      });

      console.log(`[${this.name}] Debugger capture initiated with ${patterns.length} patterns. Setting DOM fallback timer for ${this.domFallbackTimeout}ms.`);
      
      // Clear any existing fallback timer
      if (this.domFallbackTimer) clearTimeout(this.domFallbackTimer);
      
      this.domFallbackTimer = setTimeout(() => {
        const acc = this.requestAccumulators.get(requestId);
        if (acc && acc.text.length === 0) {
          console.warn(`[${this.name}] No data received via debugger after ${this.domFallbackTimeout}ms. Falling back to DOM capture.`);
          this._startDOMMonitoring(requestId);
        } else {
          console.log(`[${this.name}] Debugger already has data (${acc ? acc.text.length : 0} chars). No DOM fallback needed.`);
        }
      }, this.domFallbackTimeout);
    } else {
      this._startDOMMonitoring(requestId);
    }
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground) {
    // Only log at debug level or if it's likely a real response chunk
    const isSSE = rawData && rawData.includes("data:");
    
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) {
      if (isSSE) {
        console.log(`[${this.name}] handleDebuggerData - No active callback for requestId: ${requestId} but received SSE data. This might be a late chunk.`);
      }
      return;
    }
    
    let accumulator = this.requestAccumulators.get(requestId);
    if (!accumulator) {
      accumulator = { text: "", isDefinitelyFinal: false, currentProcessingStage: undefined }; // Initialize stage
      this.requestAccumulators.set(requestId, accumulator);
    }
    console.log(`[${this.name}] handleDebuggerData - Accumulator state for ${requestId} BEFORE processing: ${JSON.stringify(accumulator)}`);

    if (accumulator.isDefinitelyFinal) {
      console.log(`[${this.name}] handleDebuggerData - Accumulator for ${requestId} is already final. Skipping.`);
      return;
    }

    if (rawData && rawData.trim() !== "") {
      let isLikelyNonChatJson = false;
      if (!rawData.includes("data:") && rawData.trim().startsWith("{") && rawData.trim().endsWith("}")) {
          try {
              const jsonData = JSON.parse(rawData);
              if (typeof jsonData.safe === 'boolean' && typeof jsonData.blocked === 'boolean') {
                  isLikelyNonChatJson = true;
                  console.log(`[${this.name}] handleDebuggerData - Detected likely non-chat JSON for ${requestId}, skipping parse.`);
              }
          } catch (e) { /* Not simple JSON */ }
      }

      if (isLikelyNonChatJson) {
        // Ignore
      } else {
          const parseOutput = this.parseDebuggerResponse(rawData, accumulator.currentProcessingStage);
          if (accumulator.text.length === 0 && (parseOutput.text || parseOutput.operation === "replace")) {
            console.log(`[${this.name}] SUCCESS: First debugger data received for ${requestId}. Disabling DOM fallback timer.`);
            if (this.domFallbackTimer) {
                clearTimeout(this.domFallbackTimer);
                this.domFallbackTimer = null;
            }
          }
          accumulator.currentProcessingStage = parseOutput.newProcessingStage; // Update stage
          
          if (parseOutput.text !== null || parseOutput.operation === "replace") { // Check for null explicitly if empty string is valid
              if (parseOutput.operation === "replace") {
                  accumulator.text = parseOutput.text;
              } else { // append
                  accumulator.text += parseOutput.text;
              }
          }

          if (parseOutput.isFinalResponse) {
              accumulator.isDefinitelyFinal = true;
          }
          
          // Invoke callback if there's new text
          if (parseOutput.text !== null || parseOutput.operation === "replace") {
            callback(requestId, accumulator.text, false); // Always non-final here, finality handled below
          }

          // If we flagged it as final, only report it if we actually have text
          if (accumulator.isDefinitelyFinal) {
              if (accumulator.text.trim().length > 0) {
                  callback(requestId, accumulator.text, true);
              } else {
                  console.log(`[${this.name}] Debugger flagged final but text is empty. Falling back to DOM.`);
                  accumulator.isDefinitelyFinal = false; 
                  this._startDOMMonitoring(requestId);
              }
          }
      }
    } else {
      if (isFinalFromBackground && !accumulator.isDefinitelyFinal) {
          // If the network request is done but we have NO text, fall back to DOM immediately
          if (accumulator.text.length === 0) {
              console.log(`[${this.name}] handleDebuggerData - Network request finished with NO text. Starting DOM fallback.`);
              this._startDOMMonitoring(requestId);
          } else {
              accumulator.isDefinitelyFinal = true;
              callback(requestId, accumulator.text, true);
          }
      }
    }

    if (accumulator.isDefinitelyFinal) {
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
    }
  }

  handleWebSocketData(requestId, rawData) {
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) return;

    let accumulator = this.requestAccumulators.get(requestId);
    if (!accumulator) {
      accumulator = { text: "", isDefinitelyFinal: false, currentProcessingStage: undefined };
      this.requestAccumulators.set(requestId, accumulator);
    }

    if (accumulator.isDefinitelyFinal) return;

    const parseOutput = this.parseDebuggerResponse(rawData, accumulator.currentProcessingStage);
    accumulator.currentProcessingStage = parseOutput.newProcessingStage;

    if (parseOutput.text !== null || parseOutput.operation === "replace") {
      if (parseOutput.operation === "replace") {
        accumulator.text = parseOutput.text;
      } else {
        accumulator.text += parseOutput.text;
      }
    }

    if (parseOutput.isFinalResponse) {
      accumulator.isDefinitelyFinal = true;
    }

    if (parseOutput.text !== null || accumulator.isDefinitelyFinal || parseOutput.operation === "replace") {
      callback(requestId, accumulator.text, accumulator.isDefinitelyFinal);
    }

    if (accumulator.isDefinitelyFinal) {
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
    }
  }

  // Parses the raw response from the debugger.
  // Returns an object: { text: "content_from_this_chunk", isFinalResponse: boolean, operation: "replace" | "append", newProcessingStage: string }
  parseDebuggerResponse(rawDataString, currentProcessingStage) {
    let textForThisChunk = null; // Use null to distinguish from empty string if needed
    let isFinalResponse = false;
    let chunkOverallOperation = "append"; // Default to append
    let newProcessingStage = currentProcessingStage;

    console.log(`[${this.name}] parseDebuggerResponse ENTER. currentProcessingStage: ${currentProcessingStage}, includeThinking: ${this.includeThinkingInMessage}, rawDataString: "${rawDataString ? rawDataString.substring(0,100) + "..." : "null"}"`);

    if (rawDataString === null || typeof rawDataString === 'undefined' || rawDataString.trim() === "") {
      return { text: null, isFinalResponse: false, operation: "append", newProcessingStage };
    }

    // Skip non-SSE JSON like {"safe": true, "blocked": false}
    if (!rawDataString.includes("data:") && rawDataString.trim().startsWith("{") && rawDataString.trim().endsWith("}")) {
      try {
        const jsonData = JSON.parse(rawDataString);
        if (typeof jsonData.safe === 'boolean' && typeof jsonData.blocked === 'boolean') {
          console.log(`[${this.name}] parseDebuggerResponse - Skipping non-chat JSON: ${rawDataString.substring(0,50)}`);
          return { text: null, isFinalResponse: false, operation: "append", newProcessingStage };
        }
      } catch (e) { /* Fall through, might be a malformed SSE line or other JSON */ }
    }

    const lines = rawDataString.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataJson = line.substring(6).trim();
        if (dataJson === '[DONE]') {
          isFinalResponse = true;
          console.log(`[${this.name}] parseDebuggerResponse - Encountered [DONE]`);
          break;
        }
        if (dataJson === "") continue;

        try {
          const data = JSON.parse(dataJson);
          console.log(`[${this.name}] parseDebuggerResponse - Processing SSE data: ${JSON.stringify(data).substring(0,150)}...`);
          let currentLineText = "";
          let currentLineIsReplaceOperation = false; // Indicates if this specific line's content should replace prior content *within this chunk*
          
          let messageNode = data.message;
          if (data.p === "" && data.o === "add" && data.v && data.v.message) {
            messageNode = data.v.message;
          }

          let contentType = null;
          if (messageNode && messageNode.content && messageNode.content.content_type) {
            contentType = messageNode.content.content_type;
          }
          console.log(`[${this.name}] parseDebuggerResponse - Identified contentType: ${contentType}, currentProcessingStage: ${newProcessingStage}`);

          // --- Stage and Text Extraction Logic ---
          if (this.includeThinkingInMessage) {
            // --- INCLUDE THINKING: Extract text from thoughts and content ---
            if (contentType === "thoughts") {
              if (newProcessingStage !== "processing_thoughts") {
                chunkOverallOperation = "replace"; // Replace previous stage's content
                textForThisChunk = ""; // Start fresh for this chunk
              }
              newProcessingStage = "processing_thoughts";
              if (messageNode.content.thoughts && Array.isArray(messageNode.content.thoughts)) {
                messageNode.content.thoughts.forEach(thought => {
                  if (thought.summary) currentLineText += thought.summary + "\n";
                  if (thought.content) currentLineText += thought.content + "\n";
                });
              }
              console.log(`[${this.name}] parseDebuggerResponse (Thinking TRUE) - THOUGHTS: "${currentLineText.substring(0,50)}..."`);
            } else if (contentType === "reasoning_recap") {
              if (newProcessingStage === "processing_thoughts") {
                newProcessingStage = "awaiting_content"; // Thoughts ended, expecting content
              }
              // No text from recap itself
              console.log(`[${this.name}] parseDebuggerResponse (Thinking TRUE) - REASONING_RECAP. New stage: ${newProcessingStage}`);
            } else if (contentType === "text") {
              if (newProcessingStage !== "processing_content") {
                chunkOverallOperation = "replace"; // Replace previous stage's content
                textForThisChunk = ""; // Start fresh for this chunk
              }
              newProcessingStage = "processing_content";
              if (messageNode.content.parts && messageNode.content.parts.length > 0 && typeof messageNode.content.parts[0] === 'string') {
                currentLineText = messageNode.content.parts[0];
                currentLineIsReplaceOperation = true; // A full text part replaces
              }
              console.log(`[${this.name}] parseDebuggerResponse (Thinking TRUE) - TEXT: "${currentLineText.substring(0,50)}..."`);
            }
          } else {
            // --- INCLUDE THINKING FALSE: Skip thoughts, only process text ---
            if (contentType === "thoughts") {
              newProcessingStage = "processing_thoughts";
              textForThisChunk = ""; // Ensure no text from thoughts is carried
              chunkOverallOperation = "replace"; // Next "text" content should replace this empty string
              console.log(`[${this.name}] parseDebuggerResponse (Thinking FALSE) - SKIPPING THOUGHTS. Stage: ${newProcessingStage}. Chunk op: ${chunkOverallOperation}`);
              // Check for finality even in thoughts
               if (messageNode && messageNode.status === "finished_successfully" && messageNode.end_turn === true) isFinalResponse = true;
              continue;
            } else if (contentType === "reasoning_recap") {
              if (newProcessingStage === "processing_thoughts") {
                newProcessingStage = "awaiting_content";
              }
              console.log(`[${this.name}] parseDebuggerResponse (Thinking FALSE) - SKIPPING REASONING_RECAP. Stage: ${newProcessingStage}`);
               if (messageNode && messageNode.status === "finished_successfully" && messageNode.end_turn === true) isFinalResponse = true;
              continue;
            } else if (contentType === "text") {
              if (newProcessingStage === "processing_thoughts" || newProcessingStage === "awaiting_content" || newProcessingStage === undefined) {
                chunkOverallOperation = "replace"; // This is the first actual content, replace anything prior (e.g. empty from thoughts)
                textForThisChunk = ""; // Ensure we start fresh for this chunk if replacing
              }
              newProcessingStage = "processing_content";
              if (messageNode.content.parts && messageNode.content.parts.length > 0 && typeof messageNode.content.parts[0] === 'string') {
                currentLineText = messageNode.content.parts[0];
                currentLineIsReplaceOperation = true; // A full text part
              }
              console.log(`[${this.name}] parseDebuggerResponse (Thinking FALSE) - TEXT: "${currentLineText.substring(0,50)}...". Stage: ${newProcessingStage}. Chunk op: ${chunkOverallOperation}`);
            }
          }

          // JSON Patch operations (apply to both includeThinking true/false if it's for content parts)
          if (data.p === "" && data.o === "patch" && Array.isArray(data.v)) {
            for (const patch of data.v) {
              if (patch.p === "/message/content/parts/0" && typeof patch.v === 'string') {
                 // If we are not including thinking, and we haven't hit a "text" content type yet, this patch might be the first "text"
                if (!this.includeThinkingInMessage && newProcessingStage !== "processing_content") {
                    if (newProcessingStage === "processing_thoughts" || newProcessingStage === "awaiting_content" || newProcessingStage === undefined) {
                        chunkOverallOperation = "replace";
                        textForThisChunk = ""; // Start fresh
                    }
                    newProcessingStage = "processing_content"; // Patches to content/parts/0 mean we are in content
                    console.log(`[${this.name}] parseDebuggerResponse - Patch to content/parts/0, transitioning to 'processing_content'. Chunk op: ${chunkOverallOperation}`);
                }
                // If including thinking, and current stage is not content, this patch might be the first content
                else if (this.includeThinkingInMessage && newProcessingStage !== "processing_content") {
                    chunkOverallOperation = "replace"; // Replace thoughts
                    textForThisChunk = ""; // Start fresh
                    newProcessingStage = "processing_content";
                    console.log(`[${this.name}] parseDebuggerResponse (Thinking TRUE) - Patch to content/parts/0, transitioning to 'processing_content'. Chunk op: ${chunkOverallOperation}`);
                }


                if (patch.o === "append") {
                  currentLineText += patch.v;
                  currentLineIsReplaceOperation = false; // Append to current line's text
                } else if (patch.o === "replace") {
                  currentLineText = patch.v;
                  currentLineIsReplaceOperation = true; // Replace current line's text
                }
                 console.log(`[${this.name}] parseDebuggerResponse - Patch applied. currentLineText: "${currentLineText.substring(0,50)}...", currentLineIsReplaceOp: ${currentLineIsReplaceOperation}`);
              }
              // Finality from patch metadata - be careful not to trigger prematurely on intermediate signals
              if (((patch.p === "/message/metadata/finish_details/type" || patch.p === "/message/metadata/finish_reason") && patch.v === "stop") ||
                  (patch.p === "/message/status" && patch.v === "finished_successfully")) {
                // Only consider it final from metadata if we've actually started receiving content
                if (newProcessingStage === "processing_content") {
                    isFinalResponse = true;
                }
              }
            }
          }
          // Direct operations on content parts (e.g., from o3 model logs)
          else if (data.p === "/message/content/parts/0" && typeof data.v === 'string' && (this.includeThinkingInMessage || newProcessingStage === "processing_content" || newProcessingStage === undefined)) {
             if (!this.includeThinkingInMessage && newProcessingStage !== "processing_content") {
                if (newProcessingStage === "processing_thoughts" || newProcessingStage === "awaiting_content" || newProcessingStage === undefined) {
                    chunkOverallOperation = "replace";
                    textForThisChunk = "";
                }
                newProcessingStage = "processing_content";
             } else if (this.includeThinkingInMessage && newProcessingStage !== "processing_content") {
                chunkOverallOperation = "replace";
                textForThisChunk = "";
                newProcessingStage = "processing_content";
             }

            if (data.o === "replace") {
              currentLineText = data.v;
              currentLineIsReplaceOperation = true;
            } else if (data.o === "append") {
              currentLineText = data.v;
              currentLineIsReplaceOperation = false;
            }
            console.log(`[${this.name}] parseDebuggerResponse - Direct op on content/parts/0. currentLineText: "${currentLineText.substring(0,50)}...", currentLineIsReplaceOp: ${currentLineIsReplaceOperation}`);
          }
          // Simple delta format (e.g., data: {"v": " some text"}) - common in 4o
          else if (typeof data.v === 'string' && data.p === undefined && data.o === undefined && !contentType) {
            // This is likely a text delta if no specific content_type was identified yet.
            // Treat as content if we are not explicitly in 'thoughts' when includeThinkingInMessage is false.
            if (!this.includeThinkingInMessage && newProcessingStage !== "processing_content") {
                if (newProcessingStage === "processing_thoughts" || newProcessingStage === "awaiting_content" || newProcessingStage === undefined) {
                    chunkOverallOperation = "replace";
                    textForThisChunk = "";
                }
                newProcessingStage = "processing_content";
            } else if (this.includeThinkingInMessage && newProcessingStage !== "processing_content" && newProcessingStage !== "processing_thoughts") {
                // If including thinking, but not in thoughts or content, this is likely start of content
                chunkOverallOperation = "replace";
                textForThisChunk = "";
                newProcessingStage = "processing_content";
            }
            currentLineText = data.v;
            currentLineIsReplaceOperation = false; // Assume append for simple deltas unless it's the first part of content
            console.log(`[${this.name}] parseDebuggerResponse - Simple delta {"v": ...}. currentLineText: "${currentLineText.substring(0,50)}..."`);
          }
          // Fallback for OpenAI standard delta (choices...delta.content)
          else if (data.choices && data.choices[0] && data.choices[0].delta && typeof data.choices[0].delta.content === 'string') {
             if (!this.includeThinkingInMessage && newProcessingStage !== "processing_content") {
                if (newProcessingStage === "processing_thoughts" || newProcessingStage === "awaiting_content" || newProcessingStage === undefined) {
                    chunkOverallOperation = "replace";
                    textForThisChunk = "";
                }
                newProcessingStage = "processing_content";
            } else if (this.includeThinkingInMessage && newProcessingStage !== "processing_content" && newProcessingStage !== "processing_thoughts") {
                chunkOverallOperation = "replace";
                textForThisChunk = "";
                newProcessingStage = "processing_content";
            }
            currentLineText = data.choices[0].delta.content;
            currentLineIsReplaceOperation = false;
            console.log(`[${this.name}] parseDebuggerResponse - OpenAI delta. currentLineText: "${currentLineText.substring(0,50)}..."`);
          }

          // Accumulate text for this chunk based on operations
          if (currentLineText) {
            if (textForThisChunk === null) textForThisChunk = ""; // Initialize if null

            if (currentLineIsReplaceOperation) { // If this line's content is a replacement for the chunk
              textForThisChunk = currentLineText;
              // If this is the first text part of the chunk, and we decided the chunk should replace, it's already set.
              // If not, this specific line replaces previous lines *within this chunk*.
            } else {
              textForThisChunk += currentLineText;
            }
          }
          console.log(`[${this.name}] parseDebuggerResponse - After line processing. textForThisChunk: "${textForThisChunk ? textForThisChunk.substring(0,70) : "null"}...", chunkOverallOperation: ${chunkOverallOperation}`);

          // General finality checks
          if (messageNode && newProcessingStage === "processing_content") {
            if (messageNode.metadata && messageNode.metadata.finish_details && messageNode.metadata.finish_details.type === "stop") isFinalResponse = true;
            if (messageNode.status === "finished_successfully" && messageNode.end_turn === true) isFinalResponse = true;
          }
          if (data.choices && data.choices[0] && data.choices[0].finish_reason === 'stop') isFinalResponse = true;
          
          // Support for data.completions array (observed in some models/responses)
          if (Array.isArray(data.completions) && data.completions.length > 0) {
              const completion = data.completions[0];
              if (typeof completion === 'string') {
                  currentLineText = completion;
                  currentLineIsReplaceOperation = true; // completions array usually contains full text or large chunks
                  console.log(`[${this.name}] parseDebuggerResponse - completions[0] string. currentLineText: "${currentLineText.substring(0,50)}..."`);
              } else if (typeof completion === 'object' && completion !== null && typeof completion.text === 'string') {
                  currentLineText = completion.text;
                  currentLineIsReplaceOperation = completion.operation === 'replace';
                  console.log(`[${this.name}] parseDebuggerResponse - completions[0].text. currentLineText: "${currentLineText.substring(0,50)}..."`);
              }
          }

        } catch (e) { console.warn(`[${this.name}] parseDebuggerResponse - Error parsing dataJson from line: '${line}'. dataJson: '${dataJson}'. Error:`, e); }
      } else if (line.trim() === "" || line.startsWith("event:") || line.startsWith("id:")) {
        continue;
      } else if (line.trim()) {
        // Try to parse as raw JSON if it doesn't have the data: prefix
        try {
            const potentialJson = JSON.parse(line.trim());
            if (potentialJson && typeof potentialJson === 'object') {
                // It's a valid JSON control message (like the conduit_token one)
                // We don't need to do anything with it yet, but we shouldn't warn
                continue;
            }
        } catch (e) {
            // Check if it's likely JavaScript or other non-SSE content
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('import') || 
                trimmedLine.startsWith('export') || 
                trimmedLine.startsWith('function(') ||
                trimmedLine.startsWith('const ') ||
                trimmedLine.startsWith('let ') ||
                trimmedLine.startsWith('//#') || // Catch source mapping URLs
                trimmedLine.includes('react.memo_cache_sentinel') ||
                trimmedLine.length > 500) { // Likely minified JS or large binary chunk
                // Silently skip likely non-SSE content
                continue;
            }

            // Not JSON either, so warn
            console.warn(`[${this.name}] parseDebuggerResponse - Unexpected non-data SSE line: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
        }
      }
    }
    console.log(`[${this.name}] parseDebuggerResponse FINISHING. Returning: text: "${textForThisChunk ? textForThisChunk.substring(0,100) + "..." : "null"}", isFinal: ${isFinalResponse}, operation: "${chunkOverallOperation}", newStage: ${newProcessingStage}`);
    return { text: textForThisChunk, isFinalResponse: isFinalResponse, operation: chunkOverallOperation, newProcessingStage };
  }

  formatOutput(thinkingText, answerText) {
    if (this.includeThinkingInMessage && thinkingText && thinkingText.trim() !== "") {
        try {
            const result = {
                thinking: thinkingText.trim(),
                answer: (answerText || "").trim()
            };
            return JSON.stringify(result);
        } catch (e) {
            console.error(`[${this.name}] Error stringifying thinking/answer object:`, e);
            return (answerText || "").trim();
        }
    }
    return (answerText || "").trim(); 
  }

  _captureResponseDOM(element = null) {
    if (!element) {
        // Broaden search to ensure we get the latest assistant message specifically
        const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (assistantMessages.length > 0) {
            // Pick the latest one
            const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
            // Look for the markdown container inside it
            element = lastAssistantMessage.querySelector('div.markdown') || lastAssistantMessage;
        } else {
            // Fallback to general response selectors
            const elements = document.querySelectorAll(this.responseSelector);
            if (elements.length > 0) {
                element = elements[elements.length - 1];
            }
        }
    }
    if (!element) {
        return { text: null, isStillGenerating: false };
    }

    let responseText = element.innerText || element.textContent || "";

    // CLEANUP: Strip ChatGPT UI noise
    responseText = this._cleanResponse(responseText);

    // Log for debugging mismatch
    if (responseText.length > 0) {
        console.log(`[${this.name}] DOM capture found text length: ${responseText.length}. Sample: "${responseText.substring(0, 30)}..."`);
    }

    if (this.lastSentMessage && responseText.trim().startsWith(this.lastSentMessage.trim())) {
        const potentialActualResponse = responseText.substring(this.lastSentMessage.length).trim();
        if (potentialActualResponse === "") {
            return { text: null, isStillGenerating: this._isResponseStillGeneratingDOM() };
        }
    }
    const isStillGenerating = this._isResponseStillGeneratingDOM();
    if (responseText && responseText.trim() !== "" && responseText.trim() !== this.lastSentMessage.trim()) {
        return {
            text: this.formatOutput("", responseText), 
            isStillGenerating: isStillGenerating
        };
    }
    return { text: null, isStillGenerating: isStillGenerating };
  }

  // Helper to strip ChatGPT's UI-specific labels and boilerplate
  _cleanResponse(text) {
      if (!text) return "";
      
      let cleaned = text;

      // 1. Remove footers/disclaimers
      const footers = [
          /ChatGPT can make mistakes\. Check important info\./gi,
          /ChatGPT can make mistakes\. Consider checking important information\./gi,
          /ChatGPT\s*v[\d.]+\s*/gi
      ];

      footers.forEach(regex => {
          cleaned = cleaned.replace(regex, "");
      });

      return cleaned.trim();
  }

  _isResponseStillGeneratingDOM() {
    // If the send button is visible and NOT disabled, we are definitely NOT generating.
    const sendButton = document.querySelector(this.sendButtonSelector);
    if (sendButton) {
        const isDisabled = sendButton.disabled || 
                           sendButton.getAttribute('aria-disabled') === 'true' ||
                           sendButton.classList.contains('disabled');
        if (!isDisabled) {
            return false; // Send button is ready, so we must be done.
        }
    }

    if (this.thinkingIndicatorSelector && document.querySelector(this.thinkingIndicatorSelector)) {
        return true;
    }
    if (this.thinkingIndicatorSelectorForDOM && document.querySelector(this.thinkingIndicatorSelectorForDOM)) {
        return true;
    }
    return false; 
  }

  async _startDOMMonitoring(requestId) {
    console.log(`[${this.name}] Starting DOM monitoring for requestId: ${requestId}.`);
    this._stopDOMMonitoring();

    let lastCapturedText = "";
    let noChangeStreak = 0;
    let checkCount = 0;
    
    // Warm-up delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    const monitor = () => {
        const callback = this.pendingResponseCallbacks.get(requestId);
        if (!callback) {
            this._stopDOMMonitoring();
            return;
        }

        checkCount++;
        
        const result = this._captureResponseDOM();
        const currentText = result.text;
        const isGenerating = result.isStillGenerating;
        let isFinalDOMResponse = false;
        
        if (currentText && currentText !== lastCapturedText) {
            lastCapturedText = currentText;
            noChangeStreak = 0;
            callback(requestId, currentText, false);
        } else if (currentText === lastCapturedText) {
            noChangeStreak++;
        }

        // Stability check: require longer streak for short text
        const requiredStreak = lastCapturedText.length < 50 ? 10 : 5;
        if (!isGenerating && noChangeStreak >= requiredStreak && lastCapturedText.trim() !== "") {
            isFinalDOMResponse = true;
        }

        // Safety timeout
        if (checkCount > 120) isFinalDOMResponse = true;

        if (isFinalDOMResponse) {
            console.log(`[${this.name}] DOM monitoring finished for ${requestId}. Final length: ${lastCapturedText.length}`);
            callback(requestId, lastCapturedText, true);
            this.pendingResponseCallbacks.delete(requestId);
            this._stopDOMMonitoring();
        } else {
            this.domMonitorTimer = setTimeout(monitor, 500);
        }
    };
    monitor();
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
      clearTimeout(this.domMonitorTimer);
      this.domMonitorTimer = null;
      console.log(`[${this.name}] DOM monitoring stopped.`);
    }
  }

  shouldSkipResponseMonitoring(inputText) {
    return false; 
  }

  getStreamingApiPatterns() {
    if (this.captureMethod === "debugger") {
      return [
        { urlPattern: "*://chatgpt.com/backend-api/conversation*", requestStage: "Response" },
        { urlPattern: "*://chatgpt.com/backend-api/f/conversation*", requestStage: "Response" },
        { urlPattern: "*://chat.openai.com/backend-api/conversation*", requestStage: "Response" },
        { urlPattern: "*conversation*", requestStage: "Response" }
      ];
    }
    // For websocket method, we don't need to return any patterns as we are not using the debugger.
    return [];
  }

  stopStreaming(requestId) {
    console.log(`[${this.name}] stopStreaming called for requestId: ${requestId}`);
    const callback = this.pendingResponseCallbacks.get(requestId);
    const accumulator = this.requestAccumulators.get(requestId);
    let lastKnownText = "";

    if (accumulator && typeof accumulator.text === 'string') {
      lastKnownText = accumulator.text;
    }

    if (callback) {
      // Send one final message indicating it was stopped, using the last known accumulated text.
      console.log(`[${this.name}] stopStreaming - Invoking callback for ${requestId} with final=true and STREAM_STOPPED_BY_USER. Last text: "${lastKnownText.substring(0,50)}..."`);
      callback(requestId, `${lastKnownText}[STREAM_STOPPED_BY_USER]`, true);
    } else {
      console.warn(`[${this.name}] stopStreaming - No pending callback found for requestId: ${requestId} when attempting to stop.`);
    }

    // Clean up
    if (this.pendingResponseCallbacks.has(requestId)) {
      this.pendingResponseCallbacks.delete(requestId);
      console.log(`[${this.name}] stopStreaming - Deleted pendingResponseCallback for ${requestId}.`);
    }
    if (this.requestAccumulators.has(requestId)) {
      this.requestAccumulators.delete(requestId);
      console.log(`[${this.name}] stopStreaming - Deleted requestAccumulator for ${requestId}.`);
    }

    // If DOM monitoring was active for this request (though less likely if debugger is primary)
    if (this.domMonitorTimer && this.captureMethod === "dom") { // Check if this request was the one being monitored
        // This is a bit tricky as domMonitorTimer isn't directly tied to a requestId in its current form.
        // For now, we'll assume a general stop might also stop DOM monitoring if it was the active one.
        // A more robust solution would tie DOM monitor to a specific requestId.
        // For debugger method, this part is less relevant.
        console.log(`[${this.name}] stopStreaming - Stopping DOM monitoring if it was active (relevant for DOM capture method).`);
        this._stopDOMMonitoring();
    }
    console.log(`[${this.name}] stopStreaming - Cleanup complete for requestId: ${requestId}.`);
  }
}

if (window.providerUtils && window.providerUtils.registerProvider) {
  const providerInstance = new ChatGptProvider();
  window.providerUtils.registerProvider(
    providerInstance.name,
    providerInstance.supportedDomains,
    providerInstance
  );
  console.log(`[${providerInstance.name}] Provider registered with providerUtils.`);
} else {
  console.error("[ChatGptProvider] providerUtils not found. Registration failed. Ensure provider-utils.js is loaded before chatgpt.js");
}
