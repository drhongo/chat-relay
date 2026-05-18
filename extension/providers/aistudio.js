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
// AI Chat Relay - AI Studio Provider

class AIStudioProvider {
  constructor() {
    // --- START OF CONFIGURABLE PROPERTIES ---
    // Method for response capture: "debugger" or "dom"
    this.captureMethod = "debugger";
    // URL pattern for debugger to intercept if captureMethod is "debugger". Ensure this is specific.
    this.debuggerUrlPattern = "*MakerSuiteService/GenerateContent*";
    // Whether to include "thinking" process in the message or just the final answer.
    this.includeThinkingInMessage = false;

    // Option to enable AI Studio function calling on load
    this.ENABLE_AISTUDIO_FUNCTION_CALLING = true;
    // --- END OF CONFIGURABLE PROPERTIES ---

    this.name = "AIStudioProvider";
    this.supportedDomains = ["aistudio.google.com"];
    
    // Selectors for the AI Studio interface
    this.inputSelector = 'textarea.textarea, textarea.gmat-body-medium, textarea[aria-label="Type something or pick one from prompt gallery"]';
    
    // The send button selector
    this.sendButtonSelector = 'button.run-button, button[aria-label="Run"], button.mat-mdc-tooltip-trigger.run-button';
    
    // Updated response selectors based on the actual elements
    this.responseSelector = '.response-container, .response-text, .model-response, .model-response-container, ms-chat-turn, ms-prompt-chunk, ms-text-chunk, .very-large-text-container, .cmark-node';
    
    // Thinking indicator selector
    this.thinkingIndicatorSelector = '.thinking-indicator, .loading-indicator, .typing-indicator, .response-loading, loading-indicator';

    // Fallback selectors
    this.responseSelectorForDOMFallback = '.response-container, .model-response-text';
    this.thinkingIndicatorSelectorForDOM = '.thinking-indicator, .spinner';
    
    this.lastSentMessage = '';
    this.pendingResponseCallbacks = new Map();
    this.requestAccumulators = new Map();
    this._currentExpectedIndex = null;
    this.domMonitorTimer = null;
    this._lastInterceptedClipboardText = null;

    // Call the method to ensure function calling is enabled on initial load
    this.ensureFunctionCallingEnabled();

    // Listen for SPA navigation events to re-trigger the check
    if (window.navigation) {
      window.navigation.addEventListener('navigate', (event) => {
        if (!event.canIntercept || event.hashChange || event.downloadRequest !== null) {
          return;
        }
        const currentUrl = new URL(window.location.href);
        const destinationUrl = new URL(event.destination.url);

        if (currentUrl.origin === destinationUrl.origin && destinationUrl.pathname.startsWith("/prompts/")) {
          console.log(`[${this.name}] Detected SPA navigation to: ${event.destination.url}. Re-checking function calling toggle.`);
          setTimeout(() => {
            this.ensureFunctionCallingEnabled();
          }, 1000);
        }
      });
    } else {
      console.warn(`[${this.name}] window.navigation API not available. Function calling toggle may not re-enable on SPA navigations.`);
    }

    this._injectClipboardProxy();
  }

  _injectClipboardProxy() {
      window.addEventListener('message', (e) => {
          if (e.data && e.data.type === 'RELAY_CLIPBOARD_CAPTURE') {
              this._lastInterceptedClipboardText = e.data.detail;
              console.log(`[${this.name}] Received intercepted text from proxy message event.`);
          }
      });
  }

  // Find deep matching elements (shadow-piercing helper)
  _findDeep(root, selector) {
    const results = [];
    const search = (node) => {
      if (!node) return;
      if (node.matches && node.matches(selector)) {
        results.push(node);
      }
      if (node.querySelectorAll) {
        const direct = node.querySelectorAll(selector);
        for (const el of direct) {
          if (!results.includes(el)) {
            results.push(el);
          }
        }
      }
      if (node.shadowRoot) {
        search(node.shadowRoot);
      }
      let child = node.firstElementChild;
      while (child) {
        search(child);
        child = child.nextElementSibling;
      }
    };
    search(root);
    return results;
  }

