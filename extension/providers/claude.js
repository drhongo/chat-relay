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
// AI Chat Relay - Claude Provider

class ClaudeProvider {
  constructor() {
    // --- START OF CONFIGURABLE PROPERTIES ---
    // Method for response capture: "debugger" or "dom"
    this.captureMethod = "debugger";
    // URL pattern for debugger to intercept if captureMethod is "debugger". Ensure this is specific.
    this.debuggerUrlPattern = "*/completion*"; // VERIFY THIS PATTERN
    // Whether to include "thinking" process in the message or just the final answer.
    // If true, parseDebuggerResponse returns a JSON string: { "thinking": "...", "answer": "..." }
    // If false, parseDebuggerResponse returns a string: "answer"
    this.includeThinkingInMessage = false;

    // Option to enable AI Studio function calling on load
    // ENABLE_CLAUDE_FUNCTION_CALLING: true or false
    this.ENABLE_CLAUDE_FUNCTION_CALLING = true;
    // --- END OF CONFIGURABLE PROPERTIES ---

    this.name = "ClaudeProvider"; // Updated name
    this.supportedDomains = ["claude.ai"];
    
    // Selectors for the AI Studio interface
    this.inputSelector = 'div.ProseMirror[contenteditable="true"]';
    
    // The send button selector
    this.sendButtonSelector = 'button[aria-label="Send message"]';
    
    // Updated response selectors based on the actual elements
    this.responseSelector = '.response-container, .response-text, .model-response, .model-response-container, ms-chat-turn, ms-prompt-chunk, ms-text-chunk, .very-large-text-container, .cmark-node';
    
    // Thinking indicator selector
    this.thinkingIndicatorSelector = '.thinking-indicator, .loading-indicator, .typing-indicator, .response-loading, loading-indicator';

    // Fallback selectors
    this.responseSelectorForDOMFallback = '.response-container, .model-response-text'; // Placeholder, adjust as needed
    this.thinkingIndicatorSelectorForDOM = '.thinking-indicator, .spinner'; // Placeholder, adjust as needed
    
    // Last sent message to avoid capturing it as a response
    this.lastSentMessage = '';

    // Initialize pendingResponseCallbacks
    this.pendingResponseCallbacks = new Map();
    this.requestBuffers = new Map(); // To accumulate text for each request

    // Call the method to ensure function calling is enabled on initial load
    // this.ensureFunctionCallingEnabled(); // Commented out as per user request

    // Listen for SPA navigation events to re-trigger the check
    // if (window.navigation) {
    //   window.navigation.addEventListener('navigate', (event) => {
    //     // We are interested in same-document navigations, common in SPAs
    //     if (!event.canIntercept || event.hashChange || event.downloadRequest !== null) {
    //       return;
    //     }
    //     // Check if the navigation is within the same origin and path structure of AI Studio
    //     const currentUrl = new URL(window.location.href);
    //     const destinationUrl = new URL(event.destination.url);

    //     if (currentUrl.origin === destinationUrl.origin && destinationUrl.pathname.startsWith("/prompts/")) {
    //       console.log(`[${this.name}] Detected SPA navigation to: ${event.destination.url}. Re-checking function calling toggle.`);
    //       // Use a timeout to allow the new view's DOM to settle
    //       setTimeout(() => {
    //         // this.ensureFunctionCallingEnabled(); // Commented out
    //       }, 1000); // Delay to allow DOM update
    //     }
    //   });
    // } else {
    //   console.warn(`[${this.name}] window.navigation API not available. Function calling toggle may not re-enable on SPA navigations.`);
    // }
  } // This curly brace correctly closes the constructor.

