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
// AI Chat Relay - Kimi K2 Provider

class KimiK2Provider {
  constructor() {
    this.name = 'KimiK2Provider';
    this.supportedDomains = ['k2.kimi.ai'];

    // --- START OF CONFIGURABLE PROPERTIES ---
    this.captureMethod = 'dom'; // DOM capture by default
    this.debuggerUrlPattern = '*k2.kimi.ai/api/chat*';
    this.includeThinkingInMessage = false;
    // --- END OF CONFIGURABLE PROPERTIES ---

    this.inputSelector = 'textarea, div[contenteditable="true"], [role="textbox"]';
    this.sendButtonSelector = 'button[type="submit"], button.send-btn, button[class*="send"], button:has(svg)';
    this.responseSelector = '.message.ai, .chat-message.ai, .ai-message, [data-testid="assistant-message"]';
    this.thinkingIndicatorSelector = '.typing, .loading, [class*="typing"], [class*="loading"], .thinking-indicator';
    this.newChatSelector = 'button.new-chat, a[href="/"], button:has(svg[class*="new-chat"])';

    this.lastSentMessage = '';
    this.pendingResponseCallbacks = new Map();
    this.requestAccumulators = new Map();
    this._currentExpectedIndex = null;
    this.domMonitorTimer = null;
    this._lastInterceptedClipboardText = null;

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

  // Send a message to the chat interface
  async sendChatMessage(messageContent, messageOrId) {
    const requestId = typeof messageOrId === 'object' ? messageOrId.requestId : messageOrId;
    console.log(`[${this.name}] sendChatMessage called for requestId ${requestId}`);

    // Handle New Chat request
    if (typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat) {
      console.log(`[${this.name}] New Chat requested. Attempting to clear thread.`);
      const newChatButtons = this._findDeep(document, this.newChatSelector);
      if (newChatButtons.length > 0) {
        console.log(`[${this.name}] Found New Chat button, clicking...`);
        newChatButtons[0].click();
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else {
        console.log(`[${this.name}] New Chat button not found, navigating home...`);
        window.location.href = "https://k2.kimi.ai/";
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
    }

    // Polling for Input Field using shadow-piercing search
    let inputField = null;
    let pollAttempts = 0;
    const maxPollAttempts = 15;

    while (pollAttempts < maxPollAttempts) {
      const inputFields = this._findDeep(document, this.inputSelector);
      if (inputFields.length > 0) {
        inputField = inputFields[0];
        console.log(`[${this.name}] Input field found after ${pollAttempts + 1} attempts.`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      pollAttempts++;
    }

    if (!inputField) {
      console.error(`[${this.name}] Missing input field. Selector: ${this.inputSelector}`);
      this._reportSendError(requestId, "Input field not found after polling.");
      return false;
    }

    try {
      this.lastSentMessage = "";

      let expectedIndex = 0;
      const isNewChat = typeof messageOrId === 'object' && messageOrId.settings && messageOrId.settings.new_chat;
      if (!isNewChat) {
          const existingHosts = this._findDeep(document, this.responseSelector);
          expectedIndex = existingHosts.length;
      }
      this._currentExpectedIndex = expectedIndex;
      console.log(`[${this.name}] Calculated expectedIndex: ${expectedIndex}`);

      let textToInput = "";
      if (typeof messageContent === 'string') {
        textToInput = messageContent;
        this.lastSentMessage = textToInput;
      } else if (Array.isArray(messageContent)) {
        for (const part of messageContent) {
          if (part.type === "text" && typeof part.text === 'string') {
            textToInput += (textToInput ? "\n" : "") + part.text;
          }
        }
        this.lastSentMessage = textToInput || "Array content";
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
          if (inputField.tagName.toLowerCase() === 'div' && inputField.contentEditable === 'true') {
            inputField.innerHTML = '';
            inputField.textContent = textToInput;
          } else {
            inputField.value = textToInput;
          }
          inputField.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      // Click Send Button
      const sendButtons = this._findDeep(document, this.sendButtonSelector);
      if (sendButtons.length === 0) {
        console.error(`[${this.name}] Missing send button.`);
        this._reportSendError(requestId, "Send button not found.");
        return false;
      }

      const sendButton = sendButtons[0];
      const isButtonDisabled = sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true' || sendButton.classList.contains('disabled');
      if (isButtonDisabled) {
        console.warn(`[${this.name}] Send button is disabled, clicking anyway.`);
      }

      sendButton.click();
      return true;
    } catch (error) {
      console.error(`[${this.name}] Error sending chat message:`, error);
      this._reportSendError(requestId, error.message);
      return false;
    }
  }

  _reportSendError(requestId, errorMsg) {
    chrome.runtime.sendMessage({
      type: "CHAT_RELAY_SEND_ERROR",
      requestId: requestId,
      error: errorMsg
    });
  }

  initiateResponseCapture(requestId, callback) {
    this.pendingResponseCallbacks.set(requestId, callback);
    if (this.captureMethod === 'dom') {
      this._startDOMMonitoring(requestId);
    }
  }

  stopStreaming(requestId) {
    const callback = this.pendingResponseCallbacks.get(requestId);
    if (callback) {
      this.pendingResponseCallbacks.delete(requestId);
      this.requestAccumulators.delete(requestId);
      this._stopDOMMonitoring();
    }
  }

  async _startDOMMonitoring(requestId) {
    console.log(`[${this.name}] Starting DOM monitoring for requestId: ${requestId}`);
    this._stopDOMMonitoring();

    let lastCapturedText = "";
    let noChangeCount = 0;
    let totalChecks = 0;
    let generationStarted = false;

    await new Promise(resolve => setTimeout(resolve, 500));

    const monitor = async () => {
      const callback = this.pendingResponseCallbacks.get(requestId);
      if (!callback) {
        this._stopDOMMonitoring();
        return;
      }

      totalChecks++;

      const isGenerating = this._isGenerating();
      if (isGenerating) generationStarted = true;

      const result = this._captureResponseDOM();
      if (result.found) {
        if (result.text !== lastCapturedText) {
          lastCapturedText = result.text;
          noChangeCount = 0;
        } else {
          noChangeCount++;
        }
      }

      const stoppedGenerating = generationStarted && !isGenerating && lastCapturedText.length > 0 && noChangeCount >= 2;
      const fastResponse = !generationStarted && lastCapturedText.length > 0 && noChangeCount >= 4 && totalChecks >= 6;
      const stableTextFallback = lastCapturedText.length > 0 && noChangeCount >= 4;
      const noChangeTimeout = lastCapturedText.length > 0 && noChangeCount >= 10;
      const hardTimeout = totalChecks >= 240; // 60 seconds
      const shouldFinalize = stoppedGenerating || fastResponse || stableTextFallback || noChangeTimeout || hardTimeout;

      if (shouldFinalize) {
        const reason = stoppedGenerating ? 'generating_stopped' : fastResponse ? 'fast_response' : noChangeTimeout ? 'no_change_timeout' : 'hard_timeout';
        console.log(`[${this.name}] DOM monitoring finishing for ${requestId}. Reason: ${reason}. Finalizing...`);
        
        // Use copy button fallback if available
        const perfectText = await this._captureFromCopyButton();
        if (perfectText) {
            lastCapturedText = perfectText;
        }

        if (lastCapturedText && lastCapturedText.length > 0) {
          callback(requestId, this._cleanResponse(lastCapturedText), true);
        } else {
          callback(requestId, "[Empty response captured]", true);
        }
        this.pendingResponseCallbacks.delete(requestId);
        this._stopDOMMonitoring();
      } else {
        this.domMonitorTimer = setTimeout(monitor, 250);
      }
    };

    monitor();
  }

  _stopDOMMonitoring() {
    if (this.domMonitorTimer) {
      clearTimeout(this.domMonitorTimer);
      this.domMonitorTimer = null;
    }
  }

  _isGenerating() {
    // Secondary check: look for typing indicator
    const thinkingIndicators = document.querySelectorAll(this.thinkingIndicatorSelector);
    if (thinkingIndicators.length > 0) return true;

    // Check if send button is disabled (often means generating)
    const sendButtons = document.querySelectorAll(this.sendButtonSelector);
    if (sendButtons.length > 0) {
      const sendButton = sendButtons[0];
      const isButtonDisabled = sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true' || sendButton.classList.contains('disabled');
      if (isButtonDisabled) return true;
    }
    return false;
  }

  _captureResponseDOM(element = null) {
    if (!element) {
      if (this._currentExpectedIndex !== null && this._currentExpectedIndex !== undefined) {
          const hosts = this._findDeep(document, this.responseSelector);
          if (hosts.length <= this._currentExpectedIndex) {
              return { found: false, text: "", isStillGenerating: true };
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
      return { found: false, text: '', isStillGenerating: this._isGenerating() };
    }

    let responseText = this._htmlToMarkdown(element);
    responseText = this._cleanResponse(responseText);

    if (this.lastSentMessage && responseText.trim().startsWith(this.lastSentMessage.trim())) {
      responseText = responseText.substring(this.lastSentMessage.length).trim();
    }

    const isStillGenerating = this._isGenerating();
    return { found: responseText.length > 0, text: responseText, isStillGenerating };
  }

  async _captureFromCopyButton() {
    console.log(`[${this.name}] Attempting to capture from Copy button...`);
    return new Promise(async (resolve) => {
        let capturedText = null;
        const onCopy = (e) => {
            const text = e.clipboardData.getData('text/plain');
            if (text && text.trim().length > 0) {
                capturedText = text.trim();
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        };

        try {
            document.addEventListener('copy', onCopy, true);

            // Find all potential copy buttons inside the target message turn
            let container = document;
            if (this._currentExpectedIndex !== null) {
                const hosts = this._findDeep(document, this.responseSelector);
                if (hosts.length > this._currentExpectedIndex) {
                    container = hosts[this._currentExpectedIndex];
                }
            }

            const copyButtons = this._findDeep(container, 'button:has(svg[class*="copy"]), button.copy-btn, [class*="copy"] button, button[aria-label*="Copy" i], button[title*="Copy" i]');
            if (copyButtons.length > 0) {
                const lastBtn = copyButtons[copyButtons.length - 1];
                lastBtn.click();
            }

            let waitTime = 0;
            const checkInterval = 50;
            const maxWait = 1500;
            
            const waitLoop = setInterval(() => {
                waitTime += checkInterval;
                const foundText = capturedText || this._lastInterceptedClipboardText;
                if (foundText || waitTime >= maxWait) {
                    clearInterval(waitLoop);
                    document.removeEventListener('copy', onCopy, true);
                    resolve(foundText || null);
                }
            }, checkInterval);

        } catch (err) {
            document.removeEventListener('copy', onCopy, true);
            resolve(null);
        }
    });
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
    return text.trim();
  }

  handleDebuggerData(requestId, rawData, isFinal) {
    const cb = this.pendingResponseCallbacks.get(requestId);
    if (!cb) return;

    const parsed = this.parseDebuggerResponse(rawData);
    if (parsed.text || isFinal) {
      cb(requestId, parsed.text, isFinal);
    }
    if (isFinal) {
      this.pendingResponseCallbacks.delete(requestId);
    }
  }

  parseDebuggerResponse(raw) {
    if (!raw) return { text: '', isFinalResponse: false };
    if (raw.includes('[DONE]')) {
      const clean = raw.replace('[DONE]', '').trim();
      return { text: clean, isFinalResponse: true };
    }
    return { text: raw.trim(), isFinalResponse: false };
  }

  getStreamingApiPatterns() {
    if (this.captureMethod === 'debugger' && this.debuggerUrlPattern) {
      return [{ urlPattern: this.debuggerUrlPattern, requestStage: 'Response' }];
    }
    return [];
  }

  shouldSkipResponseMonitoring() {
    return this.captureMethod === 'debugger';
  }
}

// Robust registration
(function register() {
  if (window.providerUtils) {
    console.log("KimiK2Provider: Registering...");
    const providerInstance = new KimiK2Provider();
    window.providerUtils.registerProvider(providerInstance.name, providerInstance.supportedDomains, providerInstance);
    console.log("KimiK2Provider: Registered successfully.");
  } else {
    console.log("KimiK2Provider: Waiting for providerUtils...");
    setTimeout(register, 500);
  }
})();