  ensureFunctionCallingEnabled() {
    if (!this.ENABLE_AISTUDIO_FUNCTION_CALLING) {
      console.log(`[${this.name}] Function calling is disabled by configuration. Skipping.`);
      return;
    }

    const checkInterval = 500;
    const maxDuration = 7000;
    let elapsedTime = 0;
    const providerName = this.name;

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
        this.functionCallingPollTimer = null;
      } else {
        elapsedTime += checkInterval;
        if (elapsedTime < maxDuration) {
          console.log(`[${providerName}] Function calling toggle not found, will retry in ${checkInterval}ms.`);
          this.functionCallingPollTimer = setTimeout(tryEnableFunctionCalling, checkInterval);
        } else {
          console.warn(`[${providerName}] Function calling toggle button (selector: 'button[aria-label="Function calling"]') not found after ${maxDuration}ms. It might not be available on this page/view or selector is incorrect.`);
          this.functionCallingPollTimer = null;
        }
      }
    };

    this.functionCallingPollTimer = setTimeout(tryEnableFunctionCalling, 500);
  }

  // Send a message to the chat interface
  async sendChatMessage(messageContent, messageOrId) {
    const requestId = typeof messageOrId === 'object' ? messageOrId.requestId : messageOrId;
    console.log(`[${this.name}] sendChatMessage called for requestId ${requestId}`);

    // Handle New Chat request
    if (typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat) {
        console.log(`[${this.name}] New Chat requested. Clicking New Chat button.`);
        const newChatButton = document.querySelector('a[href="/prompts/new"], button[aria-label="New prompt"]');
        if (newChatButton) {
            newChatButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

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
      this._currentExpectedIndex = null;
      let expectedIndex = 0;
      const isNewChat = typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat;
      if (!isNewChat) {
          const existingHosts = this._findDeep(document, this.responseSelector);
          expectedIndex = existingHosts.length;
      }
      this._currentExpectedIndex = expectedIndex;
      console.log(`[${this.name}] Calculated expectedIndex: ${expectedIndex}`);

      let textToInput = "";
      let blobToPaste = null;
      let blobMimeType = "image/png";

      if (typeof messageContent === 'string') {
        textToInput = messageContent;
        this.lastSentMessage = textToInput;
      } else if (messageContent instanceof Blob) {
        blobToPaste = messageContent;
        blobMimeType = messageContent.type || blobMimeType;
        this.lastSentMessage = `Blob data (type: ${blobMimeType}, size: ${blobToPaste.size})`;
      } else if (Array.isArray(messageContent)) {
        for (const part of messageContent) {
          if (part.type === "text" && typeof part.text === 'string') {
            textToInput += (textToInput ? "\n" : "") + part.text;
          } else if (part.type === "image_url" && part.image_url && typeof part.image_url.url === 'string') {
            if (!blobToPaste) {
              try {
                const response = await fetch(part.image_url.url);
                blobToPaste = await response.blob();
                blobMimeType = blobToPaste.type || blobMimeType;
              } catch (e) {
                console.error(`[${this.name}] Error fetching image_url:`, e);
              }
            }
          }
        }
        this.lastSentMessage = `Array content (Text: "${textToInput.substring(0,50)}...", Image: ${blobToPaste ? 'Yes' : 'No'})`;
      }

      // Insert Text into Input Field
      if (textToInput) {
        inputField.focus();
        await new Promise(resolve => setTimeout(resolve, 200));

        let insertSucceeded = false;
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', textToInput);
          inputField.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          await new Promise(resolve => setTimeout(resolve, 200));
          const afterPaste = (inputField.value || inputField.innerText || inputField.textContent || "").trim();
          if (afterPaste.length > 0) {
            insertSucceeded = true;
          }
        } catch (e) {
          console.warn(`[${this.name}] Paste failed: ${e.message}`);
        }

        if (!insertSucceeded) {
          if (inputField.tagName.toLowerCase() === 'div' && inputField.isContentEditable) {
            inputField.innerHTML = '';
            inputField.textContent = textToInput;
          } else {
            // Safe React/Angular value setter fallback
            try {
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype,
                'value'
              ).set;
              nativeSetter.call(inputField, textToInput);
            } catch (e) {
              inputField.value = textToInput;
            }
          }
        }

        // Trigger multiple events to satisfy state binders
        const events = ['input', 'change', 'keyup', 'keydown'];
        events.forEach(type => {
          inputField.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        });
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
      }
      
      inputField.focus();
      await new Promise(resolve => setTimeout(resolve, 100));

      let attempts = 0;
      const maxAttempts = 60;
      const retryDelay = 5000;

      while (attempts < maxAttempts) {
        const isDisabled = sendButton.disabled ||
                           sendButton.getAttribute('aria-disabled') === 'true' ||
                           sendButton.classList.contains('disabled');

        if (!isDisabled) {
          console.log(`[${this.name}] Send button is enabled. Clicking send button (attempt ${attempts + 1}).`);
          
          // Human-like click events sequence
          const rect = sendButton.getBoundingClientRect();
          const clientX = rect.left + rect.width / 2;
          const clientY = rect.top + rect.height / 2;

          sendButton.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', clientX, clientY }));
          sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY }));
          sendButton.focus();
          sendButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse', clientX, clientY }));
          sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX, clientY }));
          sendButton.click();

          // Enter key fallback sequence
          inputField.blur();
          setTimeout(() => {
            inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            inputField.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
          }, 100);

          return true;
        }

        attempts++;
        if (attempts >= maxAttempts) {
          console.error(`[${this.name}] Send button remained disabled. Failed to send message.`);
          return false;
        }

        console.log(`[${this.name}] Send button is disabled (attempt ${attempts}). Retrying in ${retryDelay}ms.`);
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        inputField.dispatchEvent(new Event('change', { bubbles: true }));
        inputField.dispatchEvent(new Event('blur', { bubbles: true }));
        inputField.focus();
        await new Promise(resolve => setTimeout(resolve, 50));
        inputField.blur();
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
      return false;
    } catch (error) {
      console.error(`[${this.name}] Error sending message:`, error);
      return false;
    }
  }

  initiateResponseCapture(requestId, responseCallback) {
    console.log(`[${this.name}] initiateResponseCapture called for requestId: ${requestId}. Method: ${this.captureMethod}`);
    if (this.captureMethod === "debugger") {
      this.pendingResponseCallbacks.set(requestId, responseCallback);
    } else if (this.captureMethod === "dom") {
      this.pendingResponseCallbacks.set(requestId, responseCallback);
      this._stopDOMMonitoring(); 
      this._startDOMMonitoring(requestId); 
    } else {
      console.error(`[${this.name}] Unknown capture method: ${this.captureMethod}`);
      responseCallback(requestId, `[Error: Unknown capture method '${this.captureMethod}' in provider]`, true); 
      this.pendingResponseCallbacks.delete(requestId); 
    }
  }

  handleDebuggerData(requestId, rawData, isFinalFromBackground) {
    console.log(`[${this.name}] handleDebuggerData called for requestId: ${requestId}. isFinalFromBackground: ${isFinalFromBackground}`);
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) return;

    let parsedText = "";
    let contentHasInternalFinalMarker = false;

    if (rawData && rawData.trim() !== "") {
        const parseOutput = this.parseDebuggerResponse(rawData);
        parsedText = parseOutput.text;
        contentHasInternalFinalMarker = parseOutput.isFinalResponse;
    }
    
    const isFinalForCallback = isFinalFromBackground || contentHasInternalFinalMarker;

    // Memory-safe, robust accumulation of streaming debugger chunks
    let finalOutputText = "";
    if (isFinalFromBackground) {
      // Final body captured from background Network.getResponseBody
      finalOutputText = parsedText;
      this.requestAccumulators.delete(requestId);
    } else {
      // Real-time chunk from eventSourceMessageReceived, accumulate it
      const existing = this.requestAccumulators.get(requestId) || "";
      const updated = existing + parsedText;
      this.requestAccumulators.set(requestId, updated);
      finalOutputText = updated;
    }

    if (finalOutputText || isFinalForCallback) {
      callback(requestId, finalOutputText, isFinalForCallback);
    }
    
    if (isFinalForCallback) {
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
    }
  }

  // --- DOM Capture Logic ---
  _captureResponseDOM(element = null) { 
    if (!element) {
      if (this._currentExpectedIndex !== null && this._currentExpectedIndex !== undefined) {
          const hosts = this._findDeep(document, this.responseSelector);
          if (hosts.length <= this._currentExpectedIndex) {
              return { found: false, text: "" };
          }
          element = hosts[this._currentExpectedIndex];
      }

      if (!element) {
        const candidates = this._findDeep(document, this.responseSelector);
        if (candidates.length > 0) {
          element = candidates[candidates.length - 1];
        }
      }
    }

    if (!element) {
      return { found: false, text: '' }; 
    }

    if (this._isResponseStillGeneratingDOM()) { 
      return { found: false, text: '' }; 
    }

    let responseText = this._htmlToMarkdown(element);
    responseText = this._cleanResponse(responseText);

    if (this.lastSentMessage && responseText.trim().startsWith(this.lastSentMessage.trim())) {
      responseText = responseText.substring(this.lastSentMessage.length).trim();
    }

    return { 
      found: responseText.length > 0,
      text: responseText
    };
  }

  _htmlToMarkdown(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);

    const process = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      let prefix = "";
      let suffix = "";
      const tagName = node.tagName.toLowerCase();

      switch (tagName) {
        case 'p': suffix = "\n\n"; break;
        case 'br': suffix = "\n"; break;
        case 'strong': case 'b': prefix = "**"; suffix = "**"; break;
        case 'em': case 'i': prefix = "*"; suffix = "*"; break;
        case 'code':
          if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
            prefix = "```\n"; suffix = "\n```\n";
          } else {
            prefix = "`"; suffix = "`";
          }
          break;
        case 'h1': prefix = "# "; suffix = "\n\n"; break;
        case 'h2': prefix = "## "; suffix = "\n\n"; break;
        case 'h3': prefix = "### "; suffix = "\n\n"; break;
        case 'li': prefix = "- "; suffix = "\n"; break;
        case 'ul': case 'ol': suffix = "\n"; break;
        case 'blockquote': prefix = "> "; suffix = "\n\n"; break;
      }

      let content = "";
      for (const child of node.childNodes) {
        content += process(child);
      }

      return prefix + content + suffix;
    };

    return process(clone).trim().replace(/\n{3,}/g, '\n\n').trim();
  }

  _cleanResponse(text) {
    if (!text) return "";
    return text.trim()
      .replace(/^(Loading|Thinking).*/gim, '')
      .replace(/Expand to view model thoughts.*/gim, '')
      .trim();
  }

  // --- START OF CORRECTED DEBUGGER PARSING LOGIC ---
  parseDebuggerResponse(rawString) {
    if (!rawString || rawString.trim() === "") {
        return { text: "", isFinalResponse: false }; 
    }

    const textRaw = typeof rawString === 'string' ? rawString : JSON.stringify(rawString);

    let thinkingAndProcessText = "";
    let actualResponseText = "";
    let overallMarkerFound = false; 

    function findEndOfUnitMarker(data) {
        if (Array.isArray(data)) {
            if (data.length >= 2 && data[data.length - 1] === 1 && data[data.length - 2] === "model") {
                return true;
            }
            for (const item of data) {
                if (findEndOfUnitMarker(item)) { 
                    return true;
                }
            }
        }
        return false;
    }

    function extractTextSegments(data, segments = []) {
        if (Array.isArray(data)) {
            if (data.length > 1 && data[0] === null && typeof data[1] === 'string') {
                segments.push(data[1]);
            } else {
                for (const item of data) {
                    extractTextSegments(item, segments); 
                }
            }
        }
        return segments;
    }

    try {
        const parsedJson = JSON.parse(textRaw);
        if (Array.isArray(parsedJson)) {
            for (let i = 0; i < parsedJson.length; i++) {
                const chunk = parsedJson[i];
                const textSegmentsInChunk = extractTextSegments(chunk);
                if (textSegmentsInChunk.length > 0) {
                    actualResponseText += textSegmentsInChunk.join("");
                }
                if (findEndOfUnitMarker(chunk)) {
                    overallMarkerFound = true;
                }
                if (this.includeThinkingInMessage) {
                    if (Array.isArray(chunk) && chunk[0] && Array.isArray(chunk[0][0]) && chunk[0][0][2]) {
                        const potentialThinkingBlock = chunk[0][0][2];
                        const thinkingSegments = extractTextSegments(potentialThinkingBlock);
                        const thinkingBlockText = thinkingSegments.join("").trim();
                        if (thinkingBlockText && !actualResponseText.includes(thinkingBlockText)) {
                            thinkingAndProcessText += thinkingBlockText + "\n";
                        }
                    }
                }
            }
        } else {
            if (typeof parsedJson === 'string') {
                actualResponseText = parsedJson;
                overallMarkerFound = true; 
            } else {
                const genericText = extractTextSegments(parsedJson).join("");
                if (genericText) {
                    actualResponseText = genericText;
                    overallMarkerFound = true; 
                } else {
                     actualResponseText = "[Unexpected JSON structure]";
                     overallMarkerFound = true; 
                }
            }
        }
        
        actualResponseText = actualResponseText.replace(/\\n/g, "\n").replace(/\n\s*\n/g, '\n').trim();
        thinkingAndProcessText = thinkingAndProcessText.replace(/\\n/g, "\n").replace(/\n\s*\n/g, '\n').trim();

    } catch (e) {
        const formattedFallback = this.formatOutput("", textRaw); 
        return { text: formattedFallback, isFinalResponse: true }; 
    }
    
    const formattedOutput = this.formatOutput(thinkingAndProcessText, actualResponseText);
    if (formattedOutput.trim() === "" && overallMarkerFound) {
        return { text: "", isFinalResponse: true };
    }
    return { text: formattedOutput, isFinalResponse: overallMarkerFound };
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
            return (answerText || "").trim();
        }
    }
    return (answerText || "").trim(); 
  }
  
  _findResponseElementDOM(container) {
    if (!container) return null;

    const elements = container.querySelectorAll(this.responseSelectorForDOMFallback);
    if (elements.length > 0) {
      const lastElement = elements[elements.length - 1];
      if (lastElement.textContent && lastElement.textContent.trim() !== this.lastSentMessage) {
        return lastElement;
      }
    }
    return null;
  }

  shouldSkipResponseMonitoring() {
    return this.captureMethod === "debugger";
  }

  _isResponseStillGeneratingDOM() {
    const thinkingIndicator = document.querySelector(this.thinkingIndicatorSelectorForDOM);
    return !!thinkingIndicator;
  }

  getStreamingApiPatterns() {
    if (this.captureMethod === "debugger" && this.debuggerUrlPattern) {
      return [{ urlPattern: this.debuggerUrlPattern, requestStage: "Response" }];
    }
    return [];
  }

  _startDOMMonitoring(requestId) {
    console.log(`[${this.name}] DOM Fallback: _startDOMMonitoring for requestId: ${requestId}`);
    this._stopDOMMonitoring();

    const callback = this.pendingResponseCallbacks.get(requestId);
    if (!callback) return;

    let attempts = 0;
    const maxAttempts = 15;
    const interval = 1000;

    this.domMonitorTimer = setInterval(() => {
      const responseData = this._captureResponseDOM();

      if (responseData.found && responseData.text.trim() !== "") {
        this._stopDOMMonitoring();
        callback(requestId, responseData.text, true);
        this.pendingResponseCallbacks.delete(requestId);
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          this._stopDOMMonitoring();
          callback(requestId, "[Error: Timed out waiting for DOM response]", true);
          this.pendingResponseCallbacks.delete(requestId);
        }
      }
    }, interval);
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
      clearInterval(this.domMonitorTimer);
      this.domMonitorTimer = null;
    }
  }
}

// Robust registration
(function register() {
  if (window.providerUtils) {
    console.log("AIStudioProvider: Registering...");
    const providerInstance = new AIStudioProvider();
    window.providerUtils.registerProvider(providerInstance.name, providerInstance.supportedDomains, providerInstance);
    console.log("AIStudioProvider: Registered successfully.");
  } else {
    console.log("AIStudioProvider: Waiting for providerUtils...");
    setTimeout(register, 500);
  }
})();
