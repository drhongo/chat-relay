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
// AI Chat Relay - Gemini Provider

class GeminiProvider {
  constructor() {
    this.name = 'GeminiProvider';
    this.supportedDomains = ['gemini.google.com'];

    // --- START OF CONFIGURABLE PROPERTIES ---
    this.captureMethod = "dom"; // Reverting to DOM as primary for stability
    this.debuggerUrlPattern = "*://gemini.google.com/*";
    this.includeThinkingInMessage = false;
    // --- END OF CONFIGURABLE PROPERTIES ---

    // Selectors for the Gemini interface
    this.inputSelector = 'div.ql-editor, div[contenteditable="true"], textarea[placeholder="Enter a prompt here"], textarea.message-input';
    this.sendButtonSelector = 'button[aria-label="Send message"], .send-button-container button, .input-area-container button[kind="filled"]';
    this.responseSelector = 'div.markdown.markdown-main-panel, message-content div.markdown, [id^="model-response-message-content"], .model-response-text .markdown';
    this.thinkingIndicatorSelector = '.thinking-indicator, .loading-indicator, .typing-indicator, .response-loading, .blue-circle, .stop-icon, button[aria-label="Stop response"]';
    this.newChatSelector = 'a[href="/app"], .new-chat-button, [data-testid="sidebar-new-chat-button"], button[aria-label="New chat"]';

    this.lastSentMessage = '';
    this.pendingResponseCallbacks = new Map();
    this.requestAccumulators = new Map();
    this.domFallbackTimeout = 12000;
    this.domFallbackTimer = null;
    this.domMonitorTimer = null;

    this._loadSettings();
    console.log(`[${this.name}] Provider initialized.`);
  }

  _loadSettings() {
    chrome.storage.sync.get({ geminiCaptureMethod: 'dom' }, (items) => {
      this.captureMethod = items.geminiCaptureMethod;
      console.log(`[${this.name}] Capture method updated to: ${this.captureMethod}`);
    });
  }

  // Send a message to the chat interface
  async sendChatMessage(messageContent, messageOrId) {
    const requestId = typeof messageOrId === 'object' ? messageOrId.requestId : messageOrId;
    console.log(`[${this.name}] sendChatMessage called for requestId ${requestId}`);
    const MAX_RETRIES = 5;

    let textToInput = "";
    if (typeof messageContent === 'string') {
      textToInput = messageContent;
    } else if (Array.isArray(messageContent)) {
      textToInput = messageContent.map(p => p.text || "").join("\n");
    }
    
    try {
      this.lastSentMessage = textToInput;

      // Handle New Chat request
      if (typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat) {
          // Robust check for New Chat - if we are not on the main /app page, or even if we are (to clear draft)
          console.log(`[${this.name}] New Chat requested. Clicking New Chat button.`);
          const newChatButton = document.querySelector(this.newChatSelector);
          if (newChatButton) {
              const rect = newChatButton.getBoundingClientRect();
              const clientX = rect.left + rect.width / 2;
              const clientY = rect.top + rect.height / 2;

              newChatButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
              newChatButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
              newChatButton.click();
              newChatButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
              newChatButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));

              await new Promise(resolve => setTimeout(resolve, 3000));
          } else {
              console.warn(`[${this.name}] New Chat button not found, continuing with current chat.`);
          }
      }

      // Find input element (after potential navigation)
      const inputElement = document.querySelector(this.inputSelector);
      if (!inputElement) {
        console.error(`[${this.name}] Missing input field (${this.inputSelector})`);
        this._reportSendError(requestId, "Input field not found.");
        return false;
      }

      inputElement.focus();
      
      // Use execCommand for contentEditable or fallback to value/innerText
      if (inputElement.getAttribute('contenteditable') === 'true' || inputElement.contentEditable === 'true') {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, textToInput);
        