  /* // Commenting out the entire method as per user request
  ensureFunctionCallingEnabled() {
    if (!this.ENABLE_CLAUDE_FUNCTION_CALLING) {
      console.log(`[${this.name}] Function calling is disabled by configuration. Skipping.`);
      return;
    }

    const checkInterval = 500; // ms
    const maxDuration = 7000; // ms
    let elapsedTime = 0;
    const providerName = this.name;

    // Clear any existing timer for this specific functionality to avoid multiple polling loops
    if (this.functionCallingPollTimer) {
        clearTimeout(this.functionCallingPollTimer);
        this.functionCallingPollTimer = null;
        console.log(`[${providerName}] Cleared previous function calling poll timer.`);
    }
    
    console.log(`[${providerName}] Ensuring function calling is enabled (polling up to ${maxDuration / 1000}s).`);

    const tryEnableFunctionCalling = () => {
      console.log(`[${providerName}] Polling for function calling toggle. Elapsed: ${elapsedTime}ms`);
      const functionCallingToggle = document.querySelector('button[aria-label="Function calling"]');

      if (functionCallingToggle) {
        const isChecked = functionCallingToggle.getAttribute('aria-checked') === 'true';
        if (!isChecked) {
          console.log(`[${providerName}] Function calling toggle found and is NOT checked. Attempting to enable...`);
          functionCallingToggle.click();
          // Verify after a short delay if the click was successful
          setTimeout(() => {
            const stillChecked = functionCallingToggle.getAttribute('aria-checked') === 'true';
            if (stillChecked) {
              console.log(`[${providerName}] Function calling successfully enabled after click.`);
            } else {
              console.warn(`[${providerName}] Clicked function calling toggle, but it did NOT become checked. It might be disabled or unresponsive.`);
            }
          }, 200);
        } else {
          console.log(`[${providerName}] Function calling toggle found and is already enabled.`);
        }
        this.functionCallingPollTimer = null; // Clear timer once action is taken or element found
      } else {
        elapsedTime += checkInterval;
        if (elapsedTime < maxDuration) {
          console.log(`[${providerName}] Function calling toggle not found, will retry in ${checkInterval}ms.`);
          this.functionCallingPollTimer = setTimeout(tryEnableFunctionCalling, checkInterval);
        } else {
          console.warn(`[${providerName}] Function calling toggle button (selector: 'button[aria-label="Function calling"]') not found after ${maxDuration}ms. It might not be available on this page/view or selector is incorrect.`);
          this.functionCallingPollTimer = null; // Clear timer
        }
      }
    };

    // Start the first attempt after a brief initial delay
    this.functionCallingPollTimer = setTimeout(tryEnableFunctionCalling, 500);
  }
  */

