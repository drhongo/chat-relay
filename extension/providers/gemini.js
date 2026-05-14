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
    this.captureMethod = "dom"; 
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
    this.domFallbackTimeout = 8000;
    this.domFallbackTimer = null;
    this.domMonitorTimer = null;
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
          if (window.location.pathname !== "/app") {
            console.log(`[${this.name}] New Chat requested. Clicking New Chat button.`);
            const newChatButton = document.querySelector(this.newChatSelector);
            if (newChatButton) {
                newChatButton.click();
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
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
        } else if (currentText && currentText === lastCapturedText && currentText !== "") {
            noChangeStreak++;
        }
        
        if (!isStillGenerating && noChangeStreak >= 3 && lastCapturedText.trim() !== "") {
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
    console.log(`[${this.name}] Primary search found ${responseElements.length} elements.`);

    if (responseElements.length === 0) {
        responseElements = findDeep(document, 'message-content, .model-response-text, .markdown, .response-container');
        console.log(`[${this.name}] Fallback search found ${responseElements.length} elements.`);
    }
    
    // Final desperate search
    if (responseElements.length === 0) {
        responseElements = findDeep(document, 'div').filter(el => {
            const text = el.innerText || "";
            return text.length > 50 && !el.querySelector('textarea') && !el.closest('sidebar, .sidebar');
        });
        console.log(`[${this.name}] Desperate search found ${responseElements.length} elements.`);
    }

    const lastResponse = responseElements[responseElements.length - 1];
    const text = lastResponse ? (lastResponse.innerText || lastResponse.textContent || "").trim() : "";
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

  initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}`);
    this.pendingResponseCallbacks.set(requestId, responseCallback);
    this._startDOMMonitoring(requestId);
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground) {
    // Standard interface but Gemini uses DOM capture primarily now
    this._startDOMMonitoring(requestId);
  }

  parseDebuggerResponse(rawDataString) {
    return { text: "", isFinalResponse: false };
  }

  getStreamingApiPatterns() {
    return [];
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