        if (inputElement.innerText.trim() === "" && textToInput.trim() !== "") {
            inputElement.innerText = textToInput;
        }
      } else {
        inputElement.value = textToInput;
      }

      // Trigger events
      const events = ['input', 'change', 'keyup', 'keydown'];
      events.forEach(type => inputElement.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));

      await new Promise(resolve => setTimeout(resolve, 1000));

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const sendButton = document.querySelector(this.sendButtonSelector);
        if (sendButton) {
          const isDisabled = sendButton.disabled || 
                             sendButton.getAttribute('aria-disabled') === 'true' ||
                             sendButton.classList.contains('disabled');
          
          if (!isDisabled) {
            console.log(`[${this.name}] Attempting to click send button on attempt ${attempt + 1}`);
            
            const rect = sendButton.getBoundingClientRect();
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;
            
            sendButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
            sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX, clientY }));
            sendButton.click();
            sendButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', clientX, clientY }));
            sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX, clientY }));
            
            inputElement.blur();
            await new Promise(resolve => setTimeout(resolve, 800));
            
            const currentContent = (inputElement.value || inputElement.innerText || "").trim();
            if (currentContent === "") {
                console.log(`[${this.name}] Message sent successfully (input cleared).`);
                return true;
            }

            // Enter key fallback
            inputElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            await new Promise(resolve => setTimeout(resolve, 800));
            if ((inputElement.value || inputElement.innerText || "").trim() === "") {
                return true;
            }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      this._reportSendError(requestId, "Failed to clear input after all attempts.");
      return false;
    } catch (error) {
      console.error(`[${this.name}] Error in sendChatMessage:`, error);
      this._reportSendError(requestId, error.message);
      return false;
    }
  }

  _reportSendError(requestId, errorMessage) {
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (callback) {
        callback(requestId, `[PROVIDER_SEND_ERROR: ${errorMessage}]`, true); 
        this.pendingResponseCallbacks.delete(requestId);
    }
  }

  _startDOMMonitoring(requestId) {
    console.log(`[${this.name}] Starting DOM monitoring for requestId: ${requestId}.`);
    let lastCapturedText = "";
    let noChangeStreak = 0;
    let checkCount = 0;
    
    const monitor = () => {
        checkCount++;
        const callback = this.pendingResponseCallbacks.get(requestId);
        if (!callback) {
            this._stopDOMMonitoring();
            return;
        }
        
        const captureResult = this.captureResponse();
        const currentText = captureResult.text;
        const isStillGenerating = captureResult.isStillGenerating;
        let isFinalDOMResponse = false;
        
        if (currentText && currentText !== lastCapturedText) {
            lastCapturedText = currentText;
            noChangeStreak = 0;
            callback(requestId, currentText, false);
        } else if (currentText === lastCapturedText) {
            noChangeStreak++;
        }

        if (!isStillGenerating && noChangeStreak >= 5 && lastCapturedText.trim() !== "") {
            isFinalDOMResponse = true;
        }

        // If we've been waiting for 10 seconds and have NO text and NO generating signal, assume something is wrong and finish
        if (!isStillGenerating && noChangeStreak >= 20 && lastCapturedText.trim() === "") {
            console.log(`[${this.name}] No text found after 10s of polling and no generating signal. Finishing.`);
            isFinalDOMResponse = true;
        }
        
        if (checkCount > 60) isFinalDOMResponse = true;

        if (isFinalDOMResponse) {
            console.log(`[${this.name}] DOM monitoring finished for ${requestId}. Final length: ${lastCapturedText.length}`);
            callback(requestId, lastCapturedText, true);
            this.pendingResponseCallbacks.delete(requestId);
            this._stopDOMMonitoring();
        } else {
            this.domMonitorTimer = setTimeout(monitor, 500); 
        }
    };
    this.domMonitorTimer = setTimeout(monitor, 100); 
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
        clearTimeout(this.domMonitorTimer);
        this.domMonitorTimer = null;
    }
  }

  // Standard method name used by content.js - with Shadow DOM piercing
  captureResponse() {
    console.log(`[${this.name}] captureResponse ENTER`);
    
    // Helper to search inside shadow roots
    const findDeep = (root, selector) => {
        const elements = Array.from(root.querySelectorAll(selector));
        const shadowElements = Array.from(root.querySelectorAll('*'))
            .filter(el => el.shadowRoot)
            .flatMap(el => findDeep(el.shadowRoot, selector));
        return [...elements, ...shadowElements];
    };

    // Try primary and fallback selectors with shadow piercing
    let responseElements = findDeep(document, this.responseSelector);

    // Filter out elements that are likely part of the "Welcome/Home" screen chips
    responseElements = responseElements.filter(el => {
        const text = el.innerText || "";
        // Gemini welcome screen often contains these strings
        if (text.includes("Create image") || text.includes("Help me learn") || text.includes("Boost my day") || text.includes("Create music")) {
            return false;
        }
        return true;
    });

    console.log(`[${this.name}] Primary search found ${responseElements.length} elements.`);

    if (responseElements.length === 0) {
        responseElements = findDeep(document, 'message-content, .model-response-text, .markdown, .response-container');
        // Apply same filter
        responseElements = responseElements.filter(el => {
            const text = el.innerText || "";
            return !(text.includes("Create image") || text.includes("Help me learn") || text.includes("Boost my day") || text.includes("Create music"));
        });
        console.log(`[${this.name}] Fallback search found ${responseElements.length} elements.`);
    }

    // Final desperate search - only if we didn't find anything and we are SURE we're not on the home page suggestions
    if (responseElements.length === 0) {
        responseElements = findDeep(document, 'div').filter(el => {
            const text = el.innerText || "";
            const isHomeSuggestion = text.includes("Create image") || text.includes("Help me learn") || text.includes("Boost my day") || text.includes("Create music");
            // Also filter out standard UI labels
            const isUILabel = text.trim() === "Gemini" || text.trim() === "Enter a prompt here";

            return text.length > 50 && !isHomeSuggestion && !isUILabel && !el.querySelector('textarea') && !el.closest('sidebar, .sidebar');
        });
        console.log(`[${this.name}] Desperate search found ${responseElements.length} elements.`);
    }

    const lastResponse = responseElements[responseElements.length - 1];
    let text = lastResponse ? (lastResponse.innerText || lastResponse.textContent || "").trim() : "";

    // Safety check: if text exactly matches the prompt, it might be the user message echoing back
    if (this.lastSentMessage && text === this.lastSentMessage.trim()) {
        console.log(`[${this.name}] Extracted text matches last sent message. Skipping.`);
        text = "";
    }

    console.log(`[${this.name}] Extracted text length: ${text.length}. Sample: "${text.substring(0, 50)}..."`);
    
    // Check for thinking indicator
    const thinkingNodes = [
        ...findDeep(document, this.thinkingIndicatorSelector),
        ...findDeep(document, '.blue-circle'),
        ...findDeep(document, '.typing-indicator')
    ];
                     
    const isStillGenerating = thinkingNodes.some(node => node && node.offsetParent !== null);
    console.log(`[${this.name}] isStillGenerating: ${isStillGenerating} (Found ${thinkingNodes.length} indicator nodes)`);
    
    const result = { 
      found: text.length > 0, 
      text, 
      isStillGenerating,
      elementCount: responseElements.length
    };

    window.CHAT_RELAY_DEBUG = { lastResult: result, timestamp: new Date().toISOString() };
    return result;
  }

  getResponseText(element) {
    if (!element) return "";
    return element.innerText || element.textContent || "";
  }

  isResponseComplete(element) {
    const result = this.captureResponse();
    return !result.isStillGenerating;
  }

  async initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}. Capture method: ${this.captureMethod}`);
    this.pendingResponseCallbacks.set(requestId, responseCallback);

    // Reset accumulator for this request
    this.requestAccumulators.set(requestId, { text: "", isDefinitelyFinal: false });

    if (this.captureMethod === "debugger") {
      console.log(`[${this.name}] Debugger capture initiated. Requesting debugger attachment.`);

      const patterns = this.getStreamingApiPatterns();
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

      // Clear any existing fallback timer
      if (this.domFallbackTimer) clearTimeout(this.domFallbackTimer);

      this.domFallbackTimer = setTimeout(() => {
        const acc = this.requestAccumulators.get(requestId);
        if (acc && acc.text.length === 0) {
          console.warn(`[${this.name}] No data received via debugger after ${this.domFallbackTimeout}ms. Falling back to DOM capture.`);
          this._startDOMMonitoring(requestId);
        }
      }, this.domFallbackTimeout);
    } else {
      this._startDOMMonitoring(requestId);
    }
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground) {
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) return;

    let accumulator = this.requestAccumulators.get(requestId);
    if (!accumulator) {
      accumulator = { text: "", isDefinitelyFinal: false };
      this.requestAccumulators.set(requestId, accumulator);
    }

    if (accumulator.isDefinitelyFinal) return;

    if (rawData && rawData.trim() !== "") {
        const parseOutput = this.parseDebuggerResponse(rawData);

        if (accumulator.text.length === 0 && parseOutput.text) {
          console.log(`[${this.name}] First debugger data received for ${requestId}. Disabling DOM fallback timer.`);
          if (this.domFallbackTimer) {
              clearTimeout(this.domFallbackTimer);
              this.domFallbackTimer = null;
          }
        }

        if (parseOutput.text !== null) {
            accumulator.text = parseOutput.text;
        }

        if (parseOutput.isFinalResponse) {
            accumulator.isDefinitelyFinal = true;
        }

        if (parseOutput.text !== null || accumulator.isDefinitelyFinal) {
          callback(requestId, accumulator.text, accumulator.isDefinitelyFinal);
        }
    } else if (isFinalFromBackground && !accumulator.isDefinitelyFinal) {
        accumulator.isDefinitelyFinal = true;
        callback(requestId, accumulator.text, true);
    }

    if (accumulator.isDefinitelyFinal) {
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
    }
  }

  parseDebuggerResponse(rawDataString) {
    let text = null;
    let isFinalResponse = false;

    if (!rawDataString) return { text, isFinalResponse };

    try {
        // Gemini often returns chunks that are arrays like [["something", ...]]
        // or multiple such arrays separated by newlines or numbers (length prefixes).

        // Strategy: find all JSON-like array structures and extract the longest string
        // which is almost always the actual response content.

        const chunks = rawDataString.split("\n");
        let bestText = "";

        for (const chunk of chunks) {
            if (!chunk.trim()) continue;

            // Try to find array patterns
            const matches = chunk.match(/\[[\s\S]*\]/g);
            if (matches) {
                for (const match of matches) {
                    try {
                        const parsed = JSON.parse(match);
                        // Recursively search for the longest string in the parsed object
                        const findLongestString = (obj) => {
                            let longest = "";
                            if (typeof obj === 'string') return obj;
                            if (Array.isArray(obj)) {
                                obj.forEach(item => {
                                    const s = findLongestString(item);
                                    if (s.length > longest.length) longest = s;
                                });
                            } else if (typeof obj === 'object' && obj !== null) {
                                Object.values(obj).forEach(val => {
                                    const s = findLongestString(val);
                                    if (s.length > longest.length) longest = s;
                                });
                            }
                            return longest;
                        };

                        const candidate = findLongestString(parsed);
                        if (candidate.length > bestText.length) {
                            bestText = candidate;
                        }
                    } catch (e) {
                        // Not valid JSON array, skip
                    }
                }
            }
        }

        if (bestText.length > 0) {
            text = bestText;
        }

        // Gemini completion indicators
        if (rawDataString.includes("xsrf_token") || rawDataString.includes("finish_reason")) {
            // isFinalResponse = true;
        }
    } catch (e) {
        console.warn(`[${this.name}] Error parsing debugger response:`, e);
    }

    return { text, isFinalResponse };
  }

  getStreamingApiPatterns() {
    return [
      { urlPattern: "*://gemini.google.com/_/BardChatUi/data/assistant.v1.BardAssistant/StreamGenerate*", requestStage: "Response" },
      { urlPattern: "*://gemini.google.com/app/v1/chat*", requestStage: "Response" }
    ];
  }

  stopStreaming(requestId) {
    console.log(`[${this.name}] stopStreaming called for ${requestId}`);
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (callback) {
      const acc = this.requestAccumulators.get(requestId);
      callback(requestId, (acc ? acc.text : "") + "[STREAM_STOPPED_BY_USER]", true);
    }
    this.pendingResponseCallbacks.delete(requestId);
    this.requestAccumulators.delete(requestId);
    this._stopDOMMonitoring();
  }

  findResponseElement(container) {
    return container.querySelector ? container.querySelector(this.responseSelector) : null;
  }

  shouldSkipResponseMonitoring() {
    return false; // We WANT DOM monitoring
  }
}

// Robust registration
(function register() {
    if (window.providerUtils) {
        console.log("GeminiProvider: Registering...");
        const providerInstance = new GeminiProvider();
        window.providerUtils.registerProvider(providerInstance.name, providerInstance.supportedDomains, providerInstance);
        console.log("GeminiProvider: Registered successfully.");
    } else {
        console.log("GeminiProvider: Waiting for providerUtils...");
        setTimeout(register, 500);
    }
})();