  // Send a message to the chat interface
  async sendChatMessage(messageContent) {
    console.log(`[${this.name}] sendChatMessage called with content type:`, typeof messageContent, Array.isArray(messageContent) ? `Array length: ${messageContent.length}` : '');
    const inputField = document.querySelector(this.inputSelector);
    const sendButton = document.querySelector(this.sendButtonSelector);

    if (!inputField || !sendButton) {
      console.error(`[${this.name}] Missing input field or send button. Input: ${this.inputSelector}, Button: ${this.sendButtonSelector}`);
      return false;
    }

    console.log(`[${this.name}] Attempting to send message to AI Studio with:`, {
      inputField: inputField.className,
      sendButton: sendButton.getAttribute('aria-label') || sendButton.className
    });

    try {
      let textToInput = "";
      let blobToPaste = null;
      let blobMimeType = "image/png"; // Default MIME type

      if (typeof messageContent === 'string') {
        textToInput = messageContent;
        this.lastSentMessage = textToInput;
        console.log(`[${this.name}] Handling string content:`, textToInput.substring(0, 100) + "...");
      } else if (messageContent instanceof Blob) {
        blobToPaste = messageContent;
        blobMimeType = messageContent.type || blobMimeType;
        this.lastSentMessage = `Blob data (type: ${blobMimeType}, size: ${blobToPaste.size})`;
        console.log(`[${this.name}] Handling Blob content. Size: ${blobToPaste.size}, Type: ${blobMimeType}`);
      } else if (Array.isArray(messageContent)) {
        console.log(`[${this.name}] Handling array content.`);
        for (const part of messageContent) {
          if (part.type === "text" && typeof part.text === 'string') {
            textToInput += (textToInput ? "\n" : "") + part.text;
            console.log(`[${this.name}] Added text part:`, part.text.substring(0, 50) + "...");
          } else if (part.type === "image_url" && part.image_url && typeof part.image_url.url === 'string') {
            if (!blobToPaste) { // Prioritize the first image found
              try {
                const response = await fetch(part.image_url.url);
                blobToPaste = await response.blob();
                blobMimeType = blobToPaste.type || blobMimeType;
                console.log(`[${this.name}] Fetched image_url as Blob. Size: ${blobToPaste.size}, Type: ${blobMimeType}`);
              } catch (e) {
                console.error(`[${this.name}] Error fetching image_url ${part.image_url.url}:`, e);
              }
            } else {
              console.warn(`[${this.name}] Multiple image_urls found, only the first will be pasted.`);
            }
          }
        }
        this.lastSentMessage = `Array content (Text: "${textToInput.substring(0,50)}...", Image: ${blobToPaste ? 'Yes' : 'No'})`;
      } else {
        console.error(`[${this.name}] Unhandled message content type: ${typeof messageContent}. Cannot send.`);
        this.lastSentMessage = `Unhandled data type: ${typeof messageContent}`;
        return false;
      }

      // Set text input if any
      if (textToInput) {
        inputField.textContent = textToInput; // Use textContent for contenteditable div
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        console.log(`[${this.name}] Set input field textContent with accumulated text.`);
      } else {
        // If there's no text but an image, ensure the input field is clear
        inputField.textContent = "";
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Paste blob if any
      if (blobToPaste) {
        const dataTransfer = new DataTransfer();
        const file = new File([blobToPaste], "pasted_image." + (blobMimeType.split('/')[1] || 'png'), { type: blobMimeType });
        dataTransfer.items.add(file);
        const pasteEvent = new ClipboardEvent('paste', {
          clipboardData: dataTransfer,
          bubbles: true,
          cancelable: true
        });
        inputField.dispatchEvent(pasteEvent);
        console.log(`[${this.name}] Dispatched paste event with Blob data.`);
      }
      
      inputField.focus();
      await new Promise(resolve => setTimeout(resolve, 100));

      let attempts = 0;
      const maxAttempts = 60; // Try up to 60 times (5 minutes total)
      const retryDelay = 5000; // 5 seconds delay between attempts

      while (attempts < maxAttempts) {
        const isDisabled = sendButton.disabled ||
                           sendButton.getAttribute('aria-disabled') === 'true' ||
                           sendButton.classList.contains('disabled');

        if (!isDisabled) {
          // Removed check for input field content matching lastSentMessage
          // as it can cause issues when there are multiple messages waiting to be sent
          console.log(`[${this.name}] Send button is enabled. Clicking send button (attempt ${attempts + 1}).`);
          sendButton.click();
          return true; // Successfully clicked
        }

        attempts++;
        if (attempts >= maxAttempts) {
          console.error(`[${this.name}] Send button remained disabled after ${maxAttempts} attempts. Failed to send message.`);
          return false; // Failed to send
        }

        console.log(`[${this.name}] Send button is disabled (attempt ${attempts}). Trying to enable and will retry in ${retryDelay}ms.`);
        // Attempt to trigger UI updates that might enable the button
        inputField.dispatchEvent(new Event('input', { bubbles: true })); // Re-dispatch input
        inputField.dispatchEvent(new Event('change', { bubbles: true }));
        inputField.dispatchEvent(new Event('blur', { bubbles: true }));
        // Focusing and bluring input sometimes helps enable send buttons
        inputField.focus();
        await new Promise(resolve => setTimeout(resolve, 50)); // Short delay for focus
        inputField.blur();
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
      // Should not be reached if logic is correct, but as a fallback:
      console.error(`[${this.name}] Exited send button check loop unexpectedly.`);
      return false;
    } catch (error) {
      console.error(`[${this.name}] Error sending message to AI Studio:`, error);
      return false;
    }
  }

  async initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}. CURRENT CAPTURE METHOD IS: ${this.captureMethod}`);
    if (this.captureMethod === "debugger") {
      this.pendingResponseCallbacks.set(requestId, responseCallback);

      const patterns = this.getStreamingApiPatterns();
      if (patterns.length > 0) {
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
      }

      console.log(`[${this.name}] Stored callback for debugger response, requestId: ${requestId}`);
    } else if (this.captureMethod === "dom") {
      console.log(`[${this.name}] Starting DOM monitoring for requestId: ${requestId}`);
      this.pendingResponseCallbacks.set(requestId, responseCallback);
      this._stopDOMMonitoring(); 
      this._startDOMMonitoring(requestId); 
    } else {
      console.error(`[${this.name}] Unknown capture method: ${this.captureMethod}`);
      responseCallback(requestId, `[Error: Unknown capture method '${this.captureMethod}' in provider]`, true); 
      this.pendingResponseCallbacks.delete(requestId); 
    }
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground, errorFromBackground = null) {
    // !!!!! VERY IMPORTANT ENTRY LOG !!!!!
    console.log('[[ClaudeProvider]] handleDebuggerData ENTERED. RequestId: ' + requestId + ', isFinalFromBackground: ' + isFinalFromBackground + ', RawData Length: ' + (rawData ? rawData.length : 'null') + ', ErrorFromBG: ' + errorFromBackground);

    const callback = this.pendingResponseCallbacks.get(requestId);

    if (!callback) {
      console.warn('[' + this.name + '] No pending callback for requestId: ' + requestId + '. Ignoring debugger data/error.');
      if (this.requestBuffers.has(requestId)) {
        this.requestBuffers.delete(requestId);
      }
      return;
    }

    if (errorFromBackground) {
      console.warn(`[${this.name}] handleDebuggerData: Propagating error for requestId ${requestId}: ${errorFromBackground}`);
      callback(requestId, `[Provider Error from Background] ${errorFromBackground}`, true); // Pass error as text, mark as final
      this.pendingResponseCallbacks.delete(requestId);
      if (this.requestBuffers.has(requestId)) {
        this.requestBuffers.delete(requestId); // Clean up buffer too
      }
      return; // Stop further processing
    }

    if (!this.requestBuffers.has(requestId)) {
      this.requestBuffers.set(requestId, { accumulatedText: "" });
    }
    const requestBuffer = this.requestBuffers.get(requestId);

    let textFromCurrentChunk = "";
    let isLogicalEndOfMessageInChunk = false;

    if (rawData && rawData.trim() !== "") {
      console.log('[' + this.name + '] handleDebuggerData: Processing rawData for ' + requestId + '. Accumulated before: ' + requestBuffer.accumulatedText.length);
      const parseOutput = this.parseDebuggerResponse(rawData, requestId);
      
      textFromCurrentChunk = parseOutput.text;
      isLogicalEndOfMessageInChunk = parseOutput.isFinalResponse;

      if (textFromCurrentChunk) {
        requestBuffer.accumulatedText += textFromCurrentChunk;
      }
      console.log('[' + this.name + '] handleDebuggerData: Parsed chunk for ' + requestId + '. TextInChunk: ' + (textFromCurrentChunk ? textFromCurrentChunk.substring(0,50) : 'N/A') + '..., LogicalEndInChunk: ' + isLogicalEndOfMessageInChunk + '. Accumulated after: ' + requestBuffer.accumulatedText.length);
    } else {
      console.log('[' + this.name + '] handleDebuggerData: Received empty/whitespace rawData for ' + requestId + '. isFinalFromBackground: ' + isFinalFromBackground + '. Accumulated: ' + requestBuffer.accumulatedText.length);
    }

    const shouldSendFinalResponse = isLogicalEndOfMessageInChunk || (isFinalFromBackground && !isLogicalEndOfMessageInChunk);

    console.log('[' + this.name + '] handleDebuggerData: Eval for ' + requestId + '. LogicalEnd: ' + isLogicalEndOfMessageInChunk + ', isFinalBG: ' + isFinalFromBackground + ', includeThinking: ' + this.includeThinkingInMessage + ', AccLen: ' + requestBuffer.accumulatedText.length + '. ShouldSendFinal: ' + shouldSendFinalResponse);

    if (shouldSendFinalResponse) {
      console.log('[' + this.name + '] handleDebuggerData: FINAL RESPONSE condition met for ' + requestId + '. Sending full accumulated text. Length: ' + requestBuffer.accumulatedText.length);
      callback(requestId, requestBuffer.accumulatedText, true);
      this.pendingResponseCallbacks.delete(requestId);
      this.requestBuffers.delete(requestId);
    } else if (this.includeThinkingInMessage && textFromCurrentChunk) {
        console.log('[' + this.name + '] handleDebuggerData: Sending INTERMEDIATE chunk for ' + requestId + '. Text: ' + (textFromCurrentChunk ? textFromCurrentChunk.substring(0,50) : 'N/A') + '...');
        callback(requestId, textFromCurrentChunk, false);
    } else {
        console.log('[' + this.name + '] handleDebuggerData: Not sending response for ' + requestId + ' YET.');
    }
  }

  // --- START OF CLAUDE SSE DEBUGGER PARSING LOGIC ---
  parseDebuggerResponse(sseChunk, requestIdForLog = 'unknown') {
    // console.log('[' + this.name + '] Parsing Claude SSE chunk for reqId ' + requestIdForLog + ' (first 300): ' + (sseChunk ? sseChunk.substring(0, 300) : "null"));
    let extractedTextThisChunk = "";
    let isEndOfMessageEventInThisChunk = false;
    const sseMessages = sseChunk.split('\n\n');

    for (const sseMessage of sseMessages) {
        if (sseMessage.trim() === "") continue;

        let eventType = null;
        let jsonDataString = null;
        const lines = sseMessage.split('\n');

        for (const line of lines) {
            if (line.startsWith("event:")) {
                eventType = line.substring("event:".length).trim();
            } else if (line.startsWith("data:")) {
                jsonDataString = line.substring("data:".length).trim();
            }
        }
        
        if (eventType === "message_stop") {
            console.log('[' + this.name + '] ReqId ' + requestIdForLog + ' - Event: "message_stop" detected. Marking EOM.');
            isEndOfMessageEventInThisChunk = true;
        } else if (eventType && jsonDataString) {
            try {
                const dataObject = JSON.parse(jsonDataString);
                if (eventType === "content_block_delta") {
                    if (dataObject.delta && dataObject.delta.type === "text_delta" && typeof dataObject.delta.text === 'string') {
                        extractedTextThisChunk += dataObject.delta.text;
                    }
                } else if (eventType === "message_delta") {
                    if (dataObject.delta && dataObject.delta.stop_reason) {
                        console.log('[' + this.name + '] ReqId ' + requestIdForLog + ' - Event: "message_delta" with stop_reason: ' + dataObject.delta.stop_reason + '. Marking EOM.');
                        isEndOfMessageEventInThisChunk = true;
                    }
                }
            } catch (e) {
                console.warn('[' + this.name + '] ReqId ' + requestIdForLog + ' - Error parsing JSON from Claude SSE event \'' + eventType + '\':', e, "JSON Data:", jsonDataString);
            }
        }
    }
    // console.log('[' + this.name + '] parseDebuggerResponse for reqId ' + requestIdForLog + ' result: Text: "' + (extractedTextThisChunk ? extractedTextThisChunk.substring(0,50) : "N/A") + '...", isEOM: ' + isEndOfMessageEventInThisChunk);
    return { text: extractedTextThisChunk, isFinalResponse: isEndOfMessageEventInThisChunk };
  }
  // --- END OF CLAUDE SSE DEBUGGER PARSING LOGIC ---

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
  
  // --- Other methods (DOM fallback, etc. - largely unchanged but included for completeness) ---
   _captureResponseDOM(element = null) {
    console.log(`[${this.name}] _captureResponseDOM (DOM method) called with element:`, element);
    if (!element && this.captureMethod === "dom") {
        const elements = document.querySelectorAll(this.responseSelector);
        if (elements.length > 0) {
            element = elements[elements.length - 1];
            console.log(`[${this.name}] _captureResponseDOM: Found element via querySelector during polling.`);
        }
    }
    if (!element) {
      console.log(`[${this.name}] _captureResponseDOM: No element provided or found.`);
      return { found: false, text: '' };
    }
    if (this._isResponseStillGeneratingDOM()) {
      console.log(`[${this.name}] Response is still being generated (_isResponseStillGeneratingDOM check), waiting for completion`);
      return { found: false, text: '' };
    }
    console.log(`[${this.name}] Attempting to capture DOM response from Claude...`);
    let responseText = "";
    let foundResponse = false;
    try {
      // Simplified DOM capture for Claude - assumes response is in a known container
      // This part would need to be specific to Claude's DOM structure if DOM capture is used.
      // For now, focusing on debugger method.
      const responseElements = document.querySelectorAll(this.responseSelectorForDOMFallback); // Use appropriate selector
      if (responseElements.length > 0) {
          const lastResponseElement = responseElements[responseElements.length -1];
          // Check if it's a model response and not user input etc.
          // This is highly dependent on Claude's actual DOM structure.
          // Example:
          // if (lastResponseElement.closest('.message-row[data-role="assistant"]')) {
          //    responseText = lastResponseElement.textContent.trim();
          //    foundResponse = true;
          // }
          responseText = lastResponseElement.textContent.trim(); // Placeholder
          if (responseText && responseText !== this.lastSentMessage) {
              foundResponse = true;
          }
      }
      if (!foundResponse) {
        console.log("CLAUDE (DOM): Response not found yet.");
      }
    } catch (error) {
      console.error("CLAUDE (DOM): Error capturing response:", error);
    }
     if (foundResponse && responseText) {
      responseText = responseText.trim()
        .replace(/^(Loading|Thinking).*/gim, '') // General cleanup
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    return {
      found: foundResponse && !!responseText.trim(),
      text: responseText
    };
  }

  _findResponseElementDOM(container) {
    console.log(`[${this.name}] _findResponseElementDOM called on container:`, container);
    if (!container) return null;

    const elements = container.querySelectorAll(this.responseSelectorForDOMFallback);
    if (elements.length > 0) {
      const lastElement = elements[elements.length - 1];
      console.log(`[${this.name}] Found last response element via DOM:`, lastElement);
      // Add checks to ensure it's not the user's input or an old response
      if (lastElement.textContent && lastElement.textContent.trim() !== this.lastSentMessage) {
        return lastElement;
      }
    }
    console.log(`[${this.name}] No suitable response element found via DOM in container.`);
    return null;
  }

  shouldSkipResponseMonitoring() {
    // Example: if a provider indicates via a specific property or method
    // For CLAUDE, if using debugger, we don't need DOM monitoring.
    // This method is more for providers that might sometimes use DOM, sometimes not.
    // console.log(`[${this.name}] shouldSkipResponseMonitoring called. Capture method: ${this.captureMethod}`);
    return this.captureMethod === "debugger";
  }

  _isResponseStillGeneratingDOM() {
    // This is for the DOM fallback method
    const thinkingIndicator = document.querySelector(this.thinkingIndicatorSelectorForDOM);
    if (thinkingIndicator) {
      // console.log(`[${this.name}] DOM Fallback: Thinking indicator found.`);
      return true;
    }
    // console.log(`[${this.name}] DOM Fallback: No thinking indicator found.`);
    return false;
  }

  getStreamingApiPatterns() {
    console.log(`[${this.name}] getStreamingApiPatterns called. Capture method: ${this.captureMethod}`);
    if (this.captureMethod === "debugger" && this.debuggerUrlPattern) {
      console.log(`[${this.name}] Using debugger URL pattern: ${this.debuggerUrlPattern}`);
      return [{ urlPattern: this.debuggerUrlPattern }];
    }
    console.log(`[${this.name}] No debugger patterns to return (captureMethod is not 'debugger' or no pattern set).`);
    return [];
  }

  _startDOMMonitoring(requestId) {
    console.log(`[${this.name}] DOM Fallback: _startDOMMonitoring for requestId: ${requestId}`);
    this._stopDOMMonitoring(); // Stop any existing observer

    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) {
      console.error(`[${this.name}] DOM Fallback: No callback for requestId ${requestId} in _startDOMMonitoring.`);
      return;
    }

    let attempts = 0;
    const maxAttempts = 15; // Try for ~15 seconds
    const interval = 1000;

    this.domMonitorTimer = setInterval(() => {
      console.log(`[${this.name}] DOM Fallback: Polling attempt ${attempts + 1}/${maxAttempts} for requestId: ${requestId}`);
      const responseData = this._captureResponseDOM(); // Will use this.responseSelectorForDOMFallback

      if (responseData.found && responseData.text.trim() !== "") {
        console.log(`[${this.name}] DOM Fallback: Response captured for requestId ${requestId}. Text (first 100): ${responseData.text.substring(0,100)}`);
        this._stopDOMMonitoring();
        callback(requestId, responseData.text, true); // Assume final for DOM capture
        this.pendingResponseCallbacks.delete(requestId);
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          console.warn(`[${this.name}] DOM Fallback: Max attempts reached for requestId ${requestId}. No response captured.`);
          this._stopDOMMonitoring();
          callback(requestId, "[Error: Timed out waiting for DOM response]", true); // Error, final
          this.pendingResponseCallbacks.delete(requestId);
        }
      }
    }, interval);
    console.log(`[${this.name}] DOM Fallback: Monitoring started with timer ID ${this.domMonitorTimer}`);
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
      console.log(`[${this.name}] DOM Fallback: Stopping DOM monitoring timer ID ${this.domMonitorTimer}`);
      clearInterval(this.domMonitorTimer);
      this.domMonitorTimer = null;
    }
  }
}

// Ensure the provider is available on the window for the content script
if (window.providerUtils) {
  const providerInstance = new ClaudeProvider();
  window.providerUtils.registerProvider(
    providerInstance.name,
    providerInstance.supportedDomains,
    providerInstance
  );
} else {
  console.error("CLAUDE: providerUtils not found. Registration failed.");
